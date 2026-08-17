import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-canvas-adapters-"));
const claudeHome = path.join(root, "claude-home");
const kimiHome = path.join(root, "kimi-home");
const repo = path.join(root, "repo");
const unrelated = path.join(root, "unrelated");
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(unrelated, { recursive: true });
fs.mkdirSync(path.join(claudeHome, "projects", "fixture"), { recursive: true });
fs.mkdirSync(kimiHome, { recursive: true });

process.env.REPO_CANVAS_ROOT = repo;
process.env.REPO_CANVAS_DATA_DIR = path.join(root, "data");
process.env.REPO_CANVAS_CLAUDE_HOME = claudeHome;
process.env.REPO_CANVAS_KIMI_HOME = kimiHome;

const store = await import("../repo-canvas/scripts/canvas-store.mjs");
const claude = await import("../repo-canvas/scripts/claude-sessions.mjs");
const kimi = await import("../repo-canvas/scripts/kimi-sessions.mjs");
const { SessionObserver } = await import("../repo-canvas/scripts/observer.mjs");
const { claudeSessionAdapter } = claude;
const { kimiSessionAdapter } = kimi;

function jsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function decision(title, target, status = "done") {
  return {
    profile: { model: "fixture", effort: "low" },
    value: {
      workTitle: title, workSummary: `${title} summary`, workStatus: status,
      targetEntityIds: [target], entityChanges: [], relationChanges: [],
    },
  };
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("Claude adapter exposes public messages and tools but ignores thinking", () => {
  const signals = claude.claudeSessionSignals({
    type: "assistant", timestamp: "2026-08-13T00:00:01Z",
    message: { stop_reason: "end_turn", content: [
      { type: "thinking", thinking: "private" },
      { type: "text", text: "Public update" },
      { type: "tool_use", name: "Edit", input: { file_path: "src/a.js" } },
    ] },
  });
  assert.deepEqual(signals.map((item) => item.kind), ["agent", "tool", "complete"]);
  assert.ok(!JSON.stringify(signals).includes("private"));
  assert.equal(claude.claudeSessionLocator({ id: "claude-1", cwd: repo }).kind, "claude-cli");
});

test("Kimi adapter exposes public text and tools but ignores think and results", () => {
  const publicSignals = kimi.kimiSessionSignals({
    type: "context.append_loop_event", time: 1,
    event: { type: "content.part", part: { type: "text", text: "Public update" } },
  });
  const privateSignals = kimi.kimiSessionSignals({
    type: "context.append_loop_event", time: 2,
    event: { type: "content.part", part: { type: "think", text: "private" } },
  });
  const resultSignals = kimi.kimiSessionSignals({ type: "context.append_loop_event", event: { type: "tool.result", result: "secret" } });
  assert.equal(publicSignals[0].kind, "agent");
  assert.deepEqual(privateSignals, []);
  assert.deepEqual(resultSignals, []);
  assert.equal(kimi.kimiSessionSignals({ type: "context.append_loop_event", event: { type: "step.end", finishReason: "end_turn", turnId: 2 } })[0].kind, "complete");
  assert.equal(kimi.kimiSessionLocator({ id: "session_1", cwd: repo }).kind, "kimi-cli");
});

test("one observer tracks Claude and Kimi sessions only for the selected repository", async () => {
  store.appendEvent(store.createEvent("area.upsert", { actor: "test", payload: { id: "core", title: "Core", note: "", order: 1 } }));
  for (const id of ["claude-module", "kimi-module"]) {
    store.appendEvent(store.createEvent("entity.upsert", { actor: "test", payload: {
      id, areaId: "core", label: id, status: "operational", path: `src/${id}`,
      purpose: "Fixture", note: "", inputs: [], outputs: [], dependsOn: [], order: 1,
    } }));
  }

  const claudeFile = path.join(claudeHome, "projects", "fixture", "claude-session.jsonl");
  jsonl(claudeFile, [
    { type: "user", sessionId: "claude-session", cwd: repo, promptId: "prompt-1", uuid: "u1", timestamp: "2026-08-13T00:00:00Z", message: { content: [{ type: "text", text: "Update claude module" }] } },
    { type: "assistant", sessionId: "claude-session", cwd: repo, timestamp: "2026-08-13T00:00:01Z", message: { content: [{ type: "text", text: "Done" }], stop_reason: "end_turn" } },
  ]);
  jsonl(path.join(claudeHome, "projects", "fixture", "ignored.jsonl"), [
    { type: "user", sessionId: "ignored", cwd: unrelated, promptId: "p", timestamp: "2026-08-13T00:00:00Z", message: { content: "Ignore me" } },
  ]);

  const sessionDir = path.join(kimiHome, "sessions", "wd", "session_kimi");
  const wire = path.join(sessionDir, "agents", "main", "wire.jsonl");
  jsonl(path.join(kimiHome, "session_index.jsonl"), [{ sessionId: "session_kimi", sessionDir, workDir: repo }]);
  jsonl(path.join(sessionDir, "state.json"), [{ id: "session_kimi", title: "Kimi fixture" }]);
  jsonl(wire, [
    { type: "turn.prompt", time: 1, input: [{ type: "text", text: "Update kimi module" }] },
    { type: "context.append_loop_event", time: 2, event: { type: "content.part", part: { type: "text", text: "Done" } } },
    { type: "turn.ended", turnId: 0, reason: "completed", time: 3 },
  ]);

  const runner = async ({ prompt }) => prompt.includes("Update claude module")
    ? decision("Claude update", "claude-module") : decision("Kimi update", "kimi-module");
  const sharedState = { version: 2, initializedProviders: [], sessions: {} };
  const observer = new SessionObserver({
    config: { enabled: true, repoRoot: repo, providers: ["claude", "kimi"], pollMs: 250 },
    state: sharedState, adapters: [claudeSessionAdapter, kimiSessionAdapter], replay: true, runner,
  });
  const summary = await observer.tick();
  const snapshot = store.getSnapshot();
  assert.deepEqual(summary.providers, ["claude", "kimi"]);
  assert.equal(summary.trackedSessions, 2);
  assert.equal(summary.ignoredSessions, 1);
  assert.equal(snapshot.work.filter((item) => item.status === "done").length, 2);
  assert.deepEqual(new Set(snapshot.work.map((item) => item.session.kind)), new Set(["claude-cli", "kimi-cli"]));

  const restartedDir = path.join(kimiHome, "sessions", "wd", "session_after_restart");
  fs.appendFileSync(path.join(kimiHome, "session_index.jsonl"), `${JSON.stringify({ sessionId: "session_after_restart", sessionDir: restartedDir, workDir: repo })}\n`);
  jsonl(path.join(restartedDir, "state.json"), [{ id: "session_after_restart", title: "Restart fixture" }]);
  jsonl(path.join(restartedDir, "agents", "main", "wire.jsonl"), [
    { type: "turn.prompt", time: 10, input: [{ type: "text", text: "Update kimi module after restart" }] },
    { type: "context.append_loop_event", time: 11, event: { type: "step.end", turnId: 1, finishReason: "end_turn" } },
  ]);
  const restarted = new SessionObserver({
    config: { enabled: true, repoRoot: repo, providers: ["claude", "kimi"], pollMs: 250 },
    state: observer.state, adapters: [claudeSessionAdapter, kimiSessionAdapter], runner,
  });
  const restartedSummary = await restarted.tick();
  assert.equal(restartedSummary.trackedSessions, 3, "a new session created between observer processes must not be baselined away");
  assert.ok(store.getSnapshot().work.some((item) => item.session.id === "session_after_restart"));
});

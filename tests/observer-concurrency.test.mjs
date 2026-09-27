import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("ten-second inference does not block journal events or discard the new tail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-concurrency-"));
  const sessionsRoot = path.join(root, "sessions"); fs.mkdirSync(sessionsRoot);
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"concurrency-fixture"}');
  process.env.REPO_CANVAS_ROOT = root; process.env.REPO_CANVAS_DATA_DIR = path.join(root, ".repo-canvas");
  const { CodexObserver } = await import("../repo-canvas/scripts/observer.mjs");
  const { getSnapshot } = await import("../repo-canvas/scripts/canvas-store.mjs");
  const file = path.join(sessionsRoot, "rollout-concurrent.jsonl");
  const append = (...rows) => fs.appendFileSync(file, rows.map(([type,payload]) => JSON.stringify({timestamp:new Date().toISOString(),type,payload})).join("\n") + "\n");
  let calls = 0;
  const observer = new CodexObserver({ config:{repoRoot:root, providers:["codex"], maxConcurrent:1}, sessionsRoot, replay:true, state:{version:3,sessions:{}}, runner:async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10_000));
    return {value:{workTitle:"Проверка заявки", workSummary:"Читаем данные", workStatus:"active", targetEntityIds:[], entityChanges:[], relationChanges:[]}};
  }});
  try {
    append(["session_meta",{id:"concurrent-session",cwd:root,originator:"codex_desktop"}], ["event_msg",{type:"task_started",turn_id:"first"}], ["event_msg",{type:"agent_message",message:"Читаю первый файл"}]);
    const began = performance.now();
    await observer.tick({awaitModels:false});
    assert.ok(performance.now()-began < 2000, "initial polling waited for inference");
    assert.equal(calls, 1);
    append(["event_msg",{type:"agent_message",message:"Новый фрагмент во время ожидания"}], ["event_msg",{type:"task_started",turn_id:"second"}], ["event_msg",{type:"user_message",message:"Проверить ещё одну заявку"}], ["event_msg",{type:"task_complete",turn_id:"second"}]);
    const readAt = performance.now();
    await observer.tick({awaitModels:false});
    assert.ok(performance.now()-readAt < 2000, "new events waited for inference");
    assert.ok(getSnapshot().work.some(work => work.session?.id === "concurrent-session" && work.status === "done"));
    assert.equal(calls, 1, "concurrency bound exceeded");
    await Promise.all(observer.running.values());
    const first = observer.state.sessions[file].turns.first;
    assert.ok(first.events.some(event => event.text?.includes("Новый фрагмент")), "late result discarded the new tail");
    assert.equal(first.priorityPending, true);
  } finally { observer.controller.abort(); fs.rmSync(root, {recursive:true,force:true}); }
});

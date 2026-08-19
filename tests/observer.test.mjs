import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-canvas-observer-"));
const sessionsRoot = path.join(root, "sessions");
fs.mkdirSync(sessionsRoot, { recursive: true });
fs.writeFileSync(path.join(root, "package.json"), '{"name":"observer-fixture","private":true}\n');
for (const directory of ["src/entry", "src/output", "src/sales", "src/ops", "src/contracts"]) {
  fs.mkdirSync(path.join(root, directory), { recursive: true });
}
for (const file of ["src/sales/index.ts", "src/sales/checkout.ts", "src/ops/index.ts", "src/contracts/accepted-order.ts"]) {
  fs.writeFileSync(path.join(root, file), "// evidence fixture\n");
}
process.env.REPO_CANVAS_ROOT = root;
process.env.REPO_CANVAS_DATA_DIR = path.join(root, ".repo-canvas");

const store = await import("../repo-canvas/scripts/canvas-store.mjs");
const schema = await import("../repo-canvas/scripts/canvas-schema.mjs");
const sessions = await import("../repo-canvas/scripts/codex-sessions.mjs");
const semantic = await import("../repo-canvas/scripts/semantic-model.mjs");
const architect = await import("../repo-canvas/scripts/architect.mjs");
const runtime = await import("../repo-canvas/scripts/runtime-config.mjs");
const { CodexObserver, compactObserverState, observerPrompt } = await import("../repo-canvas/scripts/observer.mjs");

function approvedReview(overrides = {}) {
  return {
    passed: true,
    summary: "The map is understandable without repository access.",
    answers: { project: "A fixture", composition: "One area", lifecycle: "Input becomes output" },
    issues: [],
    ...overrides,
  };
}

function emit(type, payload) {
  store.appendEvent(store.createEvent(type, { actor: "test", payload }));
}

function record(type, payload) {
  return JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
}

function append(file, lines) {
  fs.appendFileSync(file, `${lines.join("\n")}\n`);
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("large Codex metadata lines and repository filtering remain reliable", () => {
  const file = path.join(sessionsRoot, "rollout-large.jsonl");
  append(file, [record("session_meta", { id: "large-session", cwd: root, originator: "codex_desktop", padding: "x".repeat(130_000) })]);
  const meta = sessions.readSessionMeta(file);
  assert.equal(meta.id, "large-session");
  assert.equal(sessions.sessionBelongsToRepository(meta, root), true);
  assert.equal(sessions.sessionBelongsToRepository({ ...meta, originator: "codex_sdk_ts" }, root), false);
  assert.equal(sessions.sessionBelongsToRepository({ ...meta, originator: "repo_canvas" }, root), false);
});

test("journal reads stay bounded, resume in order, and discard oversized records once", () => {
  const file = path.join(sessionsRoot, "rollout-bounded.jsonl");
  const lines = Array.from({ length: 6 }, (_, index) => JSON.stringify({ index, text: "x".repeat(48) }));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);

  let offset = 0;
  const seen = [];
  for (let pass = 0; pass < 6 && seen.length < lines.length; pass += 1) {
    const delta = sessions.readAppendedRecords(file, offset, { maxBytes: 256, maxRecordBytes: 128, maxRecords: 2 });
    assert.ok(delta.bytesRead <= 256);
    assert.ok(delta.records.length <= 2);
    assert.ok(delta.offset > offset);
    offset = delta.offset;
    seen.push(...delta.records.map((record) => record.index));
  }
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5]);

  const oversized = path.join(sessionsRoot, "rollout-oversized.jsonl");
  fs.writeFileSync(oversized, `${"x".repeat(700)}\n${JSON.stringify({ index: "after" })}\n`);
  offset = 0;
  let discardingOversizedRecord = false;
  const recovered = [];
  let skipped = 0;
  for (let pass = 0; pass < 8 && !recovered.length; pass += 1) {
    const delta = sessions.readAppendedRecords(oversized, offset, {
      maxBytes: 256, maxRecordBytes: 128, maxRecords: 2, discardingOversizedRecord,
    });
    assert.ok(delta.bytesRead <= 256);
    offset = delta.offset;
    discardingOversizedRecord = delta.discardingOversizedRecord;
    skipped += delta.skippedOversizedRecords;
    recovered.push(...delta.records);
  }
  assert.equal(skipped, 1);
  assert.deepEqual(recovered, [{ index: "after" }]);
  assert.equal(offset, fs.statSync(oversized).size);

  const partial = path.join(sessionsRoot, "rollout-partial.jsonl");
  const partialRecord = JSON.stringify({ index: "partial", text: "kept" });
  fs.writeFileSync(partial, partialRecord);
  const waiting = sessions.readAppendedRecords(partial, 0, { maxBytes: 256, maxRecordBytes: 128, maxRecords: 2 });
  assert.deepEqual(waiting.records, []);
  assert.equal(waiting.offset, 0, "a normal incomplete record must wait for its newline");
  fs.appendFileSync(partial, "\n");
  const completed = sessions.readAppendedRecords(partial, waiting.offset, { maxBytes: 256, maxRecordBytes: 128, maxRecords: 2 });
  assert.deepEqual(completed.records, [{ index: "partial", text: "kept" }]);
  assert.equal(completed.offset, fs.statSync(partial).size);
});

test("observer reuses persisted session metadata instead of rereading full journals", async () => {
  const file = path.join(sessionsRoot, "rollout-meta-cache.jsonl");
  fs.writeFileSync(file, "");
  let metadataReads = 0;
  const adapter = {
    id: "codex",
    listFiles: () => [file],
    readMeta: () => { metadataReads += 1; return { id: "cached-session", cwd: root, originator: "codex_desktop" }; },
    belongsToRepository: () => true,
    signals: () => [],
    locator: () => ({ kind: "codex-app", id: "cached-session", cwd: root }),
  };
  const observer = new CodexObserver({
    config: { enabled: true, repoRoot: root, providers: ["codex"], pollMs: 250 },
    state: { version: 2, initializedProviders: [], sessions: {} },
    adapters: [adapter], runner: async () => { throw new Error("runner should not be called"); },
  });
  await observer.tick();
  await observer.tick();
  assert.equal(metadataReads, 1);
});

test("observer follows owner language and preserves owner-facing map vocabulary", () => {
  const prompt = observerPrompt({
    final: false,
    turn: { sessionId: "language", userMessage: "Исправь выгрузку отчёта", events: [], title: "", summary: "", targets: [] },
    snapshot: {
      map: { projectTitle: "Платформа", projectSummary: "Владелец видит отчёты", keyFlows: [] },
      areas: [{ id: "reports", title: "Reports", ownerTitle: "Отчёты", note: "", ownerNote: "Пользовательские выгрузки" }],
      entities: [{ id: "export", areaId: "reports", parentId: "", label: "Exporter", ownerLabel: "Выгрузка", kind: "process", status: "operational", purpose: "", ownerPurpose: "Формирует файл", evidence: [] }],
      relations: [],
    },
  });
  assert.match(prompt, /language of the owner's current request/);
  assert.match(prompt, /Исправь выгрузку отчёта/);
  assert.match(prompt, /"ownerLabel":"Выгрузка"/);
});

test("observer publishes immediately, classifies deltas, and removes concepts only at completion", async () => {
  emit("area.upsert", { id: "core", title: "Core", note: "", order: 1 });
  emit("entity.upsert", {
    id: "legacy", areaId: "core", label: "Legacy", status: "operational", path: "src/legacy",
    purpose: "Old concept", note: "", inputs: [], outputs: [], dependsOn: [], order: 1,
  });
  const file = path.join(sessionsRoot, "rollout-live.jsonl");
  append(file, [
    record("session_meta", { id: "app-session", cwd: root, originator: "codex_desktop" }),
    record("event_msg", { type: "task_started", turn_id: "turn-1" }),
    record("event_msg", { type: "user_message", message: "Remove the obsolete legacy concept" }),
  ]);

  let now = 1_000;
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return {
      profile: { model: "fake-mini", effort: "low" },
      value: {
        workTitle: "Legacy cleanup", workSummary: "Removing the obsolete concept",
        workStatus: calls === 1 ? "active" : "done", targetEntityIds: ["legacy"],
        entityChanges: [{
          operation: "remove", entityId: "legacy", areaId: "", label: "", status: "operational",
          path: "", purpose: "", note: "", inputs: [], outputs: [], dependsOn: [], reason: "Concept eliminated",
        }],
        relationChanges: [],
      },
    };
  };
  const observer = new CodexObserver({
    config: { enabled: true, repoRoot: root, provider: "codex", pollMs: 250 },
    state: { version: 1, sessions: {} }, sessionsRoot, replay: true, runner, now: () => now,
  });

  await observer.tick();
  let snapshot = store.getSnapshot();
  assert.equal(calls, 0);
  assert.equal(snapshot.work.at(-1).provisional, true);
  assert.equal(snapshot.work.at(-1).status, "active");

  append(file, [record("event_msg", { type: "agent_message", phase: "commentary", message: "I will remove the old concept." })]);
  now += 500;
  await observer.tick();
  snapshot = store.getSnapshot();
  assert.equal(calls, 1);
  assert.ok(snapshot.entities.some((entity) => entity.id === "legacy"), "active inference must not remove semantic concepts");
  assert.equal(snapshot.work.at(-1).title, "Legacy cleanup");

  append(file, [record("event_msg", { type: "task_complete", turn_id: "turn-1" })]);
  now += 500;
  await observer.tick();
  snapshot = store.getSnapshot();
  assert.equal(calls, 2);
  assert.ok(!snapshot.entities.some((entity) => entity.id === "legacy"));
  assert.equal(snapshot.work.at(-1).status, "done");
  assert.equal(snapshot.work.at(-1).session.kind, "codex-app");
});

test("architect rejects relations to entities removed by the same refresh", () => {
  assert.throws(() => semantic.validateArchitecture({
    projectTitle: "Fixture", projectSummary: "",
    areas: [], entities: [],
    relations: [{ id: "bad", from: "legacy", to: "legacy", label: "self", status: "existing" }],
    removedAreaIds: [], removedEntityIds: ["legacy"], removedRelationIds: [],
  }), /Unknown relation endpoint/);
});

test("architect emits a DDD hierarchy, explanatory contracts, key flows, and map composition", () => {
  const model = {
    projectTitle: "Order platform", projectSummary: "Accepts and fulfils customer orders",
    layoutIntent: "flow", layoutDirection: "RIGHT",
    keyFlows: [{ id: "order-to-cash", title: "Order to cash", trigger: "customer submits order", outcome: "order is fulfilled", steps: ["sales", "checkout", "fulfilment"] }],
    unresolvedQuestions: ["Who owns manual refunds?"],
    areas: [
      { id: "sales-domain", title: "Sales", note: "Owns commercial intent", color: "#ef9a72", evidence: ["src/sales"], order: 1 },
      { id: "ops-domain", title: "Operations", note: "Owns fulfilment", color: "#73bca4", evidence: ["src/ops"], order: 2 },
    ],
    entities: [
      { id: "sales", areaId: "sales-domain", parentId: "", label: "Sales capability", kind: "capability", status: "operational", path: "src/sales", purpose: "Accept commercial intent", note: "", evidence: ["src/sales/index.ts"], order: 1 },
      { id: "checkout", areaId: "sales-domain", parentId: "sales", label: "Checkout", kind: "process", status: "operational", path: "src/sales/checkout", purpose: "Turn a cart into an accepted order", note: "", evidence: ["src/sales/checkout.ts"], order: 2 },
      { id: "fulfilment", areaId: "ops-domain", parentId: "", label: "Fulfilment", kind: "capability", status: "operational", path: "src/ops", purpose: "Deliver accepted orders", note: "", evidence: ["src/ops/index.ts"], order: 1 },
    ],
    relations: [{ id: "checkout-to-fulfilment", from: "checkout", to: "fulfilment", label: "publishes accepted order", kind: "event", contract: "AcceptedOrder v1", mechanism: "event bus", evidence: ["src/contracts/accepted-order.ts"], status: "existing" }],
    removedAreaIds: [], removedEntityIds: [], removedRelationIds: [],
  };
  const events = semantic.architectureEvents(model, { actor: "architect-test" });
  assert.equal(events[0].type, "map.upsert");
  assert.deepEqual(events[0].payload.keyFlows[0].steps, ["sales", "checkout", "fulfilment"]);
  assert.ok(events.findIndex((event) => event.payload.id === "sales") < events.findIndex((event) => event.payload.id === "checkout"));
  assert.equal(events.find((event) => event.type === "relation.upsert").payload.label, "publishes accepted order");
  for (const event of events) assert.deepEqual(schema.validateEvent(event), []);
});

test("architect rejects hierarchy cycles and cross-domain parents", () => {
  const base = {
    projectTitle: "Fixture", projectSummary: "", layoutIntent: "domain", layoutDirection: "AUTO", keyFlows: [], unresolvedQuestions: [],
    areas: [{ id: "a", title: "A", note: "", color: "#ef9a72", evidence: [], order: 1 }, { id: "b", title: "B", note: "", color: "#73bca4", evidence: [], order: 2 }],
    relations: [], removedAreaIds: [], removedEntityIds: [], removedRelationIds: [],
  };
  const entity = (id, areaId, parentId) => ({ id, areaId, parentId, label: id, kind: "module", status: "operational", path: "", purpose: "fixture", note: "", evidence: [], order: 1 });
  assert.throws(() => semantic.validateArchitecture({ ...base, entities: [entity("cycle-a", "a", "cycle-b"), entity("cycle-b", "a", "cycle-a")] }), /cycle/);
  assert.throws(() => semantic.validateArchitecture({ ...base, entities: [entity("parent-a", "a", ""), entity("child-b", "b", "parent-a")] }), /another area/);
});

test("architect repairs invalid cross-references inside the same Sol session", async () => {
  const base = {
    projectTitle: "Repair fixture", projectSummary: "Checks a semantic flow", layoutIntent: "flow", layoutDirection: "RIGHT",
    keyFlows: [{ id: "primary-flow", title: "Primary flow", trigger: "request arrives", outcome: "result leaves", steps: ["repair-entry", "invented-action", "repair-output"] }],
    unresolvedQuestions: [],
    areas: [{ id: "repair-area", title: "Repair area", note: "Owns the fixture", color: "#ef9a72", evidence: ["src"], order: 1 }],
    entities: [
      { id: "repair-entry", areaId: "repair-area", parentId: "", label: "Entry", kind: "interface", status: "operational", path: "src/entry", purpose: "Accept input", note: "", evidence: ["src/entry"], order: 1 },
      { id: "repair-output", areaId: "repair-area", parentId: "", label: "Output", kind: "process", status: "operational", path: "src/output", purpose: "Return output", note: "", evidence: ["src/output"], order: 2 },
    ],
    relations: [{ id: "repair-contract", from: "repair-entry", to: "repair-output", label: "passes accepted input", kind: "contract", contract: "Input", mechanism: "function call", evidence: ["src"], status: "existing" }],
    removedAreaIds: [], removedEntityIds: [], removedRelationIds: [],
  };
  const repaired = structuredClone(base);
  repaired.keyFlows[0].steps = ["repair-entry", "repair-output"];
  let calls = 0;
  let repairOptions = null;
  const sessionsSeen = [];
  const phases = [];
  const runner = async (options) => {
    calls += 1;
    sessionsSeen.push(options.session);
    if (calls === 2) repairOptions = options;
    return { value: calls === 1 ? base : repaired, profile: { model: "fake-sol", effort: "medium" }, threadId: "repair-thread", resumed: calls > 1, usage: { input_tokens: 100, cached_input_tokens: calls > 1 ? 80 : 0, output_tokens: 20 } };
  };
  const result = await architect.runArchitect({
    root, refresh: false, runner,
    reviewer: async () => ({ value: approvedReview(), threadId: "review-thread" }),
    onProgress: (progress) => phases.push(progress.phase),
  });
  assert.equal(calls, 2);
  assert.equal(result.repairs, 1);
  assert.equal(result.semanticReviews, 1);
  assert.deepEqual(result.reviewThreadIds, ["review-thread"]);
  assert.deepEqual(result.threadIds, ["repair-thread"]);
  assert.equal(sessionsSeen[0], sessionsSeen[1]);
  assert.equal(result.usage.inputTokens, 200);
  assert.equal(result.usage.cachedInputTokens, 80);
  assert.equal(result.usage.outputTokens, 40);
  const auditRecords = fs.readFileSync(result.auditFile, "utf8").trim().split(/\r?\n/).map(JSON.parse).filter((item) => item.runId === result.auditRunId);
  assert.equal(auditRecords.filter((item) => item.type === "model.completed").length, 3);
  assert.equal(auditRecords.at(-1).type, "run.completed");
  assert.match(repairOptions.prompt, /Do not inspect files, run tools/);
  assert.deepEqual(repairOptions.outputSchema.properties.keyFlows.items.properties.steps.items.enum.includes("invented-action"), false);
  assert.deepEqual(repairOptions.outputSchema.properties.areas.items.properties.id.enum, ["repair-area"]);
  assert.deepEqual(repairOptions.outputSchema.properties.entities.items.properties.id.enum.sort(), ["repair-entry", "repair-output"]);
  assert.ok(phases.includes("repairing"));
  assert.ok(phases.includes("applying"));
  assert.deepEqual(store.getSnapshot().map.keyFlows.at(-1).steps, ["repair-entry", "repair-output"]);
});

test("architect keeps people outside areas and requires a meaningful relation", () => {
  const person = {
    id: "operator", areaId: "", parentId: "", label: "Оператор закупок", kind: "person",
    status: "operational", path: "", purpose: "Передаёт спецификацию и принимает результат",
    note: "", evidence: [], order: 1,
  };
  const candidate = {
    projectTitle: "Проверка спецификаций", projectSummary: "Оператор передаёт спецификацию, система проверяет её и возвращает результат.",
    layoutIntent: "flow", layoutDirection: "RIGHT", keyFlows: [], unresolvedQuestions: [],
    areas: [{ id: "review", title: "Проверка данных", note: "Проверяет входные строки", color: "#ef9a72", evidence: [], order: 1 }],
    entities: [person, { id: "intake", areaId: "review", parentId: "", label: "Приём спецификации", kind: "interface", status: "operational", path: "", purpose: "Принимает файл на проверку", note: "", evidence: [], order: 1 }],
    relations: [{ id: "operator-submits", from: "operator", to: "intake", label: "передаёт спецификацию", kind: "data", contract: "", mechanism: "загрузка файла", evidence: [], status: "existing" }],
    removedAreaIds: [], removedEntityIds: [], removedRelationIds: [],
  };
  assert.doesNotThrow(() => semantic.validateArchitecture(candidate));
  assert.throws(() => semantic.validateArchitecture({ ...candidate, relations: [] }), /must have at least one explanatory relation/);
  const events = semantic.architectureEvents(candidate, { actor: "architect-test" });
  for (const event of events) assert.deepEqual(schema.validateEvent(event), []);
  assert.deepEqual(schema.validateEventSequence(events.map((event, index) => ({ event, line: index + 1 }))), []);
  const [work] = semantic.observerEvents({
    workTitle: "Работа оператора", workSummary: "Меняет человека", workStatus: "active", targetEntityIds: ["operator"], entityChanges: [], relationChanges: [],
  }, { workId: "person-work", final: false });
  assert.deepEqual(work.payload.targets, []);
  assert.equal(work.payload.provisional, true);
});

test("blind review sends focused feedback back into the same Sol session", async () => {
  const initial = {
    projectTitle: "Fixture", projectSummary: "Technical subsystems", layoutIntent: "domain", layoutDirection: "AUTO", keyFlows: [], unresolvedQuestions: [],
    areas: [{ id: "misc", title: "User product", note: "Mixed things", color: "#ef9a72", evidence: [], order: 1 }],
    entities: [{ id: "worker", areaId: "misc", parentId: "", label: "Worker", kind: "service", status: "operational", path: "", purpose: "Does work", note: "", evidence: [], order: 1 }],
    relations: [], removedAreaIds: [], removedEntityIds: [], removedRelationIds: [],
  };
  const regenerated = structuredClone(initial);
  regenerated.projectSummary = "Accepts a request, performs the fixture operation and returns its result.";
  regenerated.areas[0].title = "Request processing";
  regenerated.entities[0].label = "Fixture operation";
  regenerated.entities[0].purpose = "Turns an accepted request into the returned fixture result";
  let architectCalls = 0;
  let reviewCalls = 0;
  const sessionsSeen = [];
  const result = await architect.runArchitect({
    root, refresh: false,
    runner: async (options) => { sessionsSeen.push(options.session); return { value: architectCalls++ === 0 ? initial : regenerated, profile: { model: "fake-sol", effort: "medium" }, threadId: "architect-session", resumed: architectCalls > 1 }; },
    reviewer: async () => ({
      value: reviewCalls++ === 0
        ? approvedReview({ passed: false, summary: "The project purpose is unclear", answers: { project: "Unknown", composition: "Mixed", lifecycle: "Unknown" }, issues: [{ severity: "critical", scope: "map", id: "map", message: "No end-to-end purpose", recommendation: "Explain input and result" }] })
        : approvedReview(),
      threadId: `review-${reviewCalls}`,
    }),
  });
  assert.equal(result.semanticRegenerations, 0);
  assert.equal(result.acceptanceRepairs, 1);
  assert.equal(result.semanticReviews, 2);
  assert.equal(sessionsSeen[0], sessionsSeen[1]);
  assert.deepEqual(result.threadIds, ["architect-session"]);
  assert.equal(store.getSnapshot().map.projectSummary, regenerated.projectSummary);
});

test("failed acceptance preserves every reviewer verdict and token total", async () => {
  const candidate = {
    projectTitle: "Fixture", projectSummary: "Accepts a request and returns a result.", layoutIntent: "domain", layoutDirection: "AUTO", keyFlows: [], unresolvedQuestions: [],
    areas: [{ id: "api-area", title: "Request handling", note: "Owns request operations", color: "#ef9a72", evidence: [], order: 1 }],
    entities: [{ id: "request-api", areaId: "api-area", parentId: "", label: "Request API", kind: "interface", status: "operational", path: "", purpose: "Handles everything", note: "", evidence: [], order: 1 }],
    relations: [], removedAreaIds: [], removedEntityIds: [], removedRelationIds: [],
  };
  const rejection = approvedReview({ passed: false, summary: "Request API is too broad", issues: [{ severity: "critical", scope: "entity", id: "request-api", message: "Too many responsibilities", recommendation: "Split request intake and export" }] });
  let caught;
  try {
    await architect.runArchitect({
      root, refresh: false, maxReviewRepairs: 1,
      runner: async () => ({ value: structuredClone(candidate), profile: { model: "fake-sol", effort: "medium" }, threadId: "persistent-sol", usage: { input_tokens: 100, output_tokens: 10 } }),
      reviewer: async () => ({ value: structuredClone(rejection), profile: { model: "fake-luna", effort: "low" }, threadId: crypto.randomUUID(), usage: { input_tokens: 20, output_tokens: 5 } }),
    });
  } catch (error) { caught = error; }
  assert.match(caught?.message || "", /2 review\(s\)/);
  assert.equal(caught.audit.usage.inputTokens, 240);
  assert.equal(caught.audit.usage.outputTokens, 30);
  const records = fs.readFileSync(caught.audit.auditFile, "utf8").trim().split(/\r?\n/).map(JSON.parse).filter((item) => item.runId === caught.audit.runId);
  assert.equal(records.filter((item) => item.type === "review.completed").length, 2);
  assert.equal(records.filter((item) => item.type === "review.completed")[0].issues[0].id, "request-api");
  assert.equal(records.at(-1).type, "run.failed");
});

test("focused review repair cannot rewrite an unrelated area", () => {
  const before = {
    projectTitle: "Fixture", projectSummary: "Fixture map", layoutIntent: "domain", layoutDirection: "AUTO", unresolvedQuestions: [], keyFlows: [],
    areas: [{ id: "api-area", title: "API", note: "Requests" }, { id: "billing-area", title: "Billing", note: "Money" }],
    entities: [{ id: "request-api", areaId: "api-area", label: "Request API" }, { id: "billing", areaId: "billing-area", label: "Billing" }],
    relations: [], removedAreaIds: [], removedEntityIds: [], removedRelationIds: [],
  };
  const review = approvedReview({ passed: false, issues: [{ severity: "critical", scope: "entity", id: "request-api", message: "Too broad", recommendation: "Split responsibilities" }] });
  const focused = structuredClone(before);
  focused.entities[0].label = "Request lifecycle API";
  focused.entities.push({ id: "request-export", areaId: "api-area", label: "Request export" });
  assert.doesNotThrow(() => architect.assertReviewRepairScope(before, focused, review));
  const unrelated = structuredClone(focused);
  unrelated.entities.find((item) => item.id === "billing").label = "Changed billing";
  assert.throws(() => architect.assertReviewRepairScope(before, unrelated, review), /unrelated entity 'billing'/);
  assert.ok(architect.architectureReviewSchema(before).properties.issues.items.properties.id.enum.includes("request-api"));
  assert.throws(() => architect.validateReviewerDecision(before, { ...review, issues: [{ ...review.issues[0], scope: "area" }] }), /does not match scope/);
});

test("observer state stays compact and atomic replacement retries transient Windows locks", () => {
  const state = { version: 2, initializedProviders: ["codex"], sessions: {} };
  for (let index = 0; index < 895; index += 1) {
    state.sessions[`session-${index}`] = {
      offset: index, relevant: index % 3 === 0, provider: "codex",
      meta: { id: `id-${index}`, cwd: root, originator: "codex_desktop", instructions: "x".repeat(20_000), env: { SECRET: "discard" } },
      turns: {},
    };
  }
  const compacted = compactObserverState(state);
  assert.ok(JSON.stringify(compacted).length < 500_000);
  assert.equal(compacted.sessions["session-0"].meta.instructions, undefined);
  assert.equal(compacted.sessions["session-0"].meta.env, undefined);

  let attempts = 0;
  const waits = [];
  runtime.replaceFileSync("temporary", "target", {
    rename: () => {
      attempts += 1;
      if (attempts < 4) throw Object.assign(new Error("locked"), { code: "EPERM" });
    },
    wait: (delay) => waits.push(delay),
  });
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [10, 20, 40]);

  const architectStatus = { status: "running", phase: "reviewing", startedAt: "2026-08-19T10:00:00.000Z" };
  runtime.writeArchitectState(architectStatus);
  assert.deepEqual(runtime.readArchitectState(), architectStatus);
});

test("idle observer polls do not rewrite unchanged state", async () => {
  const file = path.join(sessionsRoot, "idle-session.jsonl");
  fs.writeFileSync(file, "");
  let writes = 0;
  const observer = new CodexObserver({
    config: { enabled: true, repoRoot: root, providers: ["codex"], pollMs: 250 },
    state: { version: 3, initializedProviders: [], sessions: {} },
    adapters: [{ id: "codex", listFiles: () => [file], readMeta: () => ({ id: "idle", cwd: root, originator: "codex_desktop" }), belongsToRepository: () => true, signals: () => [], locator: () => ({ kind: "codex-app", id: "idle", cwd: root }) }],
    writeState: () => { writes += 1; }, discoveryIntervalMs: 0,
  });
  await observer.tick();
  await observer.tick();
  await observer.tick();
  assert.equal(writes, 1);
});

test("architect prompt makes owner language and reference preflight explicit", () => {
  const prompt = architect.architectPrompt({ snapshot: store.getSnapshot(), refresh: true, viewpoint: "Покажи проект языком владельца" });
  assert.match(prompt, /owner viewpoint is the strongest language signal/);
  assert.match(prompt, /keyFlow step is an exact id/);
  assert.match(prompt, /Mandatory preflight/);
  assert.match(prompt, /Покажи проект языком владельца/);
});

test("architect language gate rejects mixed owner-facing jargon but keeps technical names", () => {
  const candidate = {
    projectTitle: "Анализатор спецификаций", projectSummary: "Проверяет входные данные", layoutIntent: "flow", layoutDirection: "RIGHT",
    keyFlows: [{ id: "review", title: "Проверка", trigger: "Пользователь загружает файл", outcome: "Получен отчёт", steps: ["api", "reviewer"] }], unresolvedQuestions: [],
    areas: [{ id: "product", title: "Продукт", note: "Пользовательский контур", color: "#ef9a72", evidence: [], order: 1 }],
    entities: [
      { id: "api", areaId: "product", parentId: "", label: "FastAPI runtime", kind: "service", status: "operational", path: "", purpose: "Принимает запросы", note: "", evidence: [], order: 1 },
      { id: "reviewer", areaId: "product", parentId: "", label: "Проверка", kind: "process", status: "operational", path: "", purpose: "Формирует PostgreSQL", note: "", evidence: [], order: 2 },
    ],
    relations: [{ id: "review", from: "api", to: "reviewer", label: "передаёт proposed output на проверку", kind: "data", contract: "", mechanism: "", evidence: [], status: "existing" }],
    removedAreaIds: [], removedEntityIds: [], removedRelationIds: [],
  };
  const issues = architect.architectureLanguageIssues(candidate, "ru");
  assert.ok(issues.some((item) => item.includes("entity.api.label") && item.includes("runtime")));
  assert.ok(issues.some((item) => item.includes("relation.review.label") && item.includes("proposed")));
  assert.ok(!issues.some((item) => item.includes("entity.reviewer.purpose")), "single technical product names stay valid inside Russian wording");
  assert.equal(architect.preferredMapLanguage("Покажи карту владельцу", store.getSnapshot()), "ru");
  assert.equal(architect.preferredMapLanguage("", { map: {}, areas: [], entities: [], relations: [] }, "Русская документация проекта содержит достаточно текста для определения языка.".repeat(4)), "ru");
});

test("completed observer work may remain provisional when no semantic target was established", () => {
  const [event] = semantic.observerEvents({
    workTitle: "Repository-wide review", workSummary: "No single semantic target was established",
    workStatus: "done", targetEntityIds: [], entityChanges: [], relationChanges: [],
  }, {
    workId: "unmapped-review", final: true,
    session: { kind: "codex-app", id: "unmapped-session", cwd: root },
  });
  assert.equal(event.payload.provisional, true);
  assert.deepEqual(event.payload.targets, []);
  assert.deepEqual(schema.validateEvent(event), []);
});

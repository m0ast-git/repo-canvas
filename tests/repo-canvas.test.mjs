import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { routeEdges as routeLibavoidEdges } from "@mr_mint/elkjs-libavoid";

import { patchSnapshotPositions } from "../client/src/canvas-snapshot.js";
import { layoutFingerprint } from "../client/src/layout-fingerprint.js";
import { MODEL_PROFILES, codexCommandArguments, codexProcessOptions, codexResumeCommandArguments, codexTarget, createIsolatedCodexHome } from "../repo-canvas/scripts/model-runtime.mjs";
import { resolveSessionTarget } from "../repo-canvas/scripts/session-locator.mjs";
import { reduceEvents } from "../repo-canvas/scripts/canvas-store.mjs";
import { validateEvent } from "../repo-canvas/scripts/canvas-schema.mjs";
import { anchoredZoomTransform, boxesOverlap, captionAwareDetour, captionShapesOverlap, chooseFloatingCaption, connectionAnchors, crossAreaDetour, packAreaRectangles, paddedBox, placeRelationLabel, relationCurve, routesShareLane, sampleRelationCurve } from "../public/canvas-layout.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repositoryRoot, "repo-canvas", "scripts", "canvas.mjs");
const writer = path.join(repositoryRoot, "tests", "concurrent-writer.mjs");

test("Codex runtime resolves Windows, macOS, and Linux without a shell wrapper", () => {
  assert.deepEqual(codexTarget("win32", "x64"), { targetTriple: "x86_64-pc-windows-msvc", packageName: "@openai/codex-win32-x64", binaryName: "codex.exe" });
  assert.deepEqual(codexTarget("darwin", "arm64"), { targetTriple: "aarch64-apple-darwin", packageName: "@openai/codex-darwin-arm64", binaryName: "codex" });
  assert.deepEqual(codexTarget("darwin", "x64"), { targetTriple: "x86_64-apple-darwin", packageName: "@openai/codex-darwin-x64", binaryName: "codex" });
  assert.deepEqual(codexTarget("linux", "arm64"), { targetTriple: "aarch64-unknown-linux-musl", packageName: "@openai/codex-linux-arm64", binaryName: "codex" });
  assert.throws(() => codexTarget("darwin", "ia32"), /Unsupported platform/);
  const args = codexCommandArguments({ cwd: "/fixture", profile: { model: "test-model", effort: "medium" }, schemaPath: "/schema.json" });
  assert.ok(args.includes("mcp_servers={}"));
  assert.ok(args.includes("project_doc_max_bytes=0"));
  for (const feature of ["apps", "browser_use", "computer_use", "hooks", "memories", "multi_agent", "plugins", "skill_search"]) assert.ok(args.includes(feature));
  const resumed = codexResumeCommandArguments({ threadId: "019f-session", profile: { model: "test-model", effort: "medium" }, schemaPath: "/schema.json" });
  assert.deepEqual(resumed.slice(0, 3), ["exec", "resume", "--json"]);
  assert.equal(resumed.at(-2), "019f-session");
  assert.equal(resumed.at(-1), "-");
  assert.ok(resumed.includes("/schema.json"));
  assert.equal(MODEL_PROFILES.observer.model, process.env.REPO_CANVAS_OBSERVER_MODEL || "gpt-5.6-luna");
  assert.equal(MODEL_PROFILES.reviewer.model, process.env.REPO_CANVAS_REVIEWER_MODEL || "gpt-5.6-luna");
  assert.deepEqual(codexProcessOptions({ SAFE: "1" }), { env: { SAFE: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
});

test("Codex runtime isolates subscription auth from global instructions", async (t) => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "repo-canvas-codex-source-"));
  fs.writeFileSync(path.join(source, "auth.json"), "fixture-auth");
  fs.writeFileSync(path.join(source, "AGENTS.md"), "must not leak");
  fs.writeFileSync(path.join(source, "config.toml"), "[mcp_servers.fixture]");
  fs.mkdirSync(path.join(source, "skills"));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const isolated = await createIsolatedCodexHome(source);
  try {
    assert.equal(fs.readFileSync(path.join(isolated.directory, "auth.json"), "utf8"), "fixture-auth");
    assert.equal(fs.existsSync(path.join(isolated.directory, "AGENTS.md")), false);
    assert.equal(fs.existsSync(path.join(isolated.directory, "config.toml")), false);
    assert.equal(fs.existsSync(path.join(isolated.directory, "skills")), false);
  } finally { await isolated.cleanup(); }
  assert.equal(fs.existsSync(isolated.directory), false);
});

test("saved coordinates do not restart the topology layout generation", () => {
  const snapshot = {
    map: { layoutDirection: "RIGHT" }, areas: [{ id: "core" }],
    entities: [{ id: "api", areaId: "core", parentId: null, kind: "service", x: 10, y: 20 }],
    relations: [{ id: "calls", from: "api", to: "api", status: "existing", label: "calls" }],
    work: [],
  };
  const initial = layoutFingerprint(snapshot);
  assert.equal(layoutFingerprint({ ...snapshot, revision: 2, entities: [{ ...snapshot.entities[0], x: 900, y: -400 }] }), initial);
  assert.notEqual(layoutFingerprint({ ...snapshot, entities: [...snapshot.entities, { id: "db", areaId: "core", kind: "store" }] }), initial);
  assert.notEqual(layoutFingerprint({ ...snapshot, relations: [{ ...snapshot.relations[0], label: "publishes" }] }), initial);
});

test("a successful drag patches the local snapshot without waiting for polling", () => {
  const snapshot = { revision: 4, areas: [{ id: "core", x: 0, y: 0 }], entities: [{ id: "api", x: 10, y: 20 }] };
  const patched = patchSnapshotPositions(snapshot, [{ kind: "entity", id: "api", x: 320, y: -80 }], 5);
  assert.equal(patched.revision, 5);
  assert.deepEqual(patched.entities[0], { id: "api", x: 320, y: -80 });
  assert.equal(patched.areas[0], snapshot.areas[0]);
  assert.equal(snapshot.entities[0].x, 10);
});

test("libavoid keeps a manually isolated node on a local route", async () => {
  const isolated = { id: "isolated", x: 900, y: -1600, width: 244, height: 122 };
  const graph = {
    id: "routing-test",
    children: [
      isolated,
      { id: "before", x: 120, y: 120, width: 244, height: 122 },
      { id: "after", x: 1680, y: 260, width: 244, height: 122 },
      ...Array.from({ length: 18 }, (_, index) => ({ id: `obstacle-${index}`, x: 380 + index % 6 * 210, y: 20 + Math.floor(index / 6) * 210, width: 150, height: 100 })),
    ],
    edges: [
      { id: "incoming", source: "before", target: "isolated" },
      { id: "outgoing", source: "isolated", target: "after" },
    ],
  };
  const routes = await routeLibavoidEdges(graph, {
    routingType: "orthogonal", segmentPenalty: 20, crossingPenalty: 70, fixedSharedPathPenalty: 50,
    reverseDirectionPenalty: 24, shapeBufferDistance: 14, idealNudgingDistance: 12,
    nudgeOrthogonalSegmentsConnectedToShapes: true, nudgeOrthogonalTouchingColinearSegments: true,
    nudgeSharedPathsWithCommonEndPoint: true,
  });
  assert.equal(routes.size, 2);
  for (const route of routes.values()) {
    const points = [route.sourcePoint, ...route.bendPoints, route.targetPoint];
    assert.ok(Math.min(...points.map((point) => point.y)) >= isolated.y - 40, "route must not escape above the isolated node");
  }
});

test("semantic relation labels avoid headers, cards, and each other", () => {
  const a = { x: 100, y: 140 };
  const b = { x: 520, y: 140 };
  const anchors = connectionAnchors(a, b);
  assert.deepEqual(anchors.from, { x: 344, y: 201 });
  assert.deepEqual(anchors.to, { x: 520, y: 201 });

  const header = { x: 405, y: 170, width: 120, height: 38 };
  const first = placeRelationLabel("передаёт результат", anchors.from, anchors.to, [header]);
  assert.ok(first, "Expected a free caption position");
  assert.equal(boxesOverlap(first.box, header), false);
  const second = placeRelationLabel("следующая связь", anchors.from, anchors.to, [header, first.box]);
  assert.ok(second, "Expected a second non-overlapping caption position");
  assert.equal(boxesOverlap(second.box, first.box), false);
});

test("floating relation captions stay on visible curve segments and separate at crossings", () => {
  const firstCurve = relationCurve({ x: 0, y: 0 }, { x: 600, y: 400 }, { laneOffset: -34 });
  const secondCurve = relationCurve({ x: 0, y: 400 }, { x: 600, y: 0 }, { laneOffset: 34 });
  const viewport = { x: 170, y: 80, width: 260, height: 240 };
  const first = chooseFloatingCaption({
    samples: sampleRelationCurve(firstCurve), currentProgress: .5, width: 110, height: 22, viewport,
  });
  assert.ok(first);
  const second = chooseFloatingCaption({
    samples: sampleRelationCurve(secondCurve), currentProgress: .5, width: 110, height: 22, viewport, occupied: [first.box],
  });
  assert.ok(second);
  assert.equal(captionShapesOverlap(first.box, second.box), false);
  assert.notEqual(first.angle, 0);
  assert.notEqual(second.angle, 0);

  const cropped = chooseFloatingCaption({
    samples: sampleRelationCurve(firstCurve), currentProgress: .2, width: 80, height: 22,
    viewport: { x: 420, y: 330, width: 170, height: 90 },
  });
  assert.ok(cropped);
  assert.ok(cropped.progress > .65, "Caption should slide from an off-screen start to the visible tail");
});

test("floating captions never fall back onto nodes", () => {
  const curve = relationCurve({ x: 0, y: 100 }, { x: 500, y: 100 });
  const placement = chooseFloatingCaption({
    samples: sampleRelationCurve(curve), currentProgress: .5, width: 120, height: 22,
    viewport: { x: 0, y: 0, width: 500, height: 220 },
    obstacles: [{ x: 0, y: 0, width: 500, height: 220 }],
  });
  assert.equal(placement, null);
});

test("zoom keeps the selected viewport point over the same world point", () => {
  const current = { x: -320, y: 140, scale: .5 };
  const anchor = { x: 760, y: 410 };
  const worldBefore = { x: (anchor.x - current.x) / current.scale, y: (anchor.y - current.y) / current.scale };
  const next = anchoredZoomTransform(current, 1.1, anchor);
  assert.equal((anchor.x - next.x) / next.scale, worldBefore.x);
  assert.equal((anchor.y - next.y) / next.scale, worldBefore.y);
});

test("short gaps get a rounded caption-aware detour outside adjacent nodes", () => {
  const detour = captionAwareDetour({ x: 20, y: 40 }, { x: 284, y: 40 }, 96);
  assert.ok(detour);
  assert.equal(detour.from.y, 162);
  assert.ok(detour.waypoints[0].y > detour.from.y);
  assert.equal(detour.waypoints[0].y, detour.waypoints[1].y);
  const route = relationCurve(detour.from, detour.to, { waypoints: detour.waypoints });
  assert.match(route.d, / Q /, "Detour corners should stay rounded");
});

test("cross-area routes leave through row lanes instead of cutting through sibling nodes", () => {
  const sourceArea = { x: 0, y: 0, width: 850, height: 600 };
  const targetArea = { x: 924, y: 0, width: 850, height: 600 };
  const source = { x: 48, y: 102 };
  const target = { x: 972, y: 102 };
  const route = crossAreaDetour(source, target, sourceArea, targetArea);
  assert.ok(route);
  assert.equal(route.from.y, source.y + 122);
  assert.ok(route.waypoints[0].y > route.from.y);
  assert.equal(route.waypoints[1].x, 887);
  const sibling = paddedBox({ x: 318, y: 102 }, 244, 122, 0);
  const samples = sampleRelationCurve(relationCurve(route.from, route.to, { waypoints: route.waypoints }));
  assert.equal(samples.some((point) => point.x > sibling.x && point.x < sibling.x + sibling.width && point.y > sibling.y && point.y < sibling.y + sibling.height), false);
});

test("parallel relation routes reserve separate visual lanes", () => {
  const first = relationCurve({ x: 100, y: 0 }, { x: 100, y: 600 });
  const overlapping = relationCurve({ x: 112, y: 80 }, { x: 112, y: 520 });
  const separated = relationCurve({ x: 140, y: 80 }, { x: 140, y: 520 });
  assert.equal(routesShareLane(overlapping.points, [first.points]), true);
  assert.equal(routesShareLane(separated.points, [first.points]), false);
});

test("automatic area packing has no small-project cap or vertical overlap", () => {
  const rectangles = Array.from({ length: 18 }, (_, index) => ({
    id: `area-${index}`,
    width: 850 + (index % 4) * 270,
    height: 400 + (index % 7) * 714,
  }));
  const positions = packAreaRectangles(rectangles);
  assert.equal(positions.size, 18);
  const packed = [...positions.values()];
  for (let index = 0; index < packed.length; index += 1) {
    for (let other = index + 1; other < packed.length; other += 1) {
      assert.equal(boxesOverlap(packed[index], packed[other]), false, `areas ${index} and ${other} overlap`);
    }
  }
});

test("semantic snapshot keeps hundreds of entities and relations without truncation", () => {
  const event = (index, type, payload) => ({
    v: 1,
    id: `scale-${index}`,
    ts: new Date(1_700_000_000_000 + index).toISOString(),
    type,
    actor: "scale-test",
    payload,
  });
  const events = [];
  for (let area = 1; area <= 12; area += 1) {
    events.push(event(events.length, "area.upsert", { id: `area-${area}`, title: `Area ${area}`, order: area }));
  }
  for (let entity = 1; entity <= 240; entity += 1) {
    events.push(event(events.length, "entity.upsert", {
      id: `entity-${entity}`,
      areaId: `area-${Math.ceil(entity / 20)}`,
      label: `Entity ${entity}`,
      status: "operational",
    }));
  }
  for (let relation = 1; relation <= 283; relation += 1) {
    events.push(event(events.length, "relation.upsert", {
      id: `relation-${relation}`,
      from: `entity-${((relation - 1) % 239) + 1}`,
      to: `entity-${((relation - 1) % 239) + 2}`,
      label: `Flow ${relation}`,
      status: "existing",
    }));
  }
  const snapshot = reduceEvents(events);
  assert.equal(snapshot.areas.length, 12);
  assert.equal(snapshot.entities.length, 240);
  assert.equal(snapshot.relations.length, 283);
  assert.deepEqual(snapshot.entities.slice(0, 4).map((item) => item.label), ["Entity 1", "Entity 2", "Entity 3", "Entity 4"]);
});

test("legacy task-board events and fields are rejected", () => {
  const base = {
    v: 1, id: "legacy-event", ts: new Date().toISOString(), actor: "test", payload: {},
  };
  assert.match(validateEvent({ ...base, type: "task.upsert" }).join("\n"), /unknown event type/);
  assert.match(validateEvent({ ...base, type: "activity.log", taskId: "old-task", payload: { message: "old" } }).join("\n"), /unknown event field 'taskId'/);
});

function makeRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-canvas-test-"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0","private":true}\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runCli(root, args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    timeout: options.timeout || 15_000,
  });
}

function waitForOutput(child, pattern, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}; output: ${output}`)), timeoutMs);
    const inspect = (chunk) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => {
      if (!pattern.test(output)) {
        clearTimeout(timer);
        reject(new Error(`Process exited ${code} before ${pattern}; output: ${output}`));
      }
    });
  });
}

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    const timer = setTimeout(() => reject(new Error("Process did not exit in time")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function request(port, { method = "GET", path: requestPath = "/api/health", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, method, path: requestPath, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* static/text response */ }
          resolve({ status: response.statusCode, headers: response.headers, text, json });
        });
      },
    );
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

test("nested invocation resolves the Git root and validates semantic statuses", (t) => {
  const root = makeRepository(t);
  const nested = path.join(root, "src", "nested");
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(runCli(root, ["area", "--id", "core", "--title", "Core"], { cwd: nested }).status, 0);
  assert.ok(fs.existsSync(path.join(root, ".repo-canvas", "events.jsonl")));
  assert.ok(!fs.existsSync(path.join(nested, ".repo-canvas")));

  const invalid = runCli(root, ["entity", "--id", "bad", "--area", "core", "--label", "Bad", "--status", "donne", "--actor", "codex"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /unsupported value 'donne'/);

  const check = runCli(root, ["check"]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /revision 1/);
});

test("session locators stay structured and Codex Desktop binds automatically", (t) => {
  const root = makeRepository(t);
  assert.equal(runCli(root, ["area", "--id", "core", "--title", "Core"]).status, 0);
  assert.equal(runCli(root, ["entity", "--id", "module", "--area", "core", "--label", "Module", "--status", "operational"]).status, 0);
  const threadId = "019ff2ac-1bcb-7103-b395-cfe4e749a251";
  const node = runCli(root, ["work", "--id", "demo", "--title", "Demo work", "--targets", "module", "--status", "active", "--actor", "codex"], {
    env: { CODEX_THREAD_ID: threadId, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" },
  });
  assert.equal(node.status, 0, node.stderr);
  const snapshot = JSON.parse(runCli(root, ["snapshot"]).stdout);
  assert.deepEqual(snapshot.work[0].session, {
    kind: "codex-app",
    id: threadId,
    cwd: fs.realpathSync(root),
  });

  assert.deepEqual(resolveSessionTarget({ kind: "codex-app", id: threadId }), {
    mode: "external",
    uri: `codex://threads/${threadId}`,
    exact: true,
    label: "Codex",
  });
  assert.equal(resolveSessionTarget({ kind: "kimi-app", title: "Probe" }).exact, false);
  assert.equal(resolveSessionTarget({ kind: "kimi-cli", id: "session_123" }).command, "kimi -r session_123");
  assert.equal(resolveSessionTarget({ kind: "unsupported", id: "x" }), null);
  assert.throws(() => resolveSessionTarget({ kind: "codex-app", id: "x; calc.exe" }), /Invalid codex-app session id/);
});

test("concurrent processes serialize complete event appends and reclaim an old dead lock", async (t) => {
  const root = makeRepository(t);
  const store = path.join(root, ".repo-canvas");
  fs.mkdirSync(store, { recursive: true });
  const lock = path.join(store, "events.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 999_999, createdAt: "2000-01-01T00:00:00.000Z" }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);

  const writers = Array.from({ length: 4 }, (_, index) => spawn(
    process.execPath,
    [writer, root, `agent${index}`, "50"],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  ));
  const results = await Promise.all(writers.map((child) => waitForExit(child, 20_000)));
  assert.deepEqual(
    results.map((result) => result.code),
    [0, 0, 0, 0],
    results.map((result) => result.output).join("\n"),
  );
  assert.ok(!fs.existsSync(lock));

  const snapshot = runCli(root, ["snapshot"]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  const parsed = JSON.parse(snapshot.stdout);
  assert.equal(parsed.revision, 200);
  assert.deepEqual(parsed.storeErrors, []);
});

test("repair previews and quarantines malformed JSON without hiding schema errors", (t) => {
  const root = makeRepository(t);
  assert.equal(runCli(root, ["log", "--task", "repair", "--actor", "codex", "--message", "valid"]).status, 0);
  const events = path.join(root, ".repo-canvas", "events.jsonl");
  fs.appendFileSync(events, "{broken tail\n", "utf8");

  const checkBefore = runCli(root, ["check"]);
  assert.equal(checkBefore.status, 1);
  assert.match(checkBefore.stderr, /"kind": "parse"/);

  const preview = runCli(root, ["repair"]);
  assert.equal(preview.status, 2);
  const previewJson = JSON.parse(preview.stdout);
  assert.deepEqual(previewJson.removableLines, [2]);

  const applied = runCli(root, ["repair", "--apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.applied, true);
  assert.ok(fs.existsSync(result.backupFile));
  assert.ok(fs.existsSync(result.rejectedFile));
  assert.equal(runCli(root, ["check"]).status, 0);
});

test("loopback server guards navigation, reports port collision, and stops", async (t) => {
  const root = makeRepository(t);
  assert.equal(runCli(root, ["area", "--id", "core", "--title", "Core"]).status, 0);
  assert.equal(runCli(root, ["entity", "--id", "module", "--area", "core", "--label", "Module", "--status", "operational"]).status, 0);
  assert.equal(runCli(root, ["relation", "--id", "module-loop", "--from", "module", "--to", "module", "--label", "uses"]).status, 0);
  assert.equal(runCli(root, ["work", "--id", "demo", "--title", "Demo work", "--targets", "module", "--status", "planned", "--actor", "codex"], {
    env: { CODEX_THREAD_ID: "", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "" },
  }).status, 0);
  const port = await freePort();
  const server = spawn(process.execPath, [cli, "start", "--no-open", "--root", root, "--port", String(port)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (server.exitCode === null) server.kill("SIGTERM"); });
  const startedOutput = await waitForOutput(server, /listening at/);
  assert.match(startedOutput, new RegExp(`http://127\\.0\\.0\\.1:${port}/`));
  const apiToken = fs.readFileSync(path.join(root, ".repo-canvas", "api-token"), "utf8").trim();
  assert.match(apiToken, /^[A-Za-z0-9_-]{43}$/);

  const badHost = await request(port, { headers: { Host: `attacker.example:${port}` } });
  assert.equal(badHost.status, 403);

  const unauthorized = await request(port, { path: "/api/state", headers: { Host: `127.0.0.1:${port}` } });
  assert.equal(unauthorized.status, 401);

  const bootstrap = await request(port, { path: "/", headers: { Host: `127.0.0.1:${port}` } });
  assert.equal(bootstrap.status, 200);
  const sessionCookie = bootstrap.headers["set-cookie"]?.[0];
  assert.match(sessionCookie || "", /^repo_canvas_api=[A-Za-z0-9_-]{43}; Path=\/api; HttpOnly; SameSite=Strict$/);
  const cookieState = await request(port, {
    path: "/api/state",
    headers: { Host: `127.0.0.1:${port}`, Cookie: sessionCookie.split(";", 1)[0] },
  });
  assert.equal(cookieState.status, 200, "opening the plain loopback URL must authorize the browser session");

  const wrongToken = await request(port, {
    path: "/api/state",
    headers: { Host: `127.0.0.1:${port}`, "X-Repo-Canvas-Token": "x".repeat(43) },
  });
  assert.equal(wrongToken.status, 401);

  const authHeaders = { Host: `127.0.0.1:${port}`, "X-Repo-Canvas-Token": apiToken };

  const state = await request(port, { path: "/api/state", headers: authHeaders });
  assert.equal(state.status, 200);
  const revision = await request(port, { path: "/api/revision", headers: authHeaders });
  assert.equal(revision.status, 200);
  assert.equal(revision.json.revision, state.json.revision);
  const architectStatus = await request(port, { path: "/api/architect/status", headers: authHeaders });
  assert.equal(architectStatus.status, 200);
  assert.equal(architectStatus.json.status, "idle");
  assert.equal(architectStatus.json.running, false);
  assert.equal(architectStatus.json.phase, "idle");
  assert.equal(architectStatus.json.elapsedMs, 0);
  assert.ok(Date.parse(architectStatus.json.checkedAt));
  const guardedArchitectRefresh = await request(port, {
    method: "POST",
    path: "/api/architect/refresh",
    headers: { ...authHeaders, "Content-Length": 2 },
    body: "{}",
  });
  assert.equal(guardedArchitectRefresh.status, 415, "Architect refresh must keep the JSON mutation guard");
  const payload = JSON.stringify({
    workId: "demo",
    canvasRevision: state.json.revision,
  });
  const commonHeaders = {
    ...authHeaders,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  };
  const csrf = await request(port, {
    method: "POST",
    path: "/api/sessions/open",
    headers: { ...commonHeaders, Origin: "https://evil.example" },
    body: payload,
  });
  assert.equal(csrf.status, 403);

  const unlinked = await request(port, {
    method: "POST",
    path: "/api/sessions/open",
    headers: { ...commonHeaders, Origin: `http://127.0.0.1:${port}` },
    body: payload,
  });
  assert.equal(unlinked.status, 422, unlinked.text);

  const stalePayload = JSON.stringify({ workId: "demo", canvasRevision: state.json.revision - 1 });
  const stale = await request(port, {
    method: "POST",
    path: "/api/sessions/open",
    headers: {
      ...commonHeaders,
      "Content-Length": Buffer.byteLength(stalePayload),
      Origin: `http://127.0.0.1:${port}`,
    },
    body: stalePayload,
  });
  assert.equal(stale.status, 409);

  const layoutPayload = JSON.stringify({
    canvasRevision: state.json.revision,
    items: [
      { kind: "area", id: "core", x: 180, y: 220 },
      { kind: "entity", id: "module", x: 260, y: 340 },
      { kind: "work", id: "demo", x: 540, y: 360 },
    ],
  });
  const layout = await request(port, {
    method: "POST",
    path: "/api/layout",
    headers: { ...commonHeaders, "Content-Length": Buffer.byteLength(layoutPayload), Origin: `http://127.0.0.1:${port}` },
    body: layoutPayload,
  });
  assert.equal(layout.status, 201, layout.text);
  assert.equal(layout.json.saved, 3);
  const movedState = await request(port, { path: "/api/state", headers: authHeaders });
  assert.deepEqual([movedState.json.areas[0].x, movedState.json.areas[0].y], [180, 220]);
  assert.deepEqual([movedState.json.entities[0].x, movedState.json.entities[0].y], [260, 340]);
  assert.deepEqual([movedState.json.work[0].x, movedState.json.work[0].y], [540, 360]);
  assert.equal(movedState.json.work[0].actor, "codex", "moving work must preserve the owning agent");
  let renameRevision = movedState.json.revision;
  for (const [kind, id, value] of [
    ["area", "core", "Runtime"],
    ["entity", "module", "Worker"],
    ["relation", "module-loop", "feeds itself"],
  ]) {
    const renamePayload = JSON.stringify({ canvasRevision: renameRevision, kind, id, value });
    const renamed = await request(port, {
      method: "POST",
      path: "/api/rename",
      headers: { ...commonHeaders, "Content-Length": Buffer.byteLength(renamePayload), Origin: `http://127.0.0.1:${port}` },
      body: renamePayload,
    });
    assert.equal(renamed.status, 201, renamed.text);
    renameRevision = renamed.json.revision;
  }
  const renamedState = await request(port, { path: "/api/state", headers: authHeaders });
  assert.equal(renamedState.json.areas[0].ownerTitle, "Runtime");
  assert.equal(renamedState.json.entities[0].ownerLabel, "Worker");
  assert.equal(renamedState.json.relations[0].ownerLabel, "feeds itself");
  for (const [kind, id, values] of [
    ["area", "core", { title: "Runtime", description: "Owner area description" }],
    ["entity", "module", { title: "Worker", description: "Owner entity description" }],
  ]) {
    const editPayload = JSON.stringify({ canvasRevision: renameRevision, kind, id, values });
    const edited = await request(port, {
      method: "POST", path: "/api/rename",
      headers: { ...commonHeaders, "Content-Length": Buffer.byteLength(editPayload), Origin: `http://127.0.0.1:${port}` }, body: editPayload,
    });
    assert.equal(edited.status, 201, edited.text); renameRevision = edited.json.revision;
  }
  const editedState = await request(port, { path: "/api/state", headers: authHeaders });
  assert.equal(editedState.json.areas[0].ownerNote, "Owner area description");
  assert.equal(editedState.json.entities[0].ownerPurpose, "Owner entity description");
  assert.equal(runCli(root, ["entity", "--id", "module", "--area", "core", "--label", "Upstream module", "--status", "operational"]).status, 0);
  const refreshedState = await request(port, { path: "/api/state", headers: authHeaders });
  assert.equal(refreshedState.json.entities[0].label, "Upstream module");
  assert.equal(refreshedState.json.entities[0].ownerLabel, "Worker", "owner name must survive later agent updates");
  assert.equal(refreshedState.json.entities[0].ownerPurpose, "Owner entity description", "owner description must survive later agent updates");
  const emptyRenamePayload = JSON.stringify({ canvasRevision: renameRevision, kind: "entity", id: "module", value: "   " });
  const emptyRename = await request(port, {
    method: "POST",
    path: "/api/rename",
    headers: { ...commonHeaders, "Content-Length": Buffer.byteLength(emptyRenamePayload), Origin: `http://127.0.0.1:${port}` },
    body: emptyRenamePayload,
  });
  assert.equal(emptyRename.status, 400);
  const staleLayout = await request(port, {
    method: "POST",
    path: "/api/layout",
    headers: { ...commonHeaders, "Content-Length": Buffer.byteLength(layoutPayload), Origin: `http://127.0.0.1:${port}` },
    body: layoutPayload,
  });
  assert.equal(staleLayout.status, 409);

  const second = spawn(process.execPath, [cli, "start", "--root", root, "--port", String(port)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const secondOutput = await waitForOutput(second, /already in use/);
  const secondExit = await waitForExit(second);
  assert.equal(secondExit.code, 1);
  assert.match(secondOutput, /--port <port>/);

  const started = Date.now();
  server.kill("SIGTERM");
  await waitForExit(server, 2_500);
  assert.ok(Date.now() - started < 2_500);

  const restarted = spawn(process.execPath, [cli, "start", "--no-open", "--root", root, "--port", String(port)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (restarted.exitCode === null) restarted.kill("SIGTERM"); });
  await waitForOutput(restarted, /listening at/);
  const restartedToken = fs.readFileSync(path.join(root, ".repo-canvas", "api-token"), "utf8").trim();
  assert.equal(restartedToken, apiToken, "the project token must survive an ordinary server restart");
  const reconnected = await request(port, { path: "/api/state", headers: authHeaders });
  assert.equal(reconnected.status, 200, "an existing browser token must reconnect after restart");
  restarted.kill("SIGTERM");
  await waitForExit(restarted, 2_500);
});

test("architect status survives a restart and interrupted work is explicit", async (t) => {
  const root = makeRepository(t);
  const stateFile = path.join(root, ".repo-canvas", "architect-state.json");
  const completed = {
    status: "done", phase: "done", startedAt: "2026-08-19T10:00:00.000Z",
    heartbeatAt: "2026-08-19T10:05:00.000Z", finishedAt: "2026-08-19T10:05:00.000Z",
    attempt: 1, activityCount: 5, detail: null, result: { areas: 3, calls: 2 }, error: null,
  };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(completed)}\n`);
  const port = await freePort();
  const launch = () => spawn(process.execPath, [cli, "start", "--no-open", "--root", root, "--port", String(port)], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
  });
  let server = launch();
  t.after(() => { if (server.exitCode === null) server.kill("SIGTERM"); });
  await waitForOutput(server, /listening at/);
  const apiToken = fs.readFileSync(path.join(root, ".repo-canvas", "api-token"), "utf8").trim();
  const headers = { Host: `127.0.0.1:${port}`, "X-Repo-Canvas-Token": apiToken };
  const restored = await request(port, { path: "/api/architect/status", headers });
  assert.equal(restored.json.status, "done");
  assert.deepEqual(restored.json.result, completed.result);
  server.kill("SIGTERM");
  await waitForExit(server, 2_500);

  fs.writeFileSync(stateFile, `${JSON.stringify({ ...completed, status: "running", phase: "reviewing", finishedAt: null })}\n`);
  server = launch();
  await waitForOutput(server, /listening at/);
  const interrupted = await request(port, { path: "/api/architect/status", headers });
  assert.equal(interrupted.json.status, "failed");
  assert.match(interrupted.json.error, /прерван перезапуском/);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).status, "failed");
  server.kill("SIGTERM");
  await waitForExit(server, 2_500);
});

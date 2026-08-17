import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const tarballArgument = process.argv[2];
if (!tarballArgument) throw new Error("Usage: node tests/package-smoke.mjs <repo-canvas.tgz>");
const tarball = path.resolve(tarballArgument);
if (!fs.existsSync(tarball)) throw new Error(`Tarball not found: ${tarball}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-canvas-package-"));
const conflictRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repo-canvas-conflict-"));
const npmCliCandidates = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
].filter(Boolean);
const npmCli = npmCliCandidates.find((candidate) => fs.existsSync(candidate));
const npmCommand = npmCli ? process.execPath : "npm";
const npmPrefix = npmCli ? [npmCli] : [];

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, npm_config_cache: path.join(cwd, ".npm-cache") },
    encoding: "utf8",
    timeout: options.timeout || 60_000,
  });
  if (options.expectFailure) {
    assert.notEqual(result.status, 0, `Expected failure: ${command} ${args.join(" ")}`);
  } else {
    assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function hashFiles(base, files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(fs.readFileSync(path.join(base, file)));
  return hash.digest("hex");
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

function request(port, requestPath, token = "") {
  return new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}` };
    if (token) headers["X-Repo-Canvas-Token"] = token;
    http.get({ host: "127.0.0.1", port, path: requestPath, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    }).once("error", reject);
  });
}

function waitFor(child, pattern, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out: ${output}`)), timeoutMs);
    const inspect = (chunk) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
  });
}

try {
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname = \"existing-python-project\"\nversion = \"1.0.0\"\n");
  fs.writeFileSync(path.join(root, "src", "app.py"), "print('existing product code')\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Owner instructions\n\nKeep this paragraph byte-for-byte.\n");
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "hooks.json"), `${JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "owner-command", timeout: 10 }] }],
    },
  }, null, 2)}\n`);
  assert.ok(!fs.existsSync(path.join(root, "package.json")), "Fixture must begin without an npm manifest");
  const ownerAgents = fs.readFileSync(path.join(root, "AGENTS.md"));
  const ownerHooks = fs.readFileSync(path.join(root, ".codex", "hooks.json"));

  fs.mkdirSync(path.join(conflictRoot, ".git"));
  fs.writeFileSync(
    path.join(conflictRoot, "package.json"),
    `${JSON.stringify({ name: "fixture", version: "1.0.0", private: true }, null, 2)}\n`,
  );

  for (const fixture of [root, conflictRoot]) {
    const localTarball = path.join(fixture, path.basename(tarball));
    fs.copyFileSync(tarball, localTarball);
    run(npmCommand, [...npmPrefix, "install", "--save-dev", "--save-exact", "--ignore-scripts", localTarball], fixture);
  }

  assert.ok(fs.existsSync(path.join(root, "package.json")), "npm did not create a minimal tooling manifest");
  assert.equal(fs.readFileSync(path.join(root, "src", "app.py"), "utf8"), "print('existing product code')\n");

  const installedCli = path.join(root, "node_modules", "repo-canvas", "repo-canvas", "scripts", "canvas.mjs");
  assert.ok(fs.existsSync(installedCli), "CLI source missing from packed artifact");
  assert.ok(fs.existsSync(path.join(root, "node_modules", "repo-canvas", "repo-canvas", "scripts", "claude-sessions.mjs")));
  assert.ok(fs.existsSync(path.join(root, "node_modules", "repo-canvas", "repo-canvas", "scripts", "kimi-sessions.mjs")));
  assert.ok(fs.existsSync(path.join(root, "node_modules", ".bin", process.platform === "win32" ? "repo-canvas.cmd" : "repo-canvas")));
  const installedPublic = path.join(root, "node_modules", "repo-canvas", "public");
  const installedIndex = fs.readFileSync(path.join(installedPublic, "index.html"), "utf8");
  const assetReferences = [...installedIndex.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((match) => match[1]);
  assert.ok(assetReferences.some((asset) => asset.endsWith(".js")), "Packed browser build does not reference JavaScript");
  assert.ok(assetReferences.some((asset) => asset.endsWith(".css")), "Packed browser build does not reference CSS");
  for (const asset of assetReferences) assert.ok(fs.existsSync(path.join(installedPublic, asset.replace(/^\//, ""))), `Packed browser asset missing: ${asset}`);
  const packedAssets = fs.readdirSync(path.join(installedPublic, "assets"));
  assert.ok(packedAssets.some((name) => name.startsWith("layout-worker-") && name.endsWith(".js")), "Packed layout worker missing");
  assert.ok(packedAssets.some((name) => name.startsWith("elk-worker.min-") && name.endsWith(".js")), "Packed ELK worker missing");
  const libavoidWasm = packedAssets.find((name) => name.startsWith("libavoid-") && name.endsWith(".wasm"));
  assert.ok(libavoidWasm, "Packed libavoid WASM runtime missing");
  assert.ok(fs.existsSync(path.join(root, "node_modules", "repo-canvas", "THIRD_PARTY_NOTICES.md")), "Third-party routing notice missing");
  run(process.execPath, [installedCli, "init"], root);
  const managedFiles = ["package.json", "package-lock.json", "AGENTS.md", ".gitignore", ".codex/hooks.json"];
  const firstHash = hashFiles(root, managedFiles);
  run(process.execPath, [installedCli, "init"], root);
  assert.equal(hashFiles(root, managedFiles), firstHash, "Second init changed managed files");
  assert.deepEqual(fs.readFileSync(path.join(root, "AGENTS.md")), ownerAgents, "init changed owner AGENTS.md");
  assert.deepEqual(fs.readFileSync(path.join(root, ".codex", "hooks.json")), ownerHooks, "init changed owner hooks");
  assert.ok(!fs.existsSync(path.join(root, "repo-canvas")), "init must not add an agent-facing repo-canvas directory");
  assert.ok(!fs.existsSync(path.join(root, "CLAUDE.md")), "init must not add agent context files");
  assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /\/repo-canvas-\*\.tgz/);
  const initializedPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(initializedPackage.scripts["repo-canvas"], "repo-canvas");
  assert.equal(initializedPackage.scripts["repo-canvas:start"], "repo-canvas start");
  assert.equal(initializedPackage.scripts["repo-canvas:check"], "repo-canvas check");

  const nested = path.join(root, "src", "nested");
  fs.mkdirSync(nested, { recursive: true });
  run(process.execPath, [installedCli, "area", "--id", "core", "--title", "Core system", "--actor", "codex"], nested);
  run(process.execPath, [installedCli, "entity", "--id", "api", "--area", "core", "--label", "API", "--path", "src", "--status", "operational", "--actor", "codex"], nested);
  run(process.execPath, [installedCli, "entity", "--id", "storage", "--area", "core", "--label", "Storage", "--path", "pyproject.toml", "--status", "operational", "--actor", "codex"], nested);
  run(process.execPath, [installedCli, "entity", "--id", "future", "--area", "core", "--label", "Planned module", "--status", "planned", "--actor", "codex"], nested);
  run(process.execPath, [installedCli, "relation", "--from", "api", "--to", "storage", "--status", "existing", "--actor", "codex"], nested);
  run(process.execPath, [installedCli, "work", "--id", "current-work", "--title", "Improve API", "--targets", "api,storage", "--status", "active", "--note", "Exercise work satellite", "--actor", "codex", "--surface", "kimi-app", "--session-title", "Fixture work"], nested);
  run(process.execPath, [installedCli, "check"], nested);
  const seeded = JSON.parse(run(process.execPath, [installedCli, "snapshot"], nested).stdout);
  assert.equal(seeded.semantic, true);
  assert.equal(seeded.areas[0].id, "core");
  assert.equal(seeded.entities.find((entity) => entity.id === "api")?.status, "operational");
  assert.equal(seeded.entities.find((entity) => entity.id === "future")?.status, "planned");
  assert.deepEqual(seeded.work[0].targets, ["api", "storage"]);
  assert.deepEqual(seeded.activeEntityIds.sort(), ["api", "storage"]);
  assert.ok(fs.existsSync(path.join(root, ".repo-canvas", "events.jsonl")));
  assert.ok(!fs.existsSync(path.join(root, "node_modules", "repo-canvas", ".repo-canvas")));

  const port = await freePort();
  const server = spawn(process.execPath, [installedCli, "start", "--no-open", "--port", String(port)], {
    cwd: nested,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitFor(server, /listening at/);
    const apiToken = fs.readFileSync(path.join(root, ".repo-canvas", "api-token"), "utf8").trim();
    assert.match(apiToken, /^[A-Za-z0-9_-]{43}$/);
    const health = await request(port, "/api/health", apiToken);
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).root, fs.realpathSync.native(root));
    const page = await request(port, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /Repo Canvas/);
    const wasm = await request(port, `/assets/${libavoidWasm}`);
    assert.equal(wasm.status, 200);
    assert.equal(wasm.headers["content-type"], "application/wasm");
  } finally {
    server.kill("SIGTERM");
  }

  const conflictManifest = path.join(conflictRoot, "package.json");
  const conflictPackage = JSON.parse(fs.readFileSync(conflictManifest, "utf8"));
  conflictPackage.scripts = { "repo-canvas": "something-else" };
  fs.writeFileSync(conflictManifest, `${JSON.stringify(conflictPackage, null, 2)}\n`);
  const beforeConflict = fs.readFileSync(conflictManifest);
  const conflictCli = path.join(conflictRoot, "node_modules", "repo-canvas", "repo-canvas", "scripts", "canvas.mjs");
  const failed = run(process.execPath, [conflictCli, "init"], conflictRoot, { expectFailure: true });
  assert.match(failed.stderr, /script 'repo-canvas'/);
  assert.deepEqual(fs.readFileSync(conflictManifest), beforeConflict);
  assert.ok(!fs.existsSync(path.join(conflictRoot, "AGENTS.md")));
  assert.ok(!fs.existsSync(path.join(conflictRoot, ".repo-canvas")));

  console.log(`Packed Repo Canvas smoke test passed: ${tarball}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(conflictRoot, { recursive: true, force: true });
}

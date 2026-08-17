import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const packageInfo = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
const tarball = path.resolve(process.argv[2] || path.join("dist", `repo-canvas-${packageInfo.version}.tgz`));
if (!fs.statSync(tarball, { throwIfNoEntry: false })?.isFile()) throw new Error("Usage: node tests/self-update-smoke.mjs <repo-canvas.tgz>");
const targetVersion = packageInfo.version;
const sourceCli = path.resolve("repo-canvas", "scripts", "canvas.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-canvas-update-"));
let activePid = null;
let initialPid = null;
let canvasPort = null;
let token = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function request(port, token, pathname, { method = "GET", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      host: "127.0.0.1", port, path: pathname, method,
      headers: {
        Host: `127.0.0.1:${port}`,
        "X-Repo-Canvas-Token": token,
        ...(payload ? { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json", "Content-Length": payload.length } : {}),
      },
      timeout: 1_500,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, json, text });
      });
    });
    request.once("timeout", () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function waitForOutput(child, pattern, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}: ${output}`)), timeoutMs);
    const inspect = (chunk) => {
      output += chunk.toString();
      if (pattern.test(output)) { clearTimeout(timer); resolve(output); }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
  });
}

async function waitForUpdatedServer(port, token, previousPid, timeoutMs = 35_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = await request(port, token, "/api/health");
      if (health.status === 200 && health.json?.pid !== previousPid) return health.json;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Updated server did not return authenticated health in time");
}

async function stopPid(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

async function removeFixture(directory) {
  let lastError;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try { fs.rmSync(directory, { recursive: true, force: true }); return; }
    catch (error) {
      lastError = error;
      if (!new Set(["EPERM", "EBUSY", "ENOTEMPTY"]).has(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

const asset = fs.readFileSync(tarball);
const digest = crypto.createHash("sha256").update(asset).digest("hex");
let fixturePort;
const fixture = http.createServer((request, response) => {
  if (request.url === "/latest") {
    const body = JSON.stringify({
      tag_name: `v${targetVersion}`,
      draft: false,
      prerelease: false,
      published_at: new Date().toISOString(),
      html_url: `http://127.0.0.1:${fixturePort}/release`,
      assets: [{
        name: `repo-canvas-${targetVersion}.tgz`, state: "uploaded", size: asset.length,
        digest: `sha256:${digest}`,
        browser_download_url: `http://127.0.0.1:${fixturePort}/asset.tgz`,
      }],
    });
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
    return;
  }
  if (request.url === "/asset.tgz") {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": asset.length });
    response.end(asset);
    return;
  }
  response.writeHead(404).end();
});

try {
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "self-update-fixture", private: true }, null, 2)}\n`);
  fixturePort = await listen(fixture);
  canvasPort = await freePort();
  const server = spawn(process.execPath, [sourceCli, "start", "--root", root, "--port", String(canvasPort), "--no-open"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      REPO_CANVAS_CURRENT_VERSION_OVERRIDE: "0.0.1",
      REPO_CANVAS_RELEASE_API_URL: `http://127.0.0.1:${fixturePort}/latest`,
      REPO_CANVAS_AUTO_OPEN: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  initialPid = server.pid;
  await waitForOutput(server, /listening at/);
  token = fs.readFileSync(path.join(root, ".repo-canvas", "api-token"), "utf8").trim();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);

  const available = await request(canvasPort, token, "/api/update/status?refresh=1");
  assert.equal(available.status, 200, available.text);
  assert.equal(available.json.status, "available");
  assert.equal(available.json.availableVersion, targetVersion);

  const applying = await request(canvasPort, token, "/api/update/apply", { method: "POST", body: {} });
  assert.equal(applying.status, 202, applying.text);
  assert.equal(applying.json.status, "applying");

  const health = await waitForUpdatedServer(canvasPort, token, server.pid);
  activePid = health.pid;
  assert.notEqual(activePid, server.pid, "Self-update did not replace the server process");
  const updateStateFile = path.join(root, ".repo-canvas", "runtime", "update-state.json");
  const runnerDeadline = Date.now() + 5_000;
  while (Date.now() < runnerDeadline) {
    try { if (JSON.parse(fs.readFileSync(updateStateFile, "utf8")).status === "updated") break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const status = await request(canvasPort, token, "/api/update/status?refresh=1");
  assert.equal(status.status, 200, status.text);
  assert.equal(status.json.currentVersion, targetVersion);
  assert.equal(status.json.status, "current");
  const pointerFile = path.join(root, ".repo-canvas", "runtime", "current.json");
  const updateState = fs.readFileSync(updateStateFile, "utf8");
  assert.equal(JSON.parse(updateState).status, "updated", updateState);
  assert.ok(fs.existsSync(pointerFile), `Updater did not activate the runtime: ${updateState}`);
  const pointer = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
  assert.equal(pointer.version, targetVersion);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".repo-canvas", "runtime", "versions", targetVersion, "node_modules", "repo-canvas", "package.json"), "utf8")).version, targetVersion);
  console.log(`Self-update smoke test passed: 0.0.1 -> ${targetVersion}`);
} finally {
  if (canvasPort && token) {
    try { activePid ||= (await request(canvasPort, token, "/api/health")).json?.pid; } catch {}
  }
  await stopPid(activePid);
  await stopPid(initialPid);
  await new Promise((resolve) => fixture.close(resolve));
  await removeFixture(root);
}

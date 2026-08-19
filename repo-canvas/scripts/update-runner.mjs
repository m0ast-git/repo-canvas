#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { replaceFileSync } from "./atomic-file.mjs";

const MAX_ASSET_BYTES = 50 * 1024 * 1024;

function jobFromEnvironment() {
  const job = JSON.parse(process.env.REPO_CANVAS_UPDATE_JOB || "null");
  if (!job || job.schema !== 1) throw new Error("Missing or invalid Repo Canvas update job");
  return job;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  replaceFileSync(temporary, file, { rename: fs.renameSync });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForParent(pid) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(100);
  }
  throw new Error("The previous Repo Canvas server did not stop in time");
}

function validateDownloadUrl(url, release, allowNonGithub) {
  if (allowNonGithub) return;
  const expected = `https://github.com/m0ast-git/repo-canvas/releases/download/v${release.version}/${release.assetName}`;
  if (url !== expected) throw new Error("Release asset URL does not match the official Repo Canvas release");
}

async function downloadRelease(release, destination, allowNonGithub) {
  validateDownloadUrl(release.downloadUrl, release, allowNonGithub);
  const response = await fetch(release.downloadUrl, { signal: AbortSignal.timeout(60_000), redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Release download returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_ASSET_BYTES) throw new Error("Release asset exceeds 50 MiB");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
  const hash = crypto.createHash("sha256");
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > MAX_ASSET_BYTES) throw new Error("Release asset exceeds 50 MiB");
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise((resolve) => output.once("drain", resolve));
    }
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
  } catch (error) {
    output.destroy();
    throw error;
  }
  if (received !== release.size) throw new Error(`Release size mismatch: expected ${release.size}, received ${received}`);
  const actual = hash.digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(release.digest))) {
    throw new Error("Release SHA-256 does not match GitHub metadata");
  }
}

function npmInvocation() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const cli = candidates.find((candidate) => fs.existsSync(candidate));
  if (cli) return { command: process.execPath, prefix: [cli] };
  if (process.platform === "win32") throw new Error("npm CLI could not be located next to Node.js");
  return { command: "npm", prefix: [] };
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const { capture = false, ...spawnOptions } = options;
    const child = spawn(command, args, {
      ...spawnOptions,
      stdio: capture ? ["ignore", "pipe", "pipe"] : spawnOptions.stdio,
      shell: false,
      windowsHide: true,
    });
    let output = "";
    if (capture) {
      const collect = (chunk) => { output = `${output}${chunk}`.slice(-8_000); };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
    }
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Command exited with code ${code}${output.trim() ? `: ${output.trim()}` : ""}`)));
  });
}

async function installRelease(job, tarball, temporaryDirectory, finalDirectory) {
  const npm = npmInvocation();
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  await run(npm.command, [
    ...npm.prefix,
    "install", "--prefix", temporaryDirectory,
    "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball,
  ], { cwd: job.root, capture: true, env: { ...process.env, npm_config_update_notifier: "false" } });
  const packageDirectory = path.join(temporaryDirectory, "node_modules", "repo-canvas");
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  const cli = path.join(packageDirectory, "repo-canvas", "scripts", "canvas.mjs");
  const server = path.join(packageDirectory, "server.mjs");
  if (manifest.version !== job.release.version || !fs.existsSync(cli) || !fs.existsSync(server)) {
    throw new Error("Installed release failed the Repo Canvas runtime validation");
  }
  fs.mkdirSync(path.dirname(finalDirectory), { recursive: true });
  if (fs.existsSync(finalDirectory)) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  else replaceFileSync(temporaryDirectory, finalDirectory, { rename: fs.renameSync });
  return path.join(finalDirectory, "node_modules", "repo-canvas", "repo-canvas", "scripts", "canvas.mjs");
}

function launch(job, cli) {
  const child = spawn(process.execPath, [cli, "start", "--root", job.root, "--host", job.host, "--port", String(job.port), "--no-open"], {
    cwd: job.root,
    env: {
      ...process.env,
      REPO_CANVAS_API_TOKEN: job.apiToken,
      REPO_CANVAS_AUTO_OPEN: "0",
      REPO_CANVAS_RUNTIME_ACTIVE: "0",
      REPO_CANVAS_UPDATE_JOB: "",
      REPO_CANVAS_CURRENT_VERSION_OVERRIDE: "",
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child;
}

function probe(job) {
  return new Promise((resolve) => {
    const request = http.get({
      host: job.host,
      port: job.port,
      path: "/api/health",
      headers: { Host: `${job.host}:${job.port}`, "X-Repo-Canvas-Token": job.apiToken },
      timeout: 800,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(response.statusCode === 200 && path.resolve(body.root) === path.resolve(job.root));
        } catch { resolve(false); }
      });
    });
    request.once("timeout", () => { request.destroy(); resolve(false); });
    request.once("error", () => resolve(false));
  });
}

async function waitForServer(job) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await probe(job)) return true;
    await delay(200);
  }
  return false;
}

function portIsOpen(job) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: job.host, port: job.port });
    socket.setTimeout(500);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

async function waitForPortClose(job) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!await portIsOpen(job)) return;
    await delay(100);
  }
}

async function main() {
  const job = jobFromEnvironment();
  const previousPointer = fs.existsSync(job.currentPointerFile) ? fs.readFileSync(job.currentPointerFile, "utf8") : null;
  const downloads = path.join(job.runtimeDirectory, "downloads");
  const versions = path.join(job.runtimeDirectory, "versions");
  const tarball = path.join(downloads, `${path.basename(job.release.assetName, ".tgz")}.${process.pid}.tgz`);
  const temporary = path.join(versions, `.${job.release.version}.${process.pid}.tmp`);
  const finalDirectory = path.join(versions, job.release.version);
  let switched = false;
  try {
    await waitForParent(job.parentPid);
    await downloadRelease(job.release, tarball, job.allowNonGithub);
    const cli = await installRelease(job, tarball, temporary, finalDirectory);
    atomicWriteJson(job.currentPointerFile, { version: job.release.version, cli, installedAt: new Date().toISOString() });
    switched = true;
    const updatedServer = launch(job, job.sourceCli);
    if (!await waitForServer(job)) {
      updatedServer.kill();
      await waitForPortClose(job);
      throw new Error("Updated Repo Canvas did not become healthy in 15 seconds");
    }
    atomicWriteJson(job.stateFile, {
      status: "updated", fromVersion: job.fromVersion, toVersion: job.release.version, finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (switched) {
      if (previousPointer === null) fs.rmSync(job.currentPointerFile, { force: true });
      else fs.writeFileSync(job.currentPointerFile, previousPointer, "utf8");
    }
    atomicWriteJson(job.stateFile, {
      status: "failed", fromVersion: job.fromVersion, toVersion: job.release.version,
      finishedAt: new Date().toISOString(), error: String(error?.message || error).slice(0, 500),
    });
    launch(job, job.sourceCli);
  } finally {
    fs.rmSync(tarball, { force: true });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(() => { process.exitCode = 1; });

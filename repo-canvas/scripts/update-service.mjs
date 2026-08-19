import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { packageRoot, projectRoot, resolveDataDirectory } from "./project-root.mjs";
import { replaceFileSync } from "./atomic-file.mjs";
import { compareVersions, normalizeVersion } from "./runtime-version.mjs";

const RELEASE_API = "https://api.github.com/repos/m0ast-git/repo-canvas/releases/latest";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ASSET_BYTES = 50 * 1024 * 1024;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  replaceFileSync(temporary, file, { rename: fs.renameSync });
}

function currentPackageVersion() {
  if (process.env.NODE_ENV === "test" && process.env.REPO_CANVAS_CURRENT_VERSION_OVERRIDE) {
    return normalizeVersion(process.env.REPO_CANVAS_CURRENT_VERSION_OVERRIDE);
  }
  return normalizeVersion(readJson(path.join(packageRoot, "package.json"))?.version);
}

export function releaseCandidate(release, currentVersion, { allowNonGithub = false } = {}) {
  if (!release || release.draft || release.prerelease) return null;
  const version = normalizeVersion(release.tag_name);
  if (!version || compareVersions(version, currentVersion) <= 0) return null;
  const expectedName = `repo-canvas-${version}.tgz`;
  const asset = Array.isArray(release.assets) ? release.assets.find((item) => item?.name === expectedName) : null;
  const digest = String(asset?.digest || "").match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
  const downloadUrl = String(asset?.browser_download_url || "");
  const expectedPrefix = `https://github.com/m0ast-git/repo-canvas/releases/download/v${version}/`;
  if (!asset || asset.state !== "uploaded" || !digest || (!allowNonGithub && !downloadUrl.startsWith(expectedPrefix))) return null;
  const size = Number(asset.size);
  if (!Number.isInteger(size) || size < 1 || size > MAX_ASSET_BYTES) return null;
  return {
    version,
    tag: `v${version}`,
    assetName: expectedName,
    size,
    digest,
    downloadUrl,
    releaseUrl: String(release.html_url || `https://github.com/m0ast-git/repo-canvas/releases/tag/v${version}`),
    publishedAt: release.published_at || null,
  };
}

export function createUpdateService({ host, port, apiToken, shutdown } = {}) {
  const currentVersion = currentPackageVersion();
  const runtimeDirectory = path.join(resolveDataDirectory(projectRoot), "runtime");
  const stateFile = path.join(runtimeDirectory, "update-state.json");
  const runner = path.join(packageRoot, "repo-canvas", "scripts", "update-runner.mjs");
  const apiUrl = process.env.NODE_ENV === "test" && process.env.REPO_CANVAS_RELEASE_API_URL
    ? process.env.REPO_CANVAS_RELEASE_API_URL
    : RELEASE_API;
  let candidate = null;
  let checking = null;
  let lastCheckedAt = null;
  let lastError = null;

  function diskState() {
    return readJson(stateFile, {});
  }

  function publicState() {
    const persisted = diskState();
    if (!candidate && persisted.status === "updated" && persisted.toVersion === currentVersion) {
      return {
        currentVersion, status: "updated", availableVersion: null, lastCheckedAt,
        fromVersion: persisted.fromVersion || null, finishedAt: persisted.finishedAt || null,
      };
    }
    if (persisted.status === "applying" && persisted.fromVersion === currentVersion) {
      return { currentVersion, status: "applying", availableVersion: persisted.toVersion, lastCheckedAt };
    }
    if (persisted.status === "failed" && persisted.fromVersion === currentVersion) {
      return {
        currentVersion,
        status: "failed",
        availableVersion: persisted.toVersion || null,
        releaseUrl: candidate?.releaseUrl,
        lastCheckedAt,
        error: String(persisted.error || "Update failed").slice(0, 240),
      };
    }
    if (candidate) {
      return {
        currentVersion,
        status: "available",
        availableVersion: candidate.version,
        releaseUrl: candidate.releaseUrl,
        publishedAt: candidate.publishedAt,
        lastCheckedAt,
      };
    }
    return {
      currentVersion,
      status: lastError ? "check-failed" : "current",
      availableVersion: null,
      lastCheckedAt,
      error: lastError,
    };
  }

  async function check({ force = false } = {}) {
    if (checking) return checking;
    if (!force && lastCheckedAt && Date.now() - Date.parse(lastCheckedAt) < CHECK_INTERVAL_MS) return publicState();
    checking = (async () => {
      try {
        const response = await fetch(apiUrl, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": `repo-canvas/${currentVersion}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`GitHub release check returned HTTP ${response.status}`);
        candidate = releaseCandidate(await response.json(), currentVersion, { allowNonGithub: apiUrl !== RELEASE_API });
        lastError = null;
      } catch (error) {
        lastError = String(error?.message || error).slice(0, 240);
      } finally {
        lastCheckedAt = new Date().toISOString();
        checking = null;
      }
      return publicState();
    })();
    return checking;
  }

  function apply() {
    if (!candidate) throw new Error("No verified Repo Canvas update is available");
    const persisted = diskState();
    if (persisted.status === "applying") throw new Error("A Repo Canvas update is already running");
    const job = {
      schema: 1,
      root: projectRoot,
      runtimeDirectory,
      stateFile,
      currentPointerFile: path.join(runtimeDirectory, "current.json"),
      sourceCli: path.join(packageRoot, "repo-canvas", "scripts", "canvas.mjs"),
      fromVersion: currentVersion,
      release: candidate,
      host,
      port,
      apiToken,
      parentPid: process.pid,
      allowNonGithub: process.env.NODE_ENV === "test" && apiUrl !== RELEASE_API,
    };
    atomicWriteJson(stateFile, {
      status: "applying",
      fromVersion: currentVersion,
      toVersion: candidate.version,
      startedAt: new Date().toISOString(),
    });
    const child = spawn(process.execPath, [runner], {
      cwd: projectRoot,
      env: { ...process.env, REPO_CANVAS_UPDATE_JOB: JSON.stringify(job) },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => {
      atomicWriteJson(stateFile, { status: "failed", fromVersion: currentVersion, toVersion: candidate.version, error: error.message });
    });
    child.once("spawn", () => setTimeout(() => shutdown?.("self-update"), 180).unref());
    child.unref();
    return { ok: true, status: "applying", currentVersion, availableVersion: candidate.version };
  }

  return { check, apply, state: publicState };
}

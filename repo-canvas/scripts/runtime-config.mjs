import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { dataDirectory, projectRoot } from "./canvas-store.mjs";
import { replaceFileSync as replaceFile } from "./atomic-file.mjs";
export { replaceFileSync } from "./atomic-file.mjs";

export const runtimeConfigFile = path.join(dataDirectory, "runtime.json");
export const observerStateFile = path.join(dataDirectory, "observer-state.json");
export const architectStateFile = path.join(dataDirectory, "architect-state.json");
export const apiTokenFile = path.join(dataDirectory, "api-token");

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    replaceFile(temporary, file, { rename: fs.renameSync });
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup after replace */ }
  }
}

function atomicWriteText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
    replaceFile(temporary, file, { rename: fs.renameSync });
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup after replace */ }
  }
}

export function readOrCreateApiToken() {
  try {
    const token = fs.readFileSync(apiTokenFile, "utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error(`Repo Canvas API token is invalid: ${apiTokenFile}`);
    return token;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const token = crypto.randomBytes(32).toString("base64url");
    atomicWriteText(apiTokenFile, `${token}\n`);
    return token;
  }
}

export function readRuntimeConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeConfigFile, "utf8"));
    return {
      enabled: parsed.enabled === true,
      repoRoot: fs.realpathSync.native(parsed.repoRoot || projectRoot),
      providers: Array.isArray(parsed.providers) && parsed.providers.length
        ? [...new Set(parsed.providers.map(String))]
        : [parsed.provider || "codex"],
      pollMs: Math.max(250, Number(parsed.pollMs) || 750),
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { enabled: false, repoRoot: fs.realpathSync.native(projectRoot), providers: ["codex", "claude", "kimi"], pollMs: 750 };
  }
}

export function writeRuntimeConfig(patch) {
  const current = readRuntimeConfig();
  const next = { ...current, ...patch, repoRoot: fs.realpathSync.native(patch.repoRoot || current.repoRoot) };
  atomicWrite(runtimeConfigFile, next);
  return next;
}

export function readObserverState() {
  try {
    return JSON.parse(fs.readFileSync(observerStateFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { version: 3, initializedProviders: [], sessions: {} };
  }
}

export function writeObserverState(state) {
  atomicWrite(observerStateFile, state);
}

export function readArchitectState() {
  try {
    return JSON.parse(fs.readFileSync(architectStateFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return null;
  }
}

export function writeArchitectState(state) {
  atomicWrite(architectStateFile, state);
}

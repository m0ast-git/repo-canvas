import fs from "node:fs";
import path from "node:path";

import { dataDirectory, projectRoot } from "./canvas-store.mjs";

export const runtimeConfigFile = path.join(dataDirectory, "runtime.json");
export const observerStateFile = path.join(dataDirectory, "observer-state.json");

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
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
    return { enabled: false, repoRoot: fs.realpathSync.native(projectRoot), providers: ["codex", "claude", "kimi", "qwen", "grok"], pollMs: 750 };
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
    return { version: 2, initializedProviders: [], sessions: {} };
  }
}

export function writeObserverState(state) {
  atomicWrite(observerStateFile, state);
}

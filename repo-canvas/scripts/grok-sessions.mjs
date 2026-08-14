import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pathBelongsToRoot } from "./codex-sessions.mjs";

export function grokDataRoot() {
  return process.env.REPO_CANVAS_GROK_HOME || path.join(os.homedir(), ".grok");
}

export function listGrokSessionFiles(root = grokDataRoot()) {
  const sessions = path.join(root, "sessions");
  if (!fs.existsSync(sessions)) return [];
  const files = [];
  const pending = [sessions];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name === "chat_history.jsonl") files.push(absolute);
    }
  }
  return files;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

export function readGrokSessionMeta(file) {
  const sessionDirectory = path.dirname(file);
  const context = readJson(path.join(sessionDirectory, "prompt_context.json"));
  const summary = readJson(path.join(sessionDirectory, "summary.json"));
  const cwd = context.working_directory;
  if (!cwd) return null;
  return {
    id: path.basename(sessionDirectory),
    cwd,
    title: summary.generated_title || "",
    model: summary.current_model_id || "grok",
    provider: "grok",
  };
}

export function grokSessionBelongsToRepository(meta, repoRoot) {
  return Boolean(meta?.cwd && pathBelongsToRoot(meta.cwd, repoRoot));
}

function publicText(content) {
  if (typeof content === "string") return content.slice(0, 2_500);
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .slice(0, 2_500);
}

export function grokSessionSignals(record) {
  if (record?.type === "user") {
    if (record.synthetic_reason) return [];
    const text = publicText(record.content);
    if (!text) return [];
    const turnId = `grok-${record.prompt_index ?? Date.now()}`;
    return [
      { kind: "start", turnId },
      { kind: "user", turnId, text },
      { kind: "context", turnId, model: "grok", effort: null },
    ];
  }
  if (record?.type !== "assistant") return [];
  const signals = [];
  const text = publicText(record.content);
  if (text) signals.push({ kind: "agent", text });
  const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
  for (const call of calls) {
    signals.push({
      kind: "tool",
      name: call?.name || "tool",
      input: JSON.stringify(call?.arguments || {}).slice(0, 2_500),
    });
  }
  if (text && calls.length === 0) signals.push({ kind: "complete" });
  return signals;
}

export function grokSessionLocator(meta, firstUserMessage = "") {
  return {
    kind: "grok-cli",
    id: meta.id,
    title: firstUserMessage.slice(0, 160) || meta.title?.slice(0, 160) || "Observed Grok work",
    cwd: meta.cwd,
  };
}

export const grokSessionAdapter = Object.freeze({
  id: "grok",
  listFiles: listGrokSessionFiles,
  readMeta: readGrokSessionMeta,
  belongsToRepository: grokSessionBelongsToRepository,
  signals: grokSessionSignals,
  locator: grokSessionLocator,
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pathBelongsToRoot } from "./codex-sessions.mjs";

export function qwenDataRoot() {
  return process.env.REPO_CANVAS_QWEN_HOME || path.join(os.homedir(), ".qwen");
}

export function listQwenSessionFiles(root = qwenDataRoot()) {
  const projects = path.join(root, "projects");
  if (!fs.existsSync(projects)) return [];
  const files = [];
  for (const project of fs.readdirSync(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const chats = path.join(projects, project.name, "chats");
    if (!fs.existsSync(chats)) continue;
    for (const entry of fs.readdirSync(chats, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(chats, entry.name));
    }
  }
  return files;
}

function firstRecords(file, maxBytes = 256 * 1024) {
  const descriptor = fs.openSync(file, "r");
  try {
    const size = Math.min(fs.fstatSync(descriptor).size, maxBytes);
    const buffer = Buffer.alloc(size);
    fs.readSync(descriptor, buffer, 0, size, 0);
    return buffer.toString("utf8").split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readQwenSessionMeta(file) {
  for (const record of firstRecords(file)) {
    if (!record?.sessionId || !record?.cwd) continue;
    return { id: record.sessionId, cwd: record.cwd, provider: "qwen", model: record.model || "qwen" };
  }
  return null;
}

export function qwenSessionBelongsToRepository(meta, repoRoot) {
  return Boolean(meta?.cwd && pathBelongsToRoot(meta.cwd, repoRoot));
}

function textParts(parts, { includeThought = false } = {}) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => typeof part?.text === "string" && (includeThought || part.thought !== true))
    .map((part) => part.text)
    .join("\n")
    .slice(0, 2_500);
}

export function qwenSessionSignals(record) {
  if (record?.type === "user" && record.subtype !== "notification") {
    const text = textParts(record.message?.parts);
    if (!text) return [];
    const turnId = record.uuid || record.parentUuid || `qwen-${record.timestamp || Date.now()}`;
    return [
      { kind: "start", turnId, at: record.timestamp },
      { kind: "user", turnId, text, at: record.timestamp },
      { kind: "context", turnId, model: record.model || "qwen", effort: null, cwd: record.cwd },
    ];
  }
  if (record?.type !== "assistant") return [];
  const parts = Array.isArray(record.message?.parts) ? record.message.parts : [];
  const signals = [];
  const text = textParts(parts);
  if (text) signals.push({ kind: "agent", text, at: record.timestamp });
  const calls = parts.map((part) => part?.functionCall).filter(Boolean);
  for (const call of calls) {
    signals.push({
      kind: "tool",
      name: call.name || "tool",
      input: JSON.stringify(call.args || call.arguments || {}).slice(0, 2_500),
      at: record.timestamp,
    });
  }
  if (text && calls.length === 0) signals.push({ kind: "complete", at: record.timestamp });
  return signals;
}

export function qwenSessionLocator(meta, firstUserMessage = "") {
  return {
    kind: "qwen-cli",
    id: meta.id,
    title: firstUserMessage.slice(0, 160) || "Observed Qwen work",
    cwd: meta.cwd,
  };
}

export const qwenSessionAdapter = Object.freeze({
  id: "qwen",
  listFiles: listQwenSessionFiles,
  readMeta: readQwenSessionMeta,
  belongsToRepository: qwenSessionBelongsToRepository,
  signals: qwenSessionSignals,
  locator: qwenSessionLocator,
});

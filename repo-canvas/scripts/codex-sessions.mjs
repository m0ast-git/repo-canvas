import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function codexSessionsRoot() {
  return process.env.REPO_CANVAS_CODEX_SESSIONS || path.join(os.homedir(), ".codex", "sessions");
}

export function listCodexSessionFiles(root = codexSessionsRoot()) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) files.push(absolute);
    }
  }
  return files;
}

export function readSessionMeta(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const chunks = [];
    let position = 0;
    let newline = -1;
    while (position < 4 * 1024 * 1024 && newline < 0) {
      const buffer = Buffer.alloc(64 * 1024);
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (!bytes) break;
      const chunk = buffer.subarray(0, bytes);
      chunks.push(chunk);
      const localNewline = chunk.indexOf(0x0a);
      if (localNewline >= 0) newline = position + localNewline;
      position += bytes;
    }
    const content = Buffer.concat(chunks);
    const line = content.subarray(0, newline >= 0 ? newline : content.length).toString("utf8").replace(/\r$/, "");
    const record = JSON.parse(line);
    if (record.type !== "session_meta") return null;
    return record.payload || null;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readAppendedRecords(file, offset = 0, options = {}) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, Math.min(Number.isInteger(offset) ? offset : 0, size));
  const maxBytes = positiveInteger(options.maxBytes, 4 * 1024 * 1024, "maxBytes");
  const maxRecordBytes = positiveInteger(options.maxRecordBytes, 1024 * 1024, "maxRecordBytes");
  const maxRecords = positiveInteger(options.maxRecords, 1_000, "maxRecords");
  if (maxBytes < maxRecordBytes) throw new Error("maxBytes must be greater than or equal to maxRecordBytes");
  if (size <= start) {
    return {
      records: [], offset: size, bytesRead: 0, skippedOversizedRecords: 0,
      discardingOversizedRecord: Boolean(options.discardingOversizedRecord),
    };
  }

  const length = Math.min(size - start, maxBytes);
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, start);
    const records = [];
    let lineStart = 0;
    let consumed = 0;
    let linesSeen = 0;
    let skippedOversizedRecords = 0;
    let discardingOversizedRecord = Boolean(options.discardingOversizedRecord);

    if (discardingOversizedRecord) {
      const newline = buffer.indexOf(0x0a, 0);
      if (newline < 0) {
        return {
          records, offset: start + bytesRead, bytesRead, skippedOversizedRecords,
          discardingOversizedRecord: true,
        };
      }
      lineStart = newline + 1;
      consumed = lineStart;
      discardingOversizedRecord = false;
    }

    while (linesSeen < maxRecords) {
      const newline = buffer.indexOf(0x0a, lineStart);
      if (newline < 0) break;
      let lineEnd = newline;
      if (lineEnd > lineStart && buffer[lineEnd - 1] === 0x0d) lineEnd -= 1;
      const lineLength = lineEnd - lineStart;
      if (lineLength > maxRecordBytes) {
        skippedOversizedRecords += 1;
      } else if (lineLength > 0) {
        try { records.push(JSON.parse(buffer.subarray(lineStart, lineEnd).toString("utf8"))); }
        catch { /* malformed complete records are ignored, matching the previous parser */ }
      }
      linesSeen += 1;
      lineStart = newline + 1;
      consumed = lineStart;
    }

    if (linesSeen < maxRecords && bytesRead - lineStart > maxRecordBytes) {
      skippedOversizedRecords += 1;
      consumed = bytesRead;
      discardingOversizedRecord = true;
    }

    return {
      records, offset: start + consumed, bytesRead, skippedOversizedRecords, discardingOversizedRecord,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function positiveInteger(value, fallback, label) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function canonical(value) {
  if (!value) return "";
  try { return fs.realpathSync.native(path.resolve(value)); } catch { return path.resolve(value); }
}

function comparable(value) {
  const normalized = canonical(value).replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathBelongsToRoot(candidate, root) {
  const child = comparable(candidate);
  const parent = comparable(root);
  return child === parent || child.startsWith(`${parent}/`);
}

function gitCommonDirectory(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd, encoding: "utf8", timeout: 3_000, windowsHide: true,
  });
  return result.status === 0 ? comparable(result.stdout.trim()) : null;
}

export function sessionBelongsToRepository(meta, repoRoot, cache = new Map()) {
  if (!meta?.cwd || ["codex_sdk_ts", "repo_canvas"].includes(meta.originator) || meta.env?.REPO_CANVAS_INTERNAL_SESSION === "1") return false;
  if (pathBelongsToRoot(meta.cwd, repoRoot)) return true;
  const rootKey = `root:${repoRoot}`;
  const cwdKey = `cwd:${meta.cwd}`;
  if (!cache.has(rootKey)) cache.set(rootKey, gitCommonDirectory(repoRoot));
  if (!cache.has(cwdKey)) cache.set(cwdKey, gitCommonDirectory(meta.cwd));
  return Boolean(cache.get(rootKey) && cache.get(rootKey) === cache.get(cwdKey));
}

function shortText(value, max = 2_500) {
  if (typeof value === "string") return value.slice(0, max);
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : item?.text || "").join("\n").slice(0, max);
  if (value && typeof value === "object") return JSON.stringify(value).slice(0, max);
  return "";
}

export function sessionSignals(record) {
  const payload = record?.payload || {};
  if (record?.type === "session_meta") return [{ kind: "session", meta: payload }];
  if (record?.type === "turn_context") return [{ kind: "context", model: payload.model, effort: payload.effort, cwd: payload.cwd }];
  if (record?.type === "event_msg") {
    if (payload.type === "task_started") return [{ kind: "start", turnId: payload.turn_id, at: payload.started_at }];
    if (payload.type === "user_message") return [{ kind: "user", text: shortText(payload.message), at: record.timestamp }];
    if (payload.type === "agent_message") return [{ kind: "agent", text: shortText(payload.message), phase: payload.phase, at: record.timestamp }];
    if (payload.type === "task_complete") return [{ kind: "complete", turnId: payload.turn_id, at: payload.completed_at || record.timestamp }];
    if (payload.type === "turn_aborted") return [{ kind: "aborted", turnId: payload.turn_id, reason: payload.reason, at: payload.completed_at || record.timestamp }];
    return [];
  }
  if (record?.type === "response_item") {
    if (["function_call", "custom_tool_call"].includes(payload.type)) {
      return [{ kind: "tool", name: payload.name || "tool", input: shortText(payload.arguments || payload.input), at: record.timestamp }];
    }
  }
  return [];
}

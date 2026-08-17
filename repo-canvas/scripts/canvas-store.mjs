import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateEvent, validateEventSequence } from "./canvas-schema.mjs";
import { packageRoot, projectRoot, resolveDataDirectory } from "./project-root.mjs";

export { packageRoot, projectRoot };
export const dataDirectory = resolveDataDirectory(projectRoot);
export const eventsFile = path.join(dataDirectory, "events.jsonl");
export const lockFile = path.join(dataDirectory, "events.lock");

const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function ensureStoreUnlocked() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  if (!fs.existsSync(eventsFile)) fs.writeFileSync(eventsFile, "", { encoding: "utf8", mode: 0o600 });
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function reclaimStaleLock() {
  try {
    const stats = fs.statSync(lockFile);
    if (Date.now() - stats.mtimeMs < STALE_LOCK_MS) return false;
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    } catch {
      // An old unreadable lock has no verifiable live owner.
    }
    if (owner?.pid && processIsAlive(Number(owner.pid))) return false;
    fs.unlinkSync(lockFile);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
}

function acquireStoreLock(timeoutMs = LOCK_TIMEOUT_MS) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const startedAt = Date.now();

  while (true) {
    try {
      const descriptor = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
      fs.fsyncSync(descriptor);
      return descriptor;
    } catch (error) {
      const contention = new Set(["EEXIST", "EACCES", "EPERM"]).has(error.code);
      if (!contention) throw error;
      if (reclaimStaleLock()) continue;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for Repo Canvas store lock: ${lockFile}`);
      }
      Atomics.wait(sleeper, 0, 0, 20);
    }
  }
}

function withStoreLock(operation) {
  const descriptor = acquireStoreLock();
  try {
    ensureStoreUnlocked();
    return operation();
  } finally {
    try {
      fs.closeSync(descriptor);
    } finally {
      try {
        fs.unlinkSync(lockFile);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

export function ensureStore() {
  withStoreLock(() => undefined);
}

export function createEvent(type, { actor = "unknown", payload = {} } = {}) {
  return {
    v: 1,
    id: `evt_${crypto.randomUUID()}`,
    ts: new Date().toISOString(),
    type,
    actor,
    payload,
  };
}

export function appendEvent(event, { expectedRevision = null } = {}) {
  const validation = validateEvent(event);
  if (validation.length) throw new Error(`Invalid event: ${validation.join("; ")}`);

  return withStoreLock(() => {
    const current = parseStoreContent(fs.readFileSync(eventsFile, "utf8"));
    const errors = [...current.parseErrors, ...current.validationErrors];
    if (errors.length) throw new Error("Cannot append while the Repo Canvas store is invalid; run check and repair first");
    if (expectedRevision !== null && current.events.length !== expectedRevision) {
        const error = new Error(`Canvas changed from revision ${expectedRevision} to ${current.events.length}`);
        error.code = "STALE_REVISION";
        error.currentRevision = current.events.length;
        throw error;
    }
    const candidate = [...current.events, event].map((item, index) => ({ event: item, line: index + 1 }));
    const candidateErrors = validateEventSequence(candidate).filter((error) => error.line === candidate.length);
    if (candidateErrors.length) throw new Error(`Invalid event sequence: ${candidateErrors.map((error) => error.message).join("; ")}`);
    const descriptor = fs.openSync(eventsFile, "a", 0o600);
    try {
      fs.writeSync(descriptor, `${JSON.stringify(event)}\n`, null, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return event;
  });
}

export function appendEvents(events, { expectedRevision = null } = {}) {
  if (!Array.isArray(events) || events.length === 0) throw new Error("events must be a non-empty array");
  for (const event of events) {
    const validation = validateEvent(event);
    if (validation.length) throw new Error(`Invalid event: ${validation.join("; ")}`);
  }

  return withStoreLock(() => {
    const current = parseStoreContent(fs.readFileSync(eventsFile, "utf8"));
    const errors = [...current.parseErrors, ...current.validationErrors];
    if (errors.length) throw new Error("Cannot append while the Repo Canvas store is invalid; run check and repair first");
    if (expectedRevision !== null && current.events.length !== expectedRevision) {
      const error = new Error(`Canvas changed from revision ${expectedRevision} to ${current.events.length}`);
      error.code = "STALE_REVISION";
      error.currentRevision = current.events.length;
      throw error;
    }
    const candidate = [...current.events, ...events].map((item, index) => ({ event: item, line: index + 1 }));
    const firstNewLine = current.events.length + 1;
    const candidateErrors = validateEventSequence(candidate).filter((error) => error.line >= firstNewLine);
    if (candidateErrors.length) throw new Error(`Invalid event sequence: ${candidateErrors.map((error) => error.message).join("; ")}`);
    const descriptor = fs.openSync(eventsFile, "a", 0o600);
    try {
      fs.writeSync(descriptor, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, null, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return events;
  });
}

function parseStoreContent(content) {
  const lines = content.split(/\r?\n/);
  const parsed = [];
  const parseErrors = [];
  const validationErrors = [];

  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const lineNumber = index + 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      parseErrors.push({ line: lineNumber, kind: "parse", message: error.message });
      return;
    }

    const errors = validateEvent(event);
    if (errors.length) {
      for (const message of errors) {
        validationErrors.push({ line: lineNumber, id: event?.id || null, kind: "schema", message });
      }
      return;
    }
    parsed.push({ event, line: lineNumber });
  });

  validationErrors.push(...validateEventSequence(parsed).map((error) => ({ ...error, kind: "sequence" })));
  const badLines = new Set(validationErrors.map((error) => error.line));
  const events = parsed.filter(({ line }) => !badLines.has(line)).map(({ event }) => event);
  return { lines, events, parseErrors, validationErrors };
}

export function readEvents() {
  return withStoreLock(() => {
    const result = parseStoreContent(fs.readFileSync(eventsFile, "utf8"));
    return {
      events: result.events,
      errors: [...result.parseErrors, ...result.validationErrors],
      parseErrors: result.parseErrors,
      validationErrors: result.validationErrors,
    };
  });
}

function timestampSlug() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export function repairStore({ apply = false } = {}) {
  return withStoreLock(() => {
    const original = fs.readFileSync(eventsFile, "utf8");
    const parsed = parseStoreContent(original);
    const rejectedLines = new Set(parsed.parseErrors.map((error) => error.line));
    const preview = {
      applied: false,
      parseErrors: parsed.parseErrors,
      validationErrors: parsed.validationErrors,
      removableLines: [...rejectedLines],
      backupFile: null,
      rejectedFile: null,
    };

    if (!apply || rejectedLines.size === 0) return preview;

    const slug = timestampSlug();
    const backupFile = path.join(dataDirectory, `events.backup-${slug}.jsonl`);
    const rejectedFile = path.join(dataDirectory, `events.rejected-${slug}.jsonl`);
    const temporaryFile = path.join(dataDirectory, `.events.repair-${process.pid}-${crypto.randomUUID()}.tmp`);
    const kept = [];
    const rejected = [];
    parsed.lines.forEach((line, index) => {
      if (!line.trim()) return;
      (rejectedLines.has(index + 1) ? rejected : kept).push(line);
    });

    fs.writeFileSync(backupFile, original, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.writeFileSync(rejectedFile, `${rejected.join("\n")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.writeFileSync(temporaryFile, kept.length ? `${kept.join("\n")}\n` : "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporaryFile, eventsFile);

    return { ...preview, applied: true, backupFile, rejectedFile };
  });
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function activityLabel(event) {
  const payload = event.payload || {};
  if (event.type === "map.upsert") return `Project map ${payload.projectTitle || "updated"}`;
  if (event.type === "activity.log") return payload.message || "Activity recorded";
  if (event.type === "area.upsert") return `Area ${payload.ownerTitle || payload.title || payload.id} updated`;
  if (event.type === "area.remove") return `Area ${payload.id} removed: ${payload.reason || "no longer exists"}`;
  if (event.type === "entity.upsert") return `${payload.ownerLabel || payload.label || payload.id} → ${payload.status || "updated"}`;
  if (event.type === "entity.remove") return `Entity ${payload.id} removed: ${payload.reason || "no longer exists"}`;
  if (event.type === "relation.upsert") return `Relation ${payload.from} → ${payload.to}`;
  if (event.type === "relation.remove") return `Relation ${payload.id} removed`;
  if (event.type === "work.upsert") return `Work ${payload.title || payload.id} → ${payload.status || "updated"}`;
  return event.type;
}

export function reduceEvents(events, errors = []) {
  let map = null;
  const areas = new Map();
  const entities = new Map();
  const relations = new Map();
  const work = new Map();
  const activity = [];

  for (const event of events) {
    const payload = event.payload || {};

    if (event.type === "map.upsert") {
      map = { ...(map || {}), ...payload, actor: event.actor, updatedAt: event.ts };
    }

    if (event.type === "area.upsert") {
      const id = String(payload.id);
      areas.set(id, { ...(areas.get(id) || {}), ...payload, id, actor: event.actor, updatedAt: event.ts });
    }

    if (event.type === "area.remove") {
      const id = String(payload.id);
      const removedEntityIds = [];
      areas.delete(id);
      for (const [entityId, entity] of entities) {
        if (entity.areaId === id) {
          entities.delete(entityId);
          removedEntityIds.push(entityId);
        }
      }
      for (const [relationId, relation] of relations) {
        if (removedEntityIds.includes(relation.from) || removedEntityIds.includes(relation.to)) relations.delete(relationId);
      }
    }

    if (event.type === "entity.upsert") {
      const id = String(payload.id);
      entities.set(id, { ...(entities.get(id) || {}), ...payload, id, actor: event.actor, updatedAt: event.ts });
    }

    if (event.type === "entity.remove") {
      const id = String(payload.id);
      entities.delete(id);
      for (const [relationId, relation] of relations) {
        if (relation.from === id || relation.to === id) relations.delete(relationId);
      }
    }

    if (event.type === "relation.upsert") {
      const id = String(payload.id || `${payload.from}->${payload.to}`);
      relations.set(id, { ...(relations.get(id) || {}), ...payload, id, actor: event.actor, updatedAt: event.ts });
    }

    if (event.type === "relation.remove") relations.delete(String(payload.id));

    if (event.type === "work.upsert") {
      const id = String(payload.id);
      work.set(id, { ...(work.get(id) || {}), ...payload, id, actor: event.actor, updatedAt: event.ts });
    }

    activity.push({
      id: event.id,
      ts: event.ts,
      actor: event.actor,
      type: event.type,
      level: payload.level || "info",
      message: activityLabel(event),
    });
  }

  const areaList = [...areas.values()].sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || naturalCompare(a.title, b.title));
  const entityList = [...entities.values()].sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || naturalCompare(a.label, b.label));
  const relationList = [...relations.values()];
  const entityIds = new Set(entityList.map((entity) => entity.id));
  const workList = [...work.values()].map((item) => ({
    ...item,
    targets: (item.targets || []).filter((id) => entityIds.has(id)),
  })).sort((a, b) => naturalCompare(a.title, b.title));
  const activeWork = workList.filter((item) => ["active", "blocked", "planned"].includes(item.status));
  const activeEntityIds = [...new Set(activeWork.filter((item) => item.status === "active").flatMap((item) => item.targets || []))];

  return {
    revision: events.length,
    updatedAt: events.at(-1)?.ts || null,
    parseErrors: errors.filter((error) => error.kind === "parse"),
    validationErrors: errors.filter((error) => error.kind !== "parse"),
    storeErrors: errors,
    map: map || {
      projectTitle: projectRoot.split(/[\\/]/).filter(Boolean).at(-1) || "Project",
      projectSummary: "",
      layoutIntent: "domain",
      layoutDirection: "AUTO",
      keyFlows: [],
      unresolvedQuestions: [],
    },
    areas: areaList,
    entities: entityList,
    relations: relationList,
    work: workList,
    activeEntityIds,
    semantic: areaList.length > 0 || entityList.length > 0,
    activity: activity.slice(-80).reverse(),
    summary: {
      areaCount: areaList.length,
      entityCount: entityList.length,
      activeWork: activeWork.filter((item) => item.status === "active").length,
      agents: [...new Set(events.map((event) => event.actor).filter(Boolean))],
    },
  };
}

let snapshotCache = null;

export function getSnapshot() {
  ensureStoreUnlocked();
  const stat = fs.statSync(eventsFile);
  const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (snapshotCache?.signature === signature) return snapshotCache.value;
  const { events, errors } = readEvents();
  const value = reduceEvents(events, errors);
  snapshotCache = { signature, value };
  return value;
}

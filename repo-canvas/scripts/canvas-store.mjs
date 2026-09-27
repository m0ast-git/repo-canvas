import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { journalState, cacheAppended, cachedSnapshot } from "./journal-cache.mjs";
import { reduceEvents } from "./snapshot-reducer.mjs";
export { reduceEvents } from "./snapshot-reducer.mjs";
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
  // Another reader may create and fill the journal between the existence check and open.
  if(!fs.existsSync(eventsFile)) {
    try { fs.writeFileSync(eventsFile, "", { encoding:"utf8", mode:0o600, flag:"wx" }); }
    catch(error) { if(error.code!=="EEXIST")throw error; }
  }
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
  let descriptor;
  try {
    descriptor=fs.openSync(lockFile,"r");
    const stats = fs.fstatSync(descriptor);
    if (Date.now() - stats.mtimeMs < STALE_LOCK_MS) return false;
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    } catch {
      // An old unreadable lock has no verifiable live owner.
    }
    if (owner?.pid && processIsAlive(Number(owner.pid))) return false;
    // Another writer may already have replaced the abandoned lock. Never read
    // its not-yet-written owner as an abandoned lock, or remove its fresh file.
    const current=fs.statSync(lockFile);
    if(current.ino!==stats.ino||current.birthtimeMs!==stats.birthtimeMs||current.mtimeMs!==stats.mtimeMs)return false;
    fs.unlinkSync(lockFile);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  } finally {if(descriptor!==undefined)fs.closeSync(descriptor);}
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

export function appendEvent(event,options={}) {
  appendEvents([event],options);return event;
}

function contentKey(value) {
  if (Array.isArray(value)) return value.map(contentKey);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => !["_checkpoint", "updatedAt", "actor"].includes(key) && value[key] !== undefined).map(key => [key, contentKey(value[key])]));
}

export function sameWorkContent(previous, payload) {
  return Boolean(previous) && JSON.stringify(contentKey(previous)) === JSON.stringify(contentKey({...previous, ...payload}));
}

export function appendEvents(events, { expectedRevision = null } = {}) {
  if (!Array.isArray(events) || events.length === 0) throw new Error("events must be a non-empty array");
  for (const event of events) {
    const validation = validateEvent(event);
    if (validation.length) throw new Error(`Invalid event: ${validation.join("; ")}`);
  }

  return withStoreLock(() => {
    const current=journalState();
    const revision=current.value.revision;
    if(current.value.storeErrors.length)throw new Error("Cannot append while the Repo Canvas store is invalid; run check and repair first");
    if(expectedRevision!==null && revision!==expectedRevision) {
      const error=new Error(`Canvas changed from revision ${expectedRevision} to ${revision}`);error.code="STALE_REVISION";error.currentRevision=revision;throw error;
    }
    const currentWork = new Map((current.raw._rawWork || current.raw.work || []).map(item => [item.id, item]));
    let workBoundary = false;
    events = events.filter(event => {
      if (event.type !== "work.upsert") return true;
      const previous = currentWork.get(event.payload.id);
      if (sameWorkContent(previous, event.payload)) return false;
      workBoundary ||= !previous || previous.status !== event.payload.status;
      currentWork.set(event.payload.id, {...previous, ...event.payload});
      return true;
    });
    if (!events.length) return [];
    const candidate=events.map((event,index)=>({event,line:current.lines+index+1}));
    const candidateErrors=validateEventSequence(candidate,current.raw,current.ids);
    if(candidateErrors.length)throw new Error(`Invalid event sequence: ${candidateErrors.map(error=>error.message).join("; ")}`);
    if (workBoundary || events.some(event => event.actor==="owner" || !["work.upsert", "activity.log"].includes(event.type) || event.payload.checkpoint)) {
      const last=events.at(-1);
      const work=events.find(event=>event.type==="work.upsert");const map=events.find(event=>event.type==="map.upsert");const verified=events.find(event=>event.payload.verification?.code);const code=verified?.payload.verification.code;
      const category=events.some(event=>event.payload.ownerCorrection)?"decision":map?"map":work?.payload.session?"session":events.every(event=>event.type==="activity.log")?"activity":"map";
      last.payload={...last.payload,_checkpoint:{id:"cp-"+last.id,firstRevision:revision+1,revision:revision+events.length,kind:category,recordedAt:last.ts,...(map?{title:map.payload.projectTitle||"Устройство проекта обновлено"}:{}),...(work?{sessionId:work.payload.session?.id,workId:work.payload.id,title:work.payload.title}:{}),...(code?{branch:code.branch,commit:code.commit,workingTree:Boolean(code.dirty),verification:verified.payload.verification.state}:{}),...(events.find(event=>event.payload.checkpoint)?.payload.checkpoint||{})}};
    }
    let separator="";
    const size=fs.statSync(eventsFile).size;
    if(size) {const input=fs.openSync(eventsFile,"r");const tail=Buffer.alloc(1);try{fs.readSync(input,tail,0,1,size-1);}finally{fs.closeSync(input);}if(tail[0]!==10)separator="\n";}
    const descriptor=fs.openSync(eventsFile,"a",0o600);
    try {
      const bytes=Buffer.from(separator+events.map(event=>JSON.stringify(event)).join("\n")+"\n");let written=0;
      while(written<bytes.length)written+=fs.writeSync(descriptor,bytes,written,bytes.length-written);
      fs.fsyncSync(descriptor);
    }finally{fs.closeSync(descriptor);}
    cacheAppended(events);
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


export function getSnapshot() {
  ensureStoreUnlocked();
  const cached=cachedSnapshot();if(cached)return cached;
  return withStoreLock(()=>journalState().value);
}

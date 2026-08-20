import fs from "node:fs";
import path from "node:path";

import { appendEvent, createEvent, getSnapshot } from "./canvas-store.mjs";
import { readAppendedRecords } from "./codex-sessions.mjs";
import { runCodexStructured } from "./model-runtime.mjs";
import { OBSERVER_OUTPUT_SCHEMA, applyObserverDecision } from "./semantic-model.mjs";
import { readObserverState, readRuntimeConfig, writeObserverState } from "./runtime-config.mjs";
import { sessionAdapter, sessionAdapters } from "./session-adapters.mjs";

const MAX_EVENTS = 80;
const INITIAL_DEADLINE_MS = 5_000;
const UPDATE_INTERVAL_MS = 30_000;
const DISCOVERY_INTERVAL_MS = 2_000;
const ERROR_DEDUPE_MS = 60_000;
export const STALE_TURN_MS = 15 * 60_000;

export function compactSessionMeta(meta = {}) {
  const compact = {};
  for (const key of ["id", "session_id", "cwd", "originator", "provider", "entrypoint", "promptSource", "thread_source", "forked_from_id", "parent_thread_id", "timestamp", "recordTimestamp"]) {
    if (["string", "number", "boolean"].includes(typeof meta[key])) compact[key] = meta[key];
  }
  if (typeof meta.title === "string") compact.title = meta.title.slice(0, 160);
  if (meta.env?.REPO_CANVAS_INTERNAL_SESSION === "1") compact.env = { REPO_CANVAS_INTERNAL_SESSION: "1" };
  return compact;
}

export function compactObserverState(state = {}) {
  const sessions = {};
  for (const [file, session] of Object.entries(state.sessions || {})) {
    const turns = Object.values(session.turns || {}).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const keptTurns = [...turns.filter((turn) => !turn.finished), ...turns.filter((turn) => turn.finished).slice(0, 24)];
    const { scanSucceeded: _scanSucceeded, ...persistentSession } = session;
    sessions[file] = {
      ...persistentSession,
      meta: compactSessionMeta(session.meta),
      turns: Object.fromEntries(keptTurns.map((turn) => [turn.turnId, turn])),
    };
  }
  return {
    version: 4,
    initializedProviders: [...new Set(state.initializedProviders || [])],
    sessions,
    ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
  };
}

function workId(sessionId, turnId) {
  const safeSession = String(sessionId || "session").replace(/^019f/i, "").slice(-20).replace(/[^A-Za-z0-9.-]/g, "-");
  const safeTurn = String(turnId || Date.now()).slice(-20).replace(/[^A-Za-z0-9.-]/g, "-");
  return `observed-${safeSession}-${safeTurn}`.slice(0, 128);
}

function compactMap(snapshot) {
  return {
    map: { projectTitle: snapshot.map?.projectTitle, projectSummary: snapshot.map?.projectSummary, language: snapshot.map?.language, keyFlows: snapshot.map?.keyFlows || [] },
    areas: snapshot.areas.map(({ id, title, note, ownerTitle, ownerNote }) => ({ id, title, note, ownerTitle, ownerNote })),
    entities: snapshot.entities.map(({ id, areaId, parentId, label, kind, status, purpose, evidence, ownerLabel, ownerPurpose }) => ({ id, areaId, parentId, label, kind, status, purpose, evidence, ownerLabel, ownerPurpose })),
    relations: snapshot.relations.map(({ id, from, to, label, kind, contract, mechanism, status, ownerLabel }) => ({ id, from, to, label, kind, contract, mechanism, status, ownerLabel })),
  };
}

export function observerPrompt({ turn, final, snapshot }) {
  return `You are Repo Canvas Observer, a silent semantic stenographer. Interpret one coding-agent turn and update an existing high-level project map.

You never inspect the repository, never write code, never answer the owner and never invent explanations. Use only supplied public session events and the current evidence-backed semantic map. Hidden reasoning is unavailable and irrelevant.

Rules:
- use the language of the owner's current request for every human-visible work title, summary and new map label; if the request has no usable language signal, follow the current map;
- prefer plain owner-facing domain language and preserve established project vocabulary; keep code identifiers and protocols in technical fields rather than unexplained visible jargon;
- describe the concrete work in a short title and summary;
- attach work to every existing semantic entity it genuinely affects;
- target the most specific confirmed entity; the UI rolls activity up to visible parents and areas;
- never attach work to a kind=person participant; target the project-owned capability, interface, module, service or other part being changed;
- during active work, create a planned entity or relation only when the owner or working agent explicitly establishes the new concept, responsibility and endpoints;
- at completion, update passports and relations only when public session evidence establishes the architectural effect;
- keep the Architect's entity kinds, parent hierarchy and relation grammar;
- every new relation label must be a specific directional verb plus object; include the contract, mechanism and public-session evidence available;
- removing a file is not enough to remove an entity;
- remove an entity only when the session establishes that the concept itself was eliminated or merged away;
- rename, move or reimplementation keeps the stable entity id;
- if evidence is insufficient, leave architecture unchanged;
- for a final successful turn use done; for abort use stopped; otherwise active or blocked;
- return required structured output only.

Final checkpoint: ${final ? "yes" : "no"}
Session: ${JSON.stringify({ id: turn.sessionId, model: turn.model, effort: turn.effort })}
Current work: ${JSON.stringify({ request: turn.userMessage, title: turn.title, summary: turn.summary, targets: turn.targets })}
Current semantic map: ${JSON.stringify(compactMap(snapshot))}
New public events: ${JSON.stringify(turn.events)}`;
}

function provisionalCopy(language = "", text = "") {
  const russian = /[А-Яа-яЁё]/.test(text) || /^ru(?:-|$)/i.test(language);
  return russian
    ? { title: "Новая работа", note: "Агент осмысливает задачу" }
    : { title: "New work", note: "The agent is interpreting the request" };
}

function provisionalWork(turn, meta, adapter, language = "") {
  const copy = provisionalCopy(language, turn.userMessage);
  appendEvent(createEvent("work.upsert", {
    actor: "observer",
    payload: {
      id: turn.workId,
      title: copy.title,
      status: "active",
      targets: [],
      note: copy.note,
      provisional: true,
      session: adapter.locator(meta),
    },
  }));
}

function activityError(message) {
  appendEvent(createEvent("activity.log", { actor: "observer", payload: { message, level: "warning" } }));
}

function staleWorkCopy(...values) {
  const russian = /[А-Яа-яЁё]/.test(values.filter(Boolean).join(" "));
  return russian
    ? { title: "Работа без свежего сигнала", note: "Сессия не подтверждала активность более 15 минут" }
    : { title: "Work without a fresh signal", note: "The session has not confirmed activity for more than 15 minutes" };
}

function forkBoundary(meta = {}) {
  const value = meta.recordTimestamp || meta.timestamp;
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function isForkedSession(session) {
  const meta = session?.meta || {};
  return meta.thread_source === "subagent" || Boolean(meta.parent_thread_id || meta.forked_from_id);
}

function parentSessionId(session) {
  const meta = session?.meta || {};
  return meta.parent_thread_id || (meta.session_id && meta.session_id !== meta.id ? meta.session_id : "");
}

export class CodexObserver {
  constructor({
    config = readRuntimeConfig(),
    state = readObserverState(),
    runner = runCodexStructured,
    now = () => Date.now(),
    sessionsRoot,
    adapters,
    replay = false,
    writeState = writeObserverState,
    discoveryIntervalMs = DISCOVERY_INTERVAL_MS,
  } = {}) {
    this.config = config;
    const compacted = compactObserverState(state);
    this.state = compacted;
    this.runner = runner;
    this.now = now;
    this.sessionsRoot = sessionsRoot;
    const configured = config.providers || (config.provider ? [config.provider] : ["codex", "claude", "kimi"]);
    this.adapters = adapters || (sessionsRoot ? [sessionAdapter("codex")] : sessionAdapters(configured));
    this.replay = replay;
    this.writeState = writeState;
    this.discoveryIntervalMs = discoveryIntervalMs;
    this.gitCache = new Map();
    this.running = new Map();
    this.lastDiscoveryAt = Number.NEGATIVE_INFINITY;
    this.dirty = JSON.stringify(compacted) !== JSON.stringify(state);
    this.errorTimes = new Map();
  }

  markDirty() { this.dirty = true; }

  reportError(message, key = message) {
    const last = this.errorTimes.get(key) || Number.NEGATIVE_INFINITY;
    if (this.now() - last < ERROR_DEDUPE_MS) return;
    this.errorTimes.set(key, this.now());
    activityError(message);
  }

  ensureSession(file, meta, adapter, baseline = false) {
    const key = path.resolve(file);
    let session = this.state.sessions[key];
    if (!session) {
      session = {
        offset: this.replay || !baseline ? 0 : fs.statSync(file).size,
        relevant: false,
        provider: adapter.id,
        meta: compactSessionMeta(meta),
        metaFormat: 1,
        turns: {},
      };
      this.state.sessions[key] = session;
      this.markDirty();
    }
    return session;
  }

  discover() {
    this.state.initializedProviders ||= [];
    for (const adapter of this.adapters) {
      const providerKnown = this.state.initializedProviders.includes(adapter.id)
        || Object.values(this.state.sessions).some((session) => (session.provider || "codex") === adapter.id);
      const baseline = !providerKnown;
      const root = adapter.id === "codex" ? this.sessionsRoot : undefined;
      for (const file of adapter.listFiles(root)) {
        const known = this.state.sessions[path.resolve(file)];
        let meta;
        try { meta = known?.metaFormat === 1 ? known.meta : adapter.readMeta(file, root); } catch { continue; }
        if (!meta) continue;
        const session = this.ensureSession(file, meta, adapter, baseline);
        if (session.metaFormat !== 1 || JSON.stringify(session.meta) !== JSON.stringify(compactSessionMeta(meta))) {
          session.meta = compactSessionMeta(meta);
          session.metaFormat = 1;
          this.markDirty();
        }
        const relevant = adapter.belongsToRepository(meta, this.config.repoRoot, this.gitCache);
        if (session.provider !== adapter.id || session.relevant !== relevant) this.markDirty();
        session.provider = adapter.id;
        session.relevant = relevant;
      }
      if (!this.state.initializedProviders.includes(adapter.id)) {
        this.state.initializedProviders.push(adapter.id);
        this.markDirty();
      }
    }
  }

  currentTurn(session, turnId) {
    if (turnId && session.turns[turnId]) return session.turns[turnId];
    return Object.values(session.turns).filter((turn) => !turn.finished).sort((a, b) => b.startedAt - a.startedAt)[0] || null;
  }

  parentTurnIds(session) {
    const id = parentSessionId(session);
    if (!id) return new Set();
    const parent = Object.values(this.state.sessions).find((candidate) => {
      const meta = candidate.meta || {};
      return meta.id === id || (meta.session_id === id && meta.id === meta.session_id);
    });
    return new Set(Object.keys(parent?.turns || {}));
  }

  acceptsSignal(session, record, signal) {
    if (!isForkedSession(session)) return true;
    const boundary = forkBoundary(session.meta);
    const recordedAt = Date.parse(record?.timestamp || "");
    if (boundary !== null && Number.isFinite(recordedAt) && recordedAt < boundary) return false;
    if (signal.turnId && this.parentTurnIds(session).has(signal.turnId)) return false;
    if (!Number.isFinite(recordedAt) && signal.kind !== "session") return false;
    return true;
  }

  acceptsRecord(session, record) {
    if (!isForkedSession(session)) return true;
    if (record?.type === "session_meta" && record.payload?.id && record.payload.id !== session.meta?.id) {
      session.skippingInheritedHistory = true;
      this.markDirty();
      return false;
    }
    if (!session.skippingInheritedHistory) return true;
    if (record?.type === "event_msg" && record.payload?.type === "thread_settings_applied") {
      session.skippingInheritedHistory = false;
      session.forkHistoryComplete = true;
      this.markDirty();
    }
    return false;
  }

  publishTerminal(turn) {
    const stopped = ["aborted", "stale", "inherited"].includes(turn.finalKind);
    appendEvent(createEvent("work.upsert", {
      actor: "observer",
      payload: {
        id: turn.workId,
        title: turn.title,
        status: stopped ? "stopped" : "done",
        targets: turn.targets || [],
        note: turn.summary || (stopped ? "Session stopped" : "Session completed"),
        provisional: (turn.targets || []).length === 0,
        session: turn.session || sessionAdapter(turn.provider || "codex").locator({ id: turn.sessionId, cwd: this.config.repoRoot }),
      },
    }));
  }

  handleSignal(session, signal) {
    if (signal.kind === "start") {
      const turnId = signal.turnId || `turn-${this.now()}`;
      const language = getSnapshot().map?.language;
      const copy = provisionalCopy(language);
      const turn = {
        turnId, workId: workId(session.meta.id || session.meta.session_id, turnId),
        sessionId: session.meta.id || session.meta.session_id, provider: session.provider || "codex",
        startedAt: this.now(), lastActivityAt: this.now(), events: [], inferredAt: 0, initialInferred: false,
        title: copy.title, summary: copy.note, targets: [], finished: false,
      };
      session.turns[turnId] = turn;
      provisionalWork(turn, session.meta, sessionAdapter(session.provider || "codex"), language);
      this.markDirty();
      return;
    }
    const turn = this.currentTurn(session, signal.turnId);
    if (!turn) return;
    turn.lastActivityAt = this.now();
    if (signal.kind === "context") {
      turn.model = signal.model; turn.effort = signal.effort;
      this.markDirty();
      return;
    }
    const previous = turn.events.at(-1);
    if (signal.kind === "agent" && previous?.kind === "agent") {
      const combined = `${previous.text || ""}${signal.text || ""}`;
      previous.text = combined.length <= 2_500 ? combined : `${combined.slice(0, 1_200)}\n…\n${combined.slice(-1_200)}`;
      previous.at = signal.at || previous.at;
    } else {
      turn.events.push(signal);
    }
    if (turn.events.length > MAX_EVENTS) turn.events.splice(0, turn.events.length - MAX_EVENTS);
    if (signal.kind === "user") {
      turn.userMessage = signal.text;
      turn.session = sessionAdapter(session.provider || "codex").locator(session.meta, signal.text);
    }
    if (signal.kind === "complete" || signal.kind === "aborted") {
      turn.finished = true;
      turn.finalKind = signal.kind;
      turn.finalPending = true;
      this.publishTerminal(turn);
    }
    if (signal.kind === "tool" && signal.name === "update_plan") turn.priorityPending = true;
    this.markDirty();
  }

  stopTurnWithoutSignal(turn) {
    const copy = staleWorkCopy(turn.title, turn.summary, turn.userMessage);
    appendEvent(createEvent("work.upsert", {
      actor: "observer",
      payload: {
        id: turn.workId,
        title: turn.title || copy.title,
        status: "stopped",
        targets: turn.targets || [],
        note: copy.note,
        provisional: (turn.targets || []).length === 0,
        session: turn.session || sessionAdapter(turn.provider || "codex").locator({ id: turn.sessionId, cwd: this.config.repoRoot }),
      },
    }));
    turn.finished = true;
    turn.finalKind = "stale";
    turn.finalPending = false;
    turn.priorityPending = false;
    turn.events = [];
    this.markDirty();
  }

  reconcileForkedTurns() {
    for (const session of Object.values(this.state.sessions)) {
      if (!session.relevant || !isForkedSession(session)) continue;
      const inheritedTurnIds = this.parentTurnIds(session);
      for (const turn of Object.values(session.turns || {})) {
        if (turn.finished || !inheritedTurnIds.has(turn.turnId)) continue;
        turn.finalKind = "inherited";
        this.stopTurnWithoutSignal(turn);
      }
    }
  }

  reconcileKnownObserverWork() {
    const scannedSessions = new Map();
    const openWorkIds = new Set();
    for (const session of Object.values(this.state.sessions)) {
      if (!session.relevant || !session.scanSucceeded) continue;
      const id = session.meta?.id || session.meta?.session_id;
      if (id) scannedSessions.set(id, session);
      for (const turn of Object.values(session.turns || {})) if (!turn.finished) openWorkIds.add(turn.workId);
    }
    for (const work of getSnapshot().work || []) {
      if (work.actor !== "observer" || !["active", "blocked", "planned"].includes(work.status) || openWorkIds.has(work.id)) continue;
      if (!work.session?.id || !scannedSessions.has(work.session.id)) continue;
      const copy = staleWorkCopy(work.title, work.note);
      appendEvent(createEvent("work.upsert", { actor: "observer", payload: {
        ...work, actor: undefined, updatedAt: undefined, status: "stopped", note: copy.note,
      } }));
    }
  }

  expireStaleTurns() {
    for (const session of Object.values(this.state.sessions)) {
      if (!session.relevant) continue;
      for (const turn of Object.values(session.turns || {})) {
        if (turn.finished || this.running.has(turn.workId)) continue;
        const lastActivityAt = Number(turn.lastActivityAt || turn.inferredAt || turn.startedAt || 0);
        if (lastActivityAt && this.now() - lastActivityAt >= STALE_TURN_MS) this.stopTurnWithoutSignal(turn);
      }
    }
  }

  reconcileStaleObserverWork() {
    const snapshot = getSnapshot();
    const openWorkIds = new Set();
    for (const session of Object.values(this.state.sessions)) {
      if (!session.relevant) continue;
      for (const turn of Object.values(session.turns || {})) {
        const lastActivityAt = Number(turn.lastActivityAt || turn.inferredAt || turn.startedAt || 0);
        if (!turn.finished && lastActivityAt && this.now() - lastActivityAt < STALE_TURN_MS) openWorkIds.add(turn.workId);
      }
    }
    for (const work of snapshot.work || []) {
      if (work.actor !== "observer" || !["active", "blocked", "planned"].includes(work.status)) continue;
      if (openWorkIds.has(work.id)) continue;
      const updatedAt = Date.parse(work.updatedAt || "");
      if (!Number.isFinite(updatedAt) || this.now() - updatedAt < STALE_TURN_MS) continue;
      const copy = staleWorkCopy(work.title, work.note);
      appendEvent(createEvent("work.upsert", {
        actor: "observer",
        payload: {
          ...work,
          actor: undefined,
          updatedAt: undefined,
          status: "stopped",
          note: copy.note,
        },
      }));
    }
  }

  async infer(turn, final = false) {
    if (this.running.has(turn.workId)) return;
    const operation = (async () => {
      try {
        const snapshot = getSnapshot();
        const result = await this.runner({
          role: "observer", cwd: this.config.repoRoot,
          prompt: observerPrompt({ turn, final, snapshot }), outputSchema: OBSERVER_OUTPUT_SCHEMA,
        });
        const terminalStatus = turn.finished ? (turn.finalKind === "aborted" ? "stopped" : "done") : undefined;
        if (terminalStatus) result.value.workStatus = terminalStatus;
        const context = {
          workId: turn.workId,
          session: turn.session || sessionAdapter(turn.provider || "codex").locator({ id: turn.sessionId, cwd: this.config.repoRoot }),
          final,
          terminalStatus,
        };
        applyObserverDecision(result.value, context);
        turn.title = result.value.workTitle;
        turn.summary = result.value.workSummary;
        turn.targets = result.value.targetEntityIds;
        turn.initialInferred = true;
        turn.inferredAt = this.now();
        turn.events = [];
        turn.priorityPending = false;
        turn.finalPending = turn.finished && !final;
        this.markDirty();
      } catch (error) {
        this.reportError(`Observer could not classify ${turn.workId}: ${error.message}`, `classify:${turn.workId}:${error.message}`);
        if (final) {
          appendEvent(createEvent("work.upsert", {
            actor: "observer",
            payload: {
              id: turn.workId, title: turn.title, status: turn.finalKind === "aborted" ? "stopped" : "done",
              targets: turn.targets || [], note: turn.summary || "Session completed before semantic classification",
              provisional: (turn.targets || []).length === 0, session: turn.session,
            },
          }));
          turn.finalPending = false;
          this.markDirty();
        }
      }
    })();
    this.running.set(turn.workId, operation);
    try { await operation; } finally { this.running.delete(turn.workId); }
  }

  async runDue() {
    this.expireStaleTurns();
    this.reconcileForkedTurns();
    this.reconcileStaleObserverWork();
    const pending = [];
    for (const session of Object.values(this.state.sessions)) {
      if (!session.relevant) continue;
      for (const turn of Object.values(session.turns)) {
        if (turn.finalPending) pending.push(this.infer(turn, true));
        else if (turn.finished) continue;
        else if (!turn.initialInferred && (turn.events.some((item) => ["agent", "tool"].includes(item.kind))
          || this.now() - turn.startedAt >= INITIAL_DEADLINE_MS)) pending.push(this.infer(turn, false));
        else if (turn.priorityPending || (turn.events.length && this.now() - turn.inferredAt >= UPDATE_INTERVAL_MS)) pending.push(this.infer(turn, false));
      }
    }
    await Promise.all(pending);
  }

  async tick() {
    if (this.now() - this.lastDiscoveryAt >= this.discoveryIntervalMs) {
      this.discover();
      this.lastDiscoveryAt = this.now();
    }
    for (const [file, session] of Object.entries(this.state.sessions)) {
      session.scanSucceeded = false;
      if (!session.relevant || !fs.existsSync(file)) continue;
      const adapter = sessionAdapter(session.provider || "codex");
      let delta;
      try {
        delta = readAppendedRecords(file, session.offset, {
          discardingOversizedRecord: Boolean(session.discardingOversizedRecord),
        });
        session.scanSucceeded = true;
      } catch (error) {
        this.reportError(`Observer could not read ${session.meta.id || "unknown session"}: ${error.message}`, `read:${file}:${error.message}`);
        continue;
      }
      if (session.offset !== delta.offset || Boolean(session.discardingOversizedRecord) !== Boolean(delta.discardingOversizedRecord)) this.markDirty();
      session.offset = delta.offset;
      session.discardingOversizedRecord = delta.discardingOversizedRecord;
      if (delta.skippedOversizedRecords) {
        session.skippedOversizedRecords = (session.skippedOversizedRecords || 0) + delta.skippedOversizedRecords;
        this.markDirty();
        this.reportError(`Observer skipped ${delta.skippedOversizedRecords} oversized journal record(s) for ${session.meta.id || "unknown session"}`, `oversized:${file}`);
      }
      for (const record of delta.records) {
        if (!this.acceptsRecord(session, record)) continue;
        for (const signal of adapter.signals(record)) {
          if (this.acceptsSignal(session, record, signal)) this.handleSignal(session, signal);
        }
      }
    }
    this.reconcileKnownObserverWork();
    await this.runDue();
    if (this.dirty) {
      this.state.updatedAt = new Date(this.now()).toISOString();
      this.writeState(this.state);
      this.dirty = false;
    }
    return this.summary();
  }

  summary() {
    const sessions = Object.values(this.state.sessions);
    const turns = sessions.flatMap((session) => Object.values(session.turns || {}));
    return {
      providers: this.adapters.map((adapter) => adapter.id), repoRoot: this.config.repoRoot,
      trackedSessions: sessions.filter((session) => session.relevant).length,
      ignoredSessions: sessions.filter((session) => !session.relevant).length,
      activeTurns: turns.filter((turn) => !turn.finished).length,
      pendingModelCalls: this.running.size,
    };
  }
}

export const SessionObserver = CodexObserver;

export async function runObserverOnce(options = {}) {
  const observer = new CodexObserver(options);
  return observer.tick();
}

export function startObserver(options = {}) {
  const observer = new CodexObserver(options);
  let stopped = false;
  let timer = null;
  let ticking = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (!ticking) {
        ticking = true;
        try { await observer.tick(); } catch (error) { observer.reportError(`Observer tick failed: ${error.message}`, `tick:${error.code || error.message}`); }
        finally { ticking = false; }
      }
      schedule();
    }, observer.config.pollMs);
    timer.unref?.();
  };
  observer.tick().catch((error) => observer.reportError(`Observer start failed: ${error.message}`, `start:${error.code || error.message}`)).finally(schedule);
  return {
    observer,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await Promise.all(observer.running.values());
    },
  };
}

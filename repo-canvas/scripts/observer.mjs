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
  for (const key of ["id", "session_id", "cwd", "originator", "provider", "entrypoint", "promptSource"]) {
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
    sessions[file] = {
      ...session,
      meta: compactSessionMeta(session.meta),
      turns: Object.fromEntries(keptTurns.map((turn) => [turn.turnId, turn])),
    };
  }
  return {
    version: 3,
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
    map: { projectTitle: snapshot.map?.projectTitle, projectSummary: snapshot.map?.projectSummary, keyFlows: snapshot.map?.keyFlows || [] },
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

function provisionalWork(turn, meta, adapter) {
  const russian = /[А-Яа-яЁё]/.test(turn.userMessage || "");
  appendEvent(createEvent("work.upsert", {
    actor: "observer",
    payload: {
      id: turn.workId,
      title: russian ? "Новая работа" : "New work",
      status: "active",
      targets: [],
      note: russian ? "Агент осмысливает задачу" : "The agent is interpreting the request",
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
        try { meta = known?.meta || adapter.readMeta(file, root); } catch { continue; }
        if (!meta) continue;
        const session = this.ensureSession(file, meta, adapter, baseline);
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

  handleSignal(session, signal) {
    if (signal.kind === "start") {
      const turnId = signal.turnId || `turn-${this.now()}`;
      const turn = {
        turnId, workId: workId(session.meta.id || session.meta.session_id, turnId),
        sessionId: session.meta.id || session.meta.session_id, provider: session.provider || "codex",
        startedAt: this.now(), lastActivityAt: this.now(), events: [], inferredAt: 0, initialInferred: false,
        title: "Новая работа", summary: "Агент осмысливает задачу", targets: [], finished: false,
      };
      session.turns[turnId] = turn;
      provisionalWork(turn, session.meta, sessionAdapter(session.provider || "codex"));
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
        if (final && turn.finalKind === "aborted") result.value.workStatus = "stopped";
        const context = {
          workId: turn.workId,
          session: turn.session || sessionAdapter(turn.provider || "codex").locator({ id: turn.sessionId, cwd: this.config.repoRoot }),
          final,
        };
        applyObserverDecision(result.value, context);
        turn.title = result.value.workTitle;
        turn.summary = result.value.workSummary;
        turn.targets = result.value.targetEntityIds;
        turn.initialInferred = true;
        turn.inferredAt = this.now();
        turn.events = [];
        turn.priorityPending = false;
        turn.finalPending = false;
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
      if (!session.relevant || !fs.existsSync(file)) continue;
      const adapter = sessionAdapter(session.provider || "codex");
      const delta = readAppendedRecords(file, session.offset, {
        discardingOversizedRecord: Boolean(session.discardingOversizedRecord),
      });
      if (session.offset !== delta.offset || Boolean(session.discardingOversizedRecord) !== Boolean(delta.discardingOversizedRecord)) this.markDirty();
      session.offset = delta.offset;
      session.discardingOversizedRecord = delta.discardingOversizedRecord;
      if (delta.skippedOversizedRecords) {
        session.skippedOversizedRecords = (session.skippedOversizedRecords || 0) + delta.skippedOversizedRecords;
        this.markDirty();
        this.reportError(`Observer skipped ${delta.skippedOversizedRecords} oversized journal record(s) for ${session.meta.id || "unknown session"}`, `oversized:${file}`);
      }
      for (const record of delta.records) for (const signal of adapter.signals(record)) this.handleSignal(session, signal);
    }
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

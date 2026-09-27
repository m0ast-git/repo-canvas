import {promptTemplate} from "./prompt-template.mjs";
import fs from "node:fs";
import path from "node:path";

import { appendEvent, createEvent, getSnapshot } from "./canvas-store.mjs";
import { readAppendedRecords } from "./codex-sessions.mjs";
import { runStructured } from "./model-providers.mjs";
import { verifyObserverProposal, proposalStamp } from "./observer-verification.mjs";
import { updateTurnKnowledge,backfillOwnerKnowledge } from "./project-knowledge.mjs";
import { OBSERVER_OUTPUT_SCHEMA, applyObserverDecision } from "./semantic-model.mjs";
import { readObserverState, readRuntimeConfig, writeObserverState } from "./runtime-config.mjs";
import { sessionAdapter, sessionAdapters } from "./session-adapters.mjs";
import {targetsForFiles, observerSubgraph} from "./module-cards.mjs";

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
  const ignored={...(state.ignored||{})};
  for (const [file, session] of Object.entries(state.sessions || {})) {
    if(session.relevant===false&&!Object.keys(session.turns||{}).length){ignored[file]={provider:session.provider,meta:compactSessionMeta(session.meta),metaFormat:1,offset:session.offset||0};continue;}
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
    version: 5,
    initializedProviders: [...new Set(state.initializedProviders || [])],
    sessions,
    ignored,
    ...(state.knowledgeRetryAt?{knowledgeRetryAt:state.knowledgeRetryAt}:{}),
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
  return promptTemplate("observer",{FINAL:final?"yes":"no",SESSION:JSON.stringify({id:turn.sessionId,model:turn.model,effort:turn.effort}),WORK:JSON.stringify({request:turn.userMessage,title:turn.title,summary:turn.summary,targets:turn.targets}),MAP:JSON.stringify(compactMap(observerSubgraph(snapshot,turn.targets))),EVENTS:JSON.stringify(turn.events)});
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
    runner = runStructured,
    verifier = runner === runStructured ? runStructured : null,
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
    this.verifier = verifier;
    this.now = now;
    this.sessionsRoot = sessionsRoot;
    const configured = config.providers || (config.provider ? [config.provider] : ["codex", "claude", "kimi"]);
    this.adapters = adapters || (sessionsRoot ? [sessionAdapter("codex")] : sessionAdapters(configured));
    this.replay = replay;
    this.writeState = writeState;
    this.discoveryIntervalMs = discoveryIntervalMs;
    this.gitCache = new Map();
    this.running = new Map();
    this.controller = new AbortController();
    this.maxConcurrent = Math.max(1, Math.min(4, Number(config.maxConcurrent) || 2));
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
        const key=path.resolve(file);
        const known = this.state.sessions[key]||this.state.ignored[key];
        let meta;
        try { meta = known?.metaFormat === 1 ? known.meta : adapter.readMeta(file, root); } catch { continue; }
        if (!meta) continue;
        const relevant = adapter.belongsToRepository(meta, this.config.repoRoot, this.gitCache);
        if(!relevant) {
          if(!this.state.ignored[key]){this.state.ignored[key]={provider:adapter.id,meta:compactSessionMeta(meta),metaFormat:1,offset:known?.offset||0};this.markDirty();}
          if(this.state.sessions[key]){delete this.state.sessions[key];this.markDirty();}
          continue;
        }
        if(this.state.ignored[key]){delete this.state.ignored[key];this.markDirty();}
        const session = this.ensureSession(file, meta, adapter, baseline);
        if (session.metaFormat !== 1 || JSON.stringify(session.meta) !== JSON.stringify(compactSessionMeta(meta))) {
          session.meta = compactSessionMeta(meta);
          session.metaFormat = 1;
          this.markDirty();
        }
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
      const declared=getSnapshot().work.filter(item=>item.hookDriven&&item.session?.id===turn.sessionId&&item.status==="active"&&(!item.hookTurnId||item.hookTurnId===turnId)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
      if(declared){turn.workId=declared.id;turn.title=declared.title;turn.summary=declared.note;turn.targets=declared.targets||[];}
      else provisionalWork(turn, session.meta, sessionAdapter(session.provider || "codex"), language);
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
      if(this.config.observerMode==="turn")turn.title=String(signal.text||"").split("\n").find(line=>line.trim()&&!line.startsWith("#"))?.trim().slice(0,120)||turn.title;
    }
    if(this.config.observerMode==="turn"&&["user","tool"].includes(signal.kind)) {
      const snapshot=getSnapshot();
      const input=String(typeof signal.input==="string"?signal.input:JSON.stringify(signal.input||{})).replaceAll("\\\\","/").replaceAll("\\","/");
      const refs=[...new Set(snapshot.entities.flatMap(item=>[item.path,...(item.evidence||[])]).filter(Boolean).map(ref=>String(ref).split(/#|::|:\d/)[0]))];
      const files=refs.filter(file=>input.includes(file));
      turn.targets=[...new Set([...(turn.targets||[]),...targetsForFiles(snapshot,files,this.config.repoRoot)])];
      turn.summary=turn.targets.length?"Агент работает с файлами этих модулей":"Работа началась; затронутые модули пока не определены";
      appendEvent(createEvent("work.upsert",{actor:"observer",payload:{id:turn.workId,title:turn.title,status:"active",targets:turn.targets,note:turn.summary,provisional:!turn.targets.length,session:turn.session}}));
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
    if (this.controller.signal.aborted || this.running.has(turn.workId) || this.running.size >= this.maxConcurrent) return;
    const maxFinalAttempts = this.config.observerFinalAttempts || 3;
    if (final && (turn.finalAttempts || 0) >= maxFinalAttempts) {
      turn.finalPending = false;
      turn.verificationPending = null;
      turn.paused = {reason:`Повторная проверка остановлена после ${maxFinalAttempts} попыток`,at:new Date(this.now()).toISOString()};
      this.reportError(turn.paused.reason, `final-limit:${turn.workId}`);
      this.markDirty();
      return;
    }
    if(final) {turn.finalAttempts=(turn.finalAttempts||0)+1;this.markDirty();}
    const sentEvents = new Map(turn.events.map(event => [event, JSON.stringify(event)]));
    const packet = { ...turn, events: structuredClone(turn.events) };
    const operation = (async () => {
      try {
        const snapshot = getSnapshot();
        const outputSchema=structuredClone(OBSERVER_OUTPUT_SCHEMA);
        const targetIds=snapshot.entities.filter(item=>item.kind!=="person").map(item=>item.id);
        if(targetIds.length)outputSchema.properties.targetEntityIds.items={type:"string",enum:targetIds};else outputSchema.properties.targetEntityIds.maxItems=0;
        const result = await this.runner({
          role: "observer", cwd: this.config.repoRoot, background:true,
          prompt: observerPrompt({ turn: packet, final, snapshot }), outputSchema, signal: this.controller.signal,
        });
        if (this.controller.signal.aborted) return;
        const terminalStatus = turn.finished ? (turn.finalKind === "aborted" ? "stopped" : "done") : undefined;
        if (terminalStatus) result.value.workStatus = terminalStatus;
        const context = {
          workId: turn.workId,
          session: turn.session || sessionAdapter(turn.provider || "codex").locator({ id: turn.sessionId, cwd: this.config.repoRoot }),
          final,
          terminalStatus,
        };
        applyObserverDecision(result.value, context);
        if(final && this.verifier && ((result.value.entityChanges||[]).length || (result.value.relationChanges||[]).length)) {
          const verified=await verifyObserverProposal(result.value,context,{root:this.config.repoRoot,runner:options=>this.verifier({...options,background:true}),signal:this.controller.signal});
          turn.verificationPending=verified.passed?null:{decision:result.value,stamp:verified.stamp};
        } else if (final) {
          turn.verificationPending = null;
        }
        if(final&&this.runner===runStructured&&turn.userMessage&&this.config.dialogSources!==false){
          const file=Object.entries(this.state.sessions).find(([,session])=>session.turns?.[turn.turnId]===turn)?.[0];
          try{await updateTurnKnowledge(this.config.repoRoot,{config:this.config,sessionId:turn.sessionId,provider:turn.provider,file,runner:options=>this.runner({...options,background:true}),signal:this.controller.signal});}
          catch(error){if(this.controller.signal.aborted)throw error;this.reportError(`Не удалось уточнить решения: ${error.message}`,`knowledge:${turn.workId}`);}
        }
        turn.title = result.value.workTitle;
        turn.summary = result.value.workSummary;
        turn.targets = result.value.targetEntityIds;
        turn.initialInferred = true;
        turn.paused = null;
        turn.failures=0;turn.retryAt=0;
        turn.inferredAt = this.now();
        turn.events = turn.events.filter(event => sentEvents.get(event) !== JSON.stringify(event));
        turn.priorityPending = turn.events.length > 0;
        turn.finalPending = turn.finished && !final;
        this.markDirty();
      } catch (error) {
        if (this.controller.signal.aborted) return;
        if(error.code==="BACKGROUND_LIMIT") {
          if(final)turn.finalAttempts=Math.max(0,turn.finalAttempts-1);
          turn.retryAt=Date.parse(error.until);turn.paused={reason:error.message,until:error.until};
          this.markDirty();return;
        }
        turn.inferredAt = this.now();
        this.reportError(`Observer could not classify ${turn.workId}: ${error.message}`, `classify:${turn.workId}:${error.message}`);
        turn.failures=(turn.failures||0)+1;turn.retryAt=this.now()+Math.min(120000,5000*2**Math.min(5,turn.failures-1));
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

  async runDue({drain=false}={}) {
    this.expireStaleTurns();
    this.reconcileForkedTurns();
    this.reconcileStaleObserverWork();
    do {
    const pending = [];
    for (const session of Object.values(this.state.sessions)) {
      if (!session.relevant) continue;
      for (const turn of Object.values(session.turns)) {
        if(this.running.has(turn.workId)||this.running.size>=this.maxConcurrent)continue;
        if(turn.retryAt && this.now()<turn.retryAt)continue;
        if (turn.verificationPending) {
          const stamp = proposalStamp(this.config.repoRoot, turn.verificationPending.decision);
          if (turn.verificationPending.stamp !== stamp) {
            // Consume the source change before requesting a model, including on failure.
            turn.verificationPending.stamp = stamp;
            turn.finalPending = true;
            this.markDirty();
          }
        }
        if (turn.finalPending) pending.push(this.infer(turn, true));
        else if (turn.finished) continue;
        else if (this.config.observerMode === "turn") continue;
        else if (!turn.initialInferred && (turn.events.some((item) => ["agent", "tool"].includes(item.kind))
          || this.now() - turn.startedAt >= INITIAL_DEADLINE_MS)) pending.push(this.infer(turn, false));
        else if (turn.priorityPending || (turn.events.length && this.now() - turn.inferredAt >= UPDATE_INTERVAL_MS)) pending.push(this.infer(turn, false));
      }
    }
    await Promise.all(pending);
    if(!drain||!pending.length)break;
    }while(!this.controller.signal.aborted);
    if(!this.controller.signal.aborted&&this.runner===runStructured&&this.config.dialogSources!==false&&!this.running.size&&this.now()>=(this.state.knowledgeRetryAt||0)&&!Object.values(this.state.sessions).some(session=>Object.values(session.turns||{}).some(turn=>!turn.finished))) {
      this.state.knowledgeRetryAt=this.now()+60000;this.markDirty();
      const operation=backfillOwnerKnowledge(this.config.repoRoot,{config:this.config,runner:this.runner,signal:this.controller.signal}).catch(error=>{
        if(this.controller.signal.aborted)return;
        this.state.knowledgeRetryAt=error.code==="BACKGROUND_LIMIT"?Date.parse(error.until):this.now()+15*60000;
        this.reportError("Не удалось продолжить чтение решений владельца: "+error.message,"knowledge-backfill");this.markDirty();
      }).finally(()=>this.running.delete("knowledge-backfill"));
      this.running.set("knowledge-backfill",operation);if(drain)await operation;
    }
  }

  async tick({ awaitModels = true } = {}) {
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
    const work = this.runDue({drain:awaitModels});
    if (awaitModels) await work;
    else work.catch(error => this.reportError(`Observer model failed: ${error.message}`, "model"));
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
      ignoredSessions: sessions.filter((session) => !session.relevant).length+Object.keys(this.state.ignored).length,
      activeTurns: turns.filter((turn) => !turn.finished).length,
      pendingModelCalls: this.running.size,
      paused: turns.filter(turn=>turn.paused).map(turn=>({workId:turn.workId,...turn.paused})),
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
        try { await observer.tick({ awaitModels: false }); } catch (error) { observer.reportError(`Observer tick failed: ${error.message}`, `tick:${error.code || error.message}`); }
        finally { ticking = false; }
      }
      schedule();
    }, observer.config.pollMs);
    timer.unref?.();
  };
  observer.tick({ awaitModels: false }).catch((error) => observer.reportError(`Observer start failed: ${error.message}`, `start:${error.code || error.message}`)).finally(schedule);
  return {
    observer,
    stop: async () => {
      stopped = true;
      observer.controller.abort();
      if (timer) clearTimeout(timer);
      await Promise.all(observer.running.values());
      if(observer.dirty){observer.writeState(compactObserverState(observer.state));observer.dirty=false;}
    },
  };
}

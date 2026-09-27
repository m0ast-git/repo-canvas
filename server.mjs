import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { appendEvents, createEvent, getSnapshot, packageRoot, projectRoot } from "./repo-canvas/scripts/canvas-store.mjs";
import { stopModelProcesses } from "./repo-canvas/scripts/model-runtime.mjs";
import { runCorrection, undoCorrection } from "./repo-canvas/scripts/corrections.mjs";
import { historyPage, stateAtCheckpoint, currentHistoryState, saveCheckpointGeometry, createCheckpoint, addHistoryComment, historyComments, compareSnapshots } from "./repo-canvas/scripts/canvas-history.mjs";
import { discoverModelProviders, configuredModelCatalog, probeModel, roleModelPresets, modelConfigPatch } from "./repo-canvas/scripts/model-providers.mjs";
import { readSourceJson, sourceIndexFile, readDialogSource, readCodeSource } from "./repo-canvas/scripts/project-sources.mjs";
import { writeRuntimeConfig } from "./repo-canvas/scripts/runtime-config.mjs";
import { runArchitectInWorker } from "./repo-canvas/scripts/architect-worker.mjs";
import { startObserver } from "./repo-canvas/scripts/observer.mjs";
import { startGitTracker, readGitSource, stopGitProcesses } from "./repo-canvas/scripts/git-history.mjs";
import { startCodeWatcher, reviewCodeChanges } from "./repo-canvas/scripts/code-observer.mjs";
import { answerProjectQuestion } from "./repo-canvas/scripts/project-questions.mjs";
import { readHistoricalEvidence } from "./repo-canvas/scripts/source-archive.mjs";
import { reconstructHistory, saveReconstructionGeometry } from "./repo-canvas/scripts/history-reconstruction.mjs";
import { readArchitectState, readOrCreateApiToken, readRuntimeConfig, writeArchitectState } from "./repo-canvas/scripts/runtime-config.mjs";
import { openSessionLocator } from "./repo-canvas/scripts/session-locator.mjs";
import { createUpdateService } from "./repo-canvas/scripts/update-service.mjs";
import {publicSnapshot, snapshotDelta} from "./repo-canvas/scripts/live-state.mjs";
import {healthReport} from "./repo-canvas/scripts/health-report.mjs";
import {buildEstimate} from "./repo-canvas/scripts/module-cards.mjs";
import {createSkeleton} from "./repo-canvas/scripts/skeleton-map.mjs";
import {ingestAgentHook} from "./repo-canvas/scripts/agent-hooks.mjs";

const host = process.env.CANVAS_HOST || "127.0.0.1";
const port = Number(process.env.CANVAS_PORT || 4173);
const publicDirectory = path.join(packageRoot, "public");
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const apiCookieName = "repo_canvas_api";
const runtimeConfig = readRuntimeConfig();
const configuredApiToken = process.env.REPO_CANVAS_API_TOKEN || "";
if (configuredApiToken && !/^[A-Za-z0-9_-]{43}$/.test(configuredApiToken)) {
  throw new Error("REPO_CANVAS_API_TOKEN must be a 32-byte base64url token");
}
const apiToken = configuredApiToken || readOrCreateApiToken();
let observerService = null;
let gitTracker=null;let codeWatcher=null;
let architectJob = null;
let jobController = null;
const idleArchitectState = {
  status: "idle", phase: "idle", startedAt: null, heartbeatAt: null, finishedAt: null,
  attempt: 0, activityCount: 0, detail: null, result: null, error: null,
};
let architectState = readArchitectState() || idleArchitectState;
function persistArchitectState() {
  try { writeArchitectState(architectState); }
  catch (error) { console.warn(`Repo Canvas could not persist Architect status: ${error.message}`); }
}
if (architectState.status === "running") {
  const interruptedAt = new Date().toISOString();
  architectState = {
    ...architectState, status: "failed", phase: "failed", heartbeatAt: interruptedAt, finishedAt: interruptedAt,
    error: "Обновление прервано остановкой сервера. Сохранённая карта доступна; запустите обновление ещё раз.",
  };
  persistArchitectState();
}
const updateService = createUpdateService({ host, port, apiToken, shutdown });

function publicArchitectState() {
  return {
    ...architectState,
    running: architectJob !== null,
    checkedAt: new Date().toISOString(),
    elapsedMs: architectState.startedAt ? Math.max(0, (architectState.finishedAt?Date.parse(architectState.finishedAt):Date.now()) - Date.parse(architectState.startedAt)) : 0,
  };
}

function architectProgress(progress = {}) {
  architectState = {
    ...architectState,
    phase: progress.phase || architectState.phase || "reasoning",
    heartbeatAt: progress.at || new Date().toISOString(),
    attempt: Number.isInteger(progress.attempt) ? progress.attempt : architectState.attempt,
    activityCount: architectState.activityCount + 1,
    model: progress.model || architectState.model || null,
    call: progress.call || architectState.call || null,
    eventType: progress.eventType || null,
    detail: Object.hasOwn(progress, "detail") ? progress.detail : architectState.detail,
  };
  persistArchitectState();
}

function startMapJob(run, kind="build", metadata={}) {
  if (architectJob) return false;
  const startedAt = new Date().toISOString();
  architectState = {
    status: "running", kind, phase: "starting", startedAt, heartbeatAt: startedAt, finishedAt: null,
    attempt: 0, activityCount: 0, detail: null, result: null, error: null, ...metadata,
  };
  persistArchitectState();
  jobController=new AbortController();
  architectJob = Promise.resolve().then(async()=>{
    if(kind==="build")await pauseObservation();
    return run({signal:jobController.signal,onProgress:architectProgress});
  })
    .then((result) => {
      if(kind==="probe" && result.status!=="connected") throw new Error(result.error || "Исполнитель не подтвердил подключение");
      const {state:_state,...publicResult}=result;
      const finishedAt = new Date().toISOString();
      architectState = { ...architectState, status: "done", phase: "done", heartbeatAt: finishedAt, finishedAt, result:publicResult, error: null, detail: null };
      persistArchitectState();
    })
    .catch((error) => {
      const finishedAt = new Date().toISOString();
      architectState = {
        ...architectState, status: "failed", phase: "failed", heartbeatAt: finishedAt, finishedAt,
        result: error?.audit || null, error: String(error?.message || error).slice(0, 500), detail: architectState.detail,
      };
      persistArchitectState();
    })
    .finally(() => { architectJob = null;if(kind==="build"&&!stopping)configureObservation().catch(error=>console.warn(`Observation could not resume: ${error.message}`)); });
  return true;
}

function startArchitectRefresh(viewpoint="",updateReason="manual") { return startMapJob(options=>{if(!getSnapshot().semantic)createSkeleton(projectRoot);return runArchitectInWorker({refresh:true,viewpoint,...options});},"build",{updateReason}); }
async function pauseObservation() {
  await observerService?.stop();observerService=null;codeWatcher?.stop();gitTracker?.stop();codeWatcher=null;gitTracker=null;
}
async function configureObservation() {
  await pauseObservation();
  const config=readRuntimeConfig();if(!config.enabled||!getSnapshot().semantic||process.env.REPO_CANVAS_OBSERVE==="0")return;
  codeWatcher=startCodeWatcher(projectRoot,{enabled:()=>readRuntimeConfig().enabled,isBusy:()=>Boolean(observerService?.observer.summary().activeTurns||observerService?.observer.running.size),run:files=>startMapJob(options=>reviewCodeChanges({root:projectRoot,files,...options}),"code-review")});
  gitTracker=startGitTracker(projectRoot,{onChange:()=>codeWatcher.schedule(getSnapshot().entities.flatMap(item=>[item.path,...(item.evidence||[])]).filter(Boolean).map(ref=>ref.split(/#|::|:\d/)[0]))});
  if(config.dialogSources!==false)observerService=startObserver({config});
}

function openCanvasInBrowser(url) {
  if (process.env.REPO_CANVAS_AUTO_OPEN === "0" || process.env.NODE_ENV === "test") return;
  const launchers = {
    win32: ["rundll32.exe", ["url.dll,FileProtocolHandler", url]],
    darwin: ["open", [url]],
    linux: ["xdg-open", [url]],
  };
  const launcher = launchers[process.platform];
  if (!launcher) return;
  try {
    const child = spawn(launcher[0], launcher[1], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", (error) => console.warn(`Repo Canvas could not open the browser automatically: ${error.message}`));
    child.unref();
  } catch (error) {
    console.warn(`Repo Canvas could not open the browser automatically: ${error.message}`);
  }
}

if (!loopbackHosts.has(host)) throw new Error(`Repo Canvas only binds to loopback; received CANVAS_HOST=${host}`);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid CANVAS_PORT: ${process.env.CANVAS_PORT}`);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

class HttpError extends Error {
  constructor(statusCode, message, details = {}) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendText(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(value),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(value);
}

function parseLoopbackUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(403, `Invalid ${label}`);
  }
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname)) {
    throw new HttpError(403, `${label} must be loopback HTTP`);
  }
  const parsedPort = parsed.port ? Number(parsed.port) : 80;
  if (parsedPort !== port) throw new HttpError(403, `${label} port does not match the active canvas`);
  return parsed;
}

function guardRequest(request) {
  const hostHeader = String(request.headers.host || "");
  parseLoopbackUrl(`http://${hostHeader}`, "Host");
  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw new HttpError(403, "Cross-site requests are not allowed");
  }
}

function guardMutation(request) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const origin = request.headers.origin;
  if (origin) parseLoopbackUrl(String(origin), "Origin");
}

function guardApiAuthorization(request) {
  const candidates = [];
  const supplied = request.headers["x-repo-canvas-token"];
  if (typeof supplied === "string" && supplied) candidates.push(supplied);
  const cookieHeader = String(request.headers.cookie || "");
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== apiCookieName) continue;
    const cookieToken = part.slice(separator + 1).trim();
    if (cookieToken) candidates.push(cookieToken);
  }
  if (!candidates.length) throw new HttpError(401, "Repo Canvas API authorization is required");
  const expectedBuffer = Buffer.from(apiToken);
  const authorized = candidates.some((candidate) => {
    const suppliedBuffer = Buffer.from(candidate);
    return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
  });
  if (!authorized) {
    throw new HttpError(401, "Repo Canvas API token is invalid");
  }
}

async function readJson(request,limit=1024*1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

function saveLayout(body) {
  const requestedRevision = Number(body.canvasRevision);
  if (!Number.isInteger(requestedRevision) || requestedRevision < 0) throw new HttpError(400, "canvasRevision must be a non-negative integer");
  if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, "items must be a non-empty array");
  if (body.expected !== undefined && !Array.isArray(body.expected)) throw new HttpError(400, "expected must be an array");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const snapshot = getSnapshot();
    if (snapshot.storeErrors.length) throw new HttpError(409, "Repo Canvas store must pass check before saving layout");
    if (requestedRevision > snapshot.revision) throw new HttpError(409, "Canvas revision is ahead of the local store", { revision: snapshot.revision });
    const areas = new Map(snapshot.areas.map((item) => [item.id, item]));
    const entities = new Map(snapshot.entities.map((item) => [item.id, item]));
    const work = new Map(snapshot.work.map((item) => [item.id, item]));
    for (const expected of body.expected || []) {
      const collection = { area: areas, entity: entities, work }[expected.kind];
      const current = collection?.get(expected.id);
      if (!current || Object.entries(expected.values || {}).some(([key, value]) => (current[key] ?? null) !== (value ?? null))) {
        throw new HttpError(409, "Этот объект изменён в другой вкладке. Обновите карту перед повтором.", { conflict: true, revision: snapshot.revision });
      }
    }
    const requestedEntityAreas = new Map(body.items.filter((item) => item?.kind === "entity" && Object.hasOwn(item, "areaId")).map((item) => [String(item.id || "").trim(), String(item.areaId || "").trim()]));
    const seen = new Set();
    const events = body.items.map((item) => {
      const kind = String(item?.kind || ""); const id = String(item?.id || "").trim();
      const x = Number(item?.x); const y = Number(item?.y); const key = `${kind}:${id}`;
      if(item.resetPosition!==undefined&&typeof item.resetPosition!=="boolean")throw new HttpError(400,"resetPosition must be a boolean");
      const position=item.resetPosition?{x:null,y:null}:{x,y};
      if (!id || seen.has(key)) throw new HttpError(400, "Each layout item must have a unique id and kind");
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new HttpError(400, `Layout coordinates must be finite for ${key}`);
      seen.add(key);
      if (kind === "area") {
        const current = areas.get(id); if (!current) throw new HttpError(404, `Area not found: ${id}`);
        const width = Object.hasOwn(item, "width") ? Number(item.width) : current.width;
        const height = Object.hasOwn(item, "height") ? Number(item.height) : current.height;
        const minWidth = Object.hasOwn(item, "minWidth") ? Number(item.minWidth) : current.minWidth;
        const minHeight = Object.hasOwn(item, "minHeight") ? Number(item.minHeight) : current.minHeight;
        if (width !== undefined && (!Number.isFinite(width) || width < 260)) throw new HttpError(400, `Area width must be at least 260 for ${id}`);
        if (height !== undefined && (!Number.isFinite(height) || height < 180)) throw new HttpError(400, `Area height must be at least 180 for ${id}`);
        if (minWidth !== undefined && (!Number.isFinite(minWidth) || minWidth < 0)) throw new HttpError(400, `Area minimum width must be non-negative for ${id}`);
        if (minHeight !== undefined && (!Number.isFinite(minHeight) || minHeight < 0)) throw new HttpError(400, `Area minimum height must be non-negative for ${id}`);
        const { actor, updatedAt, ...payload } = current;
        return createEvent("area.upsert", { actor: "owner", payload: { ...payload, ...position, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(minWidth !== undefined ? { minWidth } : {}), ...(minHeight !== undefined ? { minHeight } : {}) } });
      }
      if (kind === "entity") {
        const current = entities.get(id); if (!current) throw new HttpError(404, `Entity not found: ${id}`);
        let areaId = current.areaId || "";
        if (Object.hasOwn(item, "areaId")) {
          areaId = String(item.areaId || "").trim();
          if (current.kind === "person" && areaId) throw new HttpError(400, "A person cannot be placed inside a project area");
          if (areaId && !areas.has(areaId)) throw new HttpError(400, `Entity area not found: ${areaId}`);
        }
        let parentId = current.parentId || "";
        if (Object.hasOwn(item, "parentId")) {
          parentId = String(item.parentId || "").trim();
          if (current.kind === "person" && parentId) throw new HttpError(400, "A person cannot be placed inside a project block");
          if (parentId === id) throw new HttpError(400, "An entity cannot be its own parent");
          const parent = parentId ? entities.get(parentId) : null;
          if (parentId && !parent) throw new HttpError(400, `Entity parent not found: ${parentId}`);
          if (parent && parent.kind === "person") throw new HttpError(400, "A person cannot contain project entities");
          const parentAreaId = parent ? requestedEntityAreas.get(parent.id) ?? parent.areaId : "";
          if (parent && parentAreaId !== areaId) throw new HttpError(400, "Entity and parent must belong to the same project area");
          let ancestor = parent; const visited = new Set();
          while (ancestor && !visited.has(ancestor.id)) {
            if (ancestor.id === id) throw new HttpError(400, "Entity parent would create a hierarchy cycle");
            visited.add(ancestor.id); ancestor = ancestor.parentId ? entities.get(ancestor.parentId) : null;
          }
        }
        if (parentId) {
          const parent = entities.get(parentId); const parentAreaId = parent ? requestedEntityAreas.get(parent.id) ?? parent.areaId : "";
          if (!parent || parentAreaId !== areaId) throw new HttpError(400, "Entity and parent must belong to the same project area");
        }
        const { actor, updatedAt, ...payload } = current;
        const ownership={...(parentId!==(current.parentId||"")?{ownerParentId:parentId}:{}),...(areaId!==current.areaId?{ownerAreaId:areaId}:{})};
        for(const [key,value] of [["ownerAreaId",areaId],["ownerParentId",parentId]])if(Object.hasOwn(item,key)){
          if(item[key]!==null&&item[key]!==value)throw new HttpError(400,"Закрепление элемента должно соответствовать его положению");
          ownership[key]=item[key];
        }
        return createEvent("entity.upsert", { actor: "owner", payload: { ...payload, areaId, parentId, ...position,...ownership } });
      }
      if (kind === "work") {
        const current = work.get(id); if (!current) throw new HttpError(404, `Work not found: ${id}`);
        const { actor, updatedAt, ...payload } = current;
        return createEvent("work.upsert", { actor: actor || "owner", payload: { ...payload, x, y } });
      }
      throw new HttpError(400, `Unsupported layout item kind: ${kind}`);
    });
    try {
      appendEvents(events, { expectedRevision: snapshot.revision });
      const state = getSnapshot();
      return { revision: state.revision, saved: events.length, state };
    } catch (error) {
      if (error.code === "STALE_REVISION" && attempt < 5) continue;
      if (error.code === "STALE_REVISION") throw new HttpError(409, "Canvas kept changing while saving layout", { revision: error.currentRevision });
      throw error;
    }
  }
  throw new HttpError(409, "Canvas kept changing while saving layout");
}

function saveRename(body) {
  const requestedRevision = Number(body.canvasRevision);
  if (!Number.isInteger(requestedRevision) || requestedRevision < 0) throw new HttpError(400, "canvasRevision must be a non-negative integer");
  const kind = String(body.kind || "").trim();
  const id = String(body.id || "").trim();
  if (!id) throw new HttpError(400, "id is required");
  const requestedValues = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : { title: body.value };
  if ("title" in requestedValues) {
    const title = String(requestedValues.title ?? "").trim();
    if (!title) throw new HttpError(400, "The new name must not be empty");
    if (title.length > 240) throw new HttpError(400, "title must be 240 characters or fewer");
  }
  if ("description" in requestedValues && String(requestedValues.description ?? "").trim().length > 2000) throw new HttpError(400, "description must be 2000 characters or fewer");
  const snapshot = getSnapshot();
  if (snapshot.storeErrors.length) throw new HttpError(409, "Repo Canvas store must pass check before renaming");
  if (requestedRevision !== snapshot.revision) throw new HttpError(409, "Canvas changed; refresh before renaming", { revision: snapshot.revision });
  const collections = {
    area: { items: snapshot.areas, type: "area.upsert", fields: { title: "ownerTitle", description: "ownerNote" } },
    entity: { items: snapshot.entities, type: "entity.upsert", fields: { title: "ownerLabel", description: "ownerPurpose" } },
    relation: { items: snapshot.relations, type: "relation.upsert", fields: { title: "ownerLabel" } },
  };
  const target = collections[kind];
  if (!target) throw new HttpError(400, `Unsupported rename kind: ${kind}`);
  const current = target.items.find((item) => item.id === id);
  if (!current) throw new HttpError(404, `${kind} not found: ${id}`);
  for (const [name, value] of Object.entries(body.expectedValues || {})) {
    const field = target.fields[name];
    const fallback = name === "title" ? current.title || current.label || "" : current.note || current.purpose || "";
    if (field && (current[field] || fallback) !== (value || "")) throw new HttpError(409, "Этот текст изменён в другой вкладке. Обновите карту перед повтором.", {conflict:true, revision:snapshot.revision});
  }
  const changes = {};
  for (const [name, field] of Object.entries(target.fields)) {
    if (!(name in requestedValues)) continue;
    const value = String(requestedValues[name] ?? "").trim();
    if (name === "title" && !value) throw new HttpError(400, "The new name must not be empty");
    const limit = name === "description" ? 2000 : 240;
    if (value.length > limit) throw new HttpError(400, `${name} must be ${limit} characters or fewer`);
    changes[field] = value;
  }
  if (!Object.keys(changes).length) throw new HttpError(400, "No editable fields were supplied");
  const { actor, updatedAt, ...payload } = current;
  const event = createEvent(target.type, { actor: "owner", payload: { ...payload, ...changes } });
  try {
    appendEvents([event], { expectedRevision: requestedRevision });
  } catch (error) {
    if (error.code === "STALE_REVISION") throw new HttpError(409, "Canvas changed; refresh before renaming", { revision: error.currentRevision });
    throw error;
  }
  return { revision: requestedRevision + 1, kind, id, values: requestedValues };
}

function findSessionNode(body) {
  const workId = String(body.workId || "").trim();
  if (!workId) throw new HttpError(400, "workId is required");
  const snapshot = getSnapshot();
  if (snapshot.storeErrors.length) throw new HttpError(409, "Repo Canvas store must pass check before navigation");
  const requestedRevision = Number(body.canvasRevision);
  if (!Number.isInteger(requestedRevision) || requestedRevision < 0) {
    throw new HttpError(400, "canvasRevision must be a non-negative integer");
  }
  if (requestedRevision !== snapshot.revision) {
    throw new HttpError(409, "Canvas changed; refresh before opening this work session", { revision: snapshot.revision });
  }
  const node = snapshot.work.find((item) => item.id === workId);
  if (!node) throw new HttpError(404, `Work not found: ${workId}`);
  if (!node.session) throw new HttpError(422, "The agent did not attach a work session to this node");
  return node;
}

async function serveStatic(pathname, response, headOnly = false) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolvedPath = path.resolve(publicDirectory, relativePath);
  if (!resolvedPath.startsWith(`${publicDirectory}${path.sep}`) && resolvedPath !== publicDirectory) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(resolvedPath);
    const contentType = mimeTypes.get(path.extname(resolvedPath).toLowerCase()) || "application/octet-stream";
    const headers = {
      "Content-Type": contentType,
      "Content-Length": content.length,
      "Cache-Control": /^\/assets\/[^/]+-[\w-]+\.[\w]+$/.test(pathname) ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    };
    if (pathname === "/") {
      headers["Set-Cookie"] = `${apiCookieName}=${apiToken}; Path=/api; HttpOnly; SameSite=Strict`;
    }
    response.writeHead(200, headers);
    response.end(headOnly ? undefined : content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(response, 404, "Not found");
      return;
    }
    throw error;
  }
}

const streamClients=new Set();let streamSnapshot=null;let streamRevision=-1;let streamJob="";let streaming=false;
const observationStatus=()=>({enabled:readRuntimeConfig().enabled,running:Boolean(observerService||codeWatcher),pausedByHost:process.env.REPO_CANVAS_OBSERVE==="0",...(observerService?.observer.summary()||{})});
function sendStream(response,packet) {
  if(response.destroyed||response.writableLength>1024*1024){response.destroy();streamClients.delete(response);return;}
  response.write(`data: ${JSON.stringify(packet)}\n\n`);
}
const streamTimer=setInterval(async()=>{
  if(!streamClients.size||streaming)return;streaming=true;
  try {
    const snapshot=getSnapshot();
    if(snapshot.revision!==streamRevision) {
      const next=publicSnapshot(await currentHistoryState(snapshot));const packet=snapshotDelta(streamSnapshot,next);
      streamSnapshot=next;streamRevision=next.revision;
      for(const response of streamClients)sendStream(response,{...packet,observer:observationStatus()});
    }
    const jobKey=JSON.stringify(architectState);
    if(jobKey!==streamJob) {streamJob=jobKey;for(const response of streamClients)sendStream(response,{type:"job",job:publicArchitectState()});}
    for(const response of streamClients)sendStream(response,{type:"heartbeat",at:Date.now(),observer:observationStatus()});
  } catch {for(const response of streamClients)response.destroy();streamClients.clear();}
  finally {streaming=false;}
},1000);streamTimer.unref();

const server = http.createServer(async (request, response) => {
  try {
    guardRequest(request);
    const url = new URL(request.url || "/", `http://${host}:${port}`);
    if (url.pathname.startsWith("/api/")) guardApiAuthorization(request);

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true, pid: process.pid, root: projectRoot, now: new Date().toISOString(),
        observer: observerService?.observer.summary() || { enabled: runtimeConfig.enabled, running: false },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, publicSnapshot(await currentHistoryState()));
      return;
    }

    if(request.method==="GET" && url.pathname==="/api/stream") {
      response.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-store","Connection":"keep-alive","X-Accel-Buffering":"no"});
      response.write("retry: 2000\n\n");streamClients.add(response);
      const snapshot=publicSnapshot(await currentHistoryState());
      sendStream(response,{type:"snapshot",snapshot,observer:observationStatus()});
      sendStream(response,{type:"job",job:publicArchitectState()});
      response.on("close",()=>streamClients.delete(response));return;
    }
    if(request.method==="GET" && url.pathname==="/api/health/report") {
      sendJson(response,200,healthReport(observationStatus()));return;
    }
    if(request.method==="GET"&&url.pathname==="/api/architect/estimate") {
      sendJson(response,200,buildEstimate(projectRoot,getSnapshot(),readRuntimeConfig()));return;
    }
    if(request.method==="POST"&&url.pathname==="/api/architect/skeleton") {
      guardMutation(request);if(architectJob)throw new HttpError(409,"Дождитесь завершения построения");
      sendJson(response,200,createSkeleton(projectRoot));return;
    }
    if(request.method==="POST"&&url.pathname==="/api/hooks") {
      guardMutation(request);sendJson(response,200,ingestAgentHook(await readJson(request,256000)));return;
    }
    if(request.method==="GET" && /^\/api\/work\/[^/]+$/.test(url.pathname)) {
      const id=decodeURIComponent(url.pathname.slice("/api/work/".length));
      const snapshot=url.searchParams.get("checkpointId")?await stateAtCheckpoint(url.searchParams.get("checkpointId")):getSnapshot();
      const work=snapshot.work.find(item=>item.id===id);if(!work)throw new HttpError(404,"Работа не найдена");sendJson(response,200,work);return;
    }

    if(request.method==="GET" && url.pathname==="/api/history") {
      sendJson(response,200,await historyPage(Object.fromEntries(url.searchParams)));return;
    }
    if(request.method==="GET" && url.pathname==="/api/history/state") {
      const id=url.searchParams.get("id");const state=await stateAtCheckpoint(id);
      sendJson(response,200,{...publicSnapshot(state),_comments:historyComments(id)});return;
    }
    if(request.method==="GET" && url.pathname==="/api/history/comments") {
      sendJson(response,200,historyComments(url.searchParams.get("id")));return;
    }
    if(request.method==="GET" && url.pathname==="/api/history/compare") {
      const from=url.searchParams.get("from");const to=url.searchParams.get("to");
      const before=await stateAtCheckpoint(from);const after=to&&to!=="live"?await stateAtCheckpoint(to):await currentHistoryState();
      const comparison=compareSnapshots(before,after);
      for(const item of comparison.removed)if(["entities","areas"].includes(item.kind))item.geometry=before._geometry?.[item.kind]?.find(rect=>rect.id===item.id)||null;
      sendJson(response,200,{from,to:to||"live",fromPoint:before._history,toPoint:after._history||{title:"Live"},...comparison});return;
    }
    if(request.method==="POST" && url.pathname==="/api/history/geometry") {
      guardMutation(request);const body=await readJson(request,12*1024*1024);sendJson(response,200,await saveCheckpointGeometry(body.id,body.revision,body.geometry));return;
    }
    if(request.method==="POST" && url.pathname==="/api/history/reconstruct") {
      guardMutation(request);const body=await readJson(request);
      if(!startMapJob(options=>reconstructHistory({root:projectRoot,ids:body.ids,...options}),"reconstruction"))throw new HttpError(409,"Уже выполняется модельная задача");
      sendJson(response,202,publicArchitectState());return;
    }
    if(request.method==="POST" && url.pathname==="/api/history/reconstruction-geometry") {
      guardMutation(request);const body=await readJson(request,12*1024*1024);sendJson(response,200,saveReconstructionGeometry(body.id,body.revision,body.geometry));return;
    }
    if(request.method==="POST" && url.pathname==="/api/history/checkpoint") {
      guardMutation(request);const body=await readJson(request);sendJson(response,201,await createCheckpoint(body.title));return;
    }
    if(request.method==="POST" && url.pathname==="/api/history/comment") {
      guardMutation(request);const body=await readJson(request);sendJson(response,201,await addHistoryComment(body.id,body.text));return;
    }

    if (request.method === "GET" && url.pathname === "/api/revision") {
      const snapshot = getSnapshot();
      sendJson(response, 200, { revision: snapshot.revision, updatedAt: snapshot.updatedAt,observer:{enabled:readRuntimeConfig().enabled,running:Boolean(observerService||codeWatcher)} });
      return;
    }

    if(request.method==="GET" && url.pathname==="/api/models") {
      const config=readRuntimeConfig();
      sendJson(response,200,{providers:discoverModelProviders(),models:configuredModelCatalog("codex"),roles:roleModelPresets(config),config:{enabled:config.enabled,modelProvider:config.modelProvider||"",allowedModelProviders:config.allowedModelProviders||[],modelPool:config.modelPool||[],maxModelCalls:config.maxModelCalls||14,maxModelTokens:config.maxModelTokens||300000,backgroundMaxCallsPerHour:config.backgroundMaxCallsPerHour||60,backgroundMaxTokensPerDay:config.backgroundMaxTokensPerDay||300000,pausedByHost:process.env.REPO_CANVAS_OBSERVE==="0",dialogSources:config.dialogSources!==false,providers:config.providers}});
      return;
    }
    if(request.method==="POST" && url.pathname==="/api/models/config") {
      guardMutation(request);const body=await readJson(request);
      if(architectJob)throw new HttpError(409,"Дождитесь завершения текущей модельной задачи");
      const patch=modelConfigPatch(body);
      if(body.maxModelCalls!==undefined)patch.maxModelCalls=Math.max(1,Math.min(50,Number(body.maxModelCalls)||14));
      if(body.maxModelTokens!==undefined)patch.maxModelTokens=Math.max(1000,Math.min(3000000,Number(body.maxModelTokens)||300000));
      if(body.backgroundMaxCallsPerHour!==undefined)patch.backgroundMaxCallsPerHour=Math.max(1,Math.min(200,Number(body.backgroundMaxCallsPerHour)||60));
      if(body.backgroundMaxTokensPerDay!==undefined)patch.backgroundMaxTokensPerDay=Math.max(1000,Math.min(3000000,Number(body.backgroundMaxTokensPerDay)||300000));
      if(body.dialogSources!==undefined)patch.dialogSources=body.dialogSources===true;
      if(body.enabled!==undefined)patch.enabled=body.enabled===true;
      if(body.resumeObservation===true)delete process.env.REPO_CANVAS_OBSERVE;
      const config=writeRuntimeConfig(patch);await configureObservation();sendJson(response,200,config);return;
    }
    if(request.method==="POST" && url.pathname==="/api/models/probe") {
      guardMutation(request);const body=await readJson(request);
      if(!["codex","claude","kimi"].includes(body.provider))throw new HttpError(400,"Неизвестный исполнитель");
      if(!startMapJob(()=>probeModel({cwd:projectRoot,provider:body.provider}),"probe"))throw new HttpError(409,"Уже выполняется модельная задача");
      sendJson(response,202,publicArchitectState());return;
    }
    if(request.method==="GET" && url.pathname==="/api/sources") {
      const index=readSourceJson(sourceIndexFile(projectRoot),{records:[],coverage:null});const config=readRuntimeConfig();
      const allowed=config.dialogSources===false?[]:index.records.filter(row=>config.providers.includes(row.provider)&&!config.excludedSourceFiles?.includes(row.file));
      sendJson(response,200,{coverage:index.coverage,records:allowed.map(({file,start,end,...row})=>row).slice(-200)});return;
    }
    if(request.method==="GET" && url.pathname==="/api/source") {
      const reference=url.searchParams.get("id")||"";
      const source=reference.startsWith("dialog:")?readDialogSource(projectRoot,reference):url.searchParams.has("checkpointId")?readHistoricalEvidence(projectRoot,await stateAtCheckpoint(url.searchParams.get("checkpointId")),reference):url.searchParams.has("commit")?await readGitSource(projectRoot,url.searchParams.get("commit"),reference):readCodeSource(projectRoot,reference);
      if(url.searchParams.get("view")==="file"&&!reference.startsWith("dialog:")) {
        if(source.error)throw new HttpError(404,source.error);
        const fullReference=source.path||reference.replace(/:(\d+)(?:[-:]\d+)?$/,"");
        const full=url.searchParams.has("checkpointId")?readHistoricalEvidence(projectRoot,await stateAtCheckpoint(url.searchParams.get("checkpointId")),fullReference):readCodeSource(projectRoot,fullReference,{maxChars:4*1024*1024});
        const value=full.error?source:full;
        const escape=text=>String(text||"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
        response.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'"});
        response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>${escape(fullReference)}</title><style>body{margin:24px;font:14px system-ui;color:#18212d;background:#fff}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 monospace}a{color:#245fd1}mark{background:#fff0a8}</style><h1>${escape(fullReference)}</h1><p>Источник описания на карте. ${full.error?"Показан сохранённый фрагмент.":""}</p><pre>${String(value.text||"").split("\n").map((line,index)=>{const number=(value.first||1)+index;return `<span id="L${number}">${number>=source.first&&number<=source.last?`<mark>${escape(line)}</mark>`:escape(line)}</span>`;}).join("\n")}</pre></html>`);return;
      }
      sendJson(response,200,source);return;
    }
    if(request.method==="POST" && url.pathname==="/api/questions") {
      guardMutation(request);const body=await readJson(request);const snapshot=body.checkpointId?await stateAtCheckpoint(body.checkpointId):getSnapshot();
      if(!startMapJob(options=>answerProjectQuestion({root:projectRoot,snapshot,question:body.question,...options}),"question"))throw new HttpError(409,"Уже выполняется модельная задача");
      sendJson(response,202,publicArchitectState());return;
    }
    if(request.method==="POST" && url.pathname==="/api/corrections") {
      guardMutation(request);const body=await readJson(request);
      if(!startMapJob(options=>runCorrection({root:projectRoot,kind:body.kind,id:body.id,instruction:body.instruction,action:body.action,otherId:body.otherId,...options}),"correction"))throw new HttpError(409,"Уже выполняется модельная задача");
      sendJson(response,202,publicArchitectState());return;
    }
    if(request.method==="POST" && url.pathname==="/api/corrections/undo") {
      guardMutation(request);const body=await readJson(request);sendJson(response,200,undoCorrection(body.id));return;
    }

    if (request.method === "POST" && url.pathname === "/api/architect/cancel") {
      guardMutation(request);
      if(architectJob){architectState={...architectState,cancelRequested:true};persistArchitectState();jobController?.abort();}
      sendJson(response,202,publicArchitectState());return;
    }
    if (request.method === "GET" && url.pathname === "/api/architect/status") {
      sendJson(response, 200, publicArchitectState());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/update/status") {
      const force = url.searchParams.get("refresh") === "1";
      sendJson(response, 200, await updateService.check({ force }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204, { "Cache-Control": "public, max-age=86400" });
      response.end();
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/sessions/open") {
      guardMutation(request);
      try {
        const node = findSessionNode(await readJson(request));
        const result = await openSessionLocator(node.session);
        sendJson(response, 200, { ok: true, ...result });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(502, `Could not open the work session: ${error.message}`);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/layout") {
      guardMutation(request);
      const result = saveLayout(await readJson(request));
      sendJson(response, 201, { ok: true, ...result,state:await currentHistoryState(result.state) });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/rename") {
      guardMutation(request);
      const result = saveRename(await readJson(request));
      sendJson(response, 201, { ok: true, ...result });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/architect/refresh") {
      guardMutation(request);
      const body = await readJson(request);
      const viewpoint = String(body.viewpoint || "").trim().slice(0, 1200);
      const reason=["manual","stale-sources","invalid-evidence","unreadable-evidence","verification-failed"].includes(body.reason)?body.reason:"manual";
      const started = startArchitectRefresh(viewpoint,reason);
      if(!started)throw new HttpError(409,"Сейчас выполняется другая проверка проекта. Обновление Canvas не запущено. Повторите после её завершения.");
      sendJson(response, 202, { ok: true, started, ...publicArchitectState() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/update/apply") {
      guardMutation(request);
      await readJson(request);
      try {
        sendJson(response, 202, updateService.apply());
      } catch (error) {
        throw new HttpError(409, error.message);
      }
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    await serveStatic(url.pathname, response, request.method === "HEAD");
  } catch (error) {
    const statusCode = error.statusCode || 400;
    sendJson(response, statusCode, { ok: false, error: error.message, ...(error.details || {}) });
  }
});

server.once("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Repo Canvas could not start: http://${host}:${port} is already in use. Choose another with --port <port>.`);
    process.exitCode = 1;
    return;
  }
  console.error(`Repo Canvas server error: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const canvasUrl = `http://${host}:${port}/`;
  console.log(`Repo Canvas root: ${projectRoot}`);
  console.log(`Repo Canvas listening at ${canvasUrl}`);
  openCanvasInBrowser(canvasUrl);
  updateService.check().catch(() => {});
  configureObservation().catch(error=>console.warn(`Observer: ${error.message}`));
});

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(streamTimer);for(const response of streamClients)response.end();streamClients.clear();
  console.log(`Repo Canvas received ${signal}; stopping.`);
  const deadline = setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(0);
  }, 5_000);
  deadline.unref();
  jobController?.abort();
  gitTracker?.stop();codeWatcher?.stop();
  stopGitProcesses();
  stopModelProcesses();
  const drained = observerService?.stop().catch((error) => console.error(`Observer shutdown error: ${error.message}`));
  server.close(async () => {
    await Promise.allSettled([drained,architectJob].filter(Boolean));
    clearTimeout(deadline);
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => server.closeAllConnections?.(), 100).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

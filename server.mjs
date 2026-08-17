import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { appendEvents, createEvent, getSnapshot, packageRoot, projectRoot } from "./repo-canvas/scripts/canvas-store.mjs";
import { runArchitect } from "./repo-canvas/scripts/architect.mjs";
import { startObserver } from "./repo-canvas/scripts/observer.mjs";
import { readOrCreateApiToken, readRuntimeConfig } from "./repo-canvas/scripts/runtime-config.mjs";
import { openSessionLocator } from "./repo-canvas/scripts/session-locator.mjs";
import { createUpdateService } from "./repo-canvas/scripts/update-service.mjs";

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
let architectJob = null;
let architectState = {
  status: "idle", phase: "idle", startedAt: null, heartbeatAt: null, finishedAt: null,
  attempt: 0, activityCount: 0, detail: null, result: null, error: null,
};
const updateService = createUpdateService({ host, port, apiToken, shutdown });

function publicArchitectState() {
  return {
    ...architectState,
    running: architectJob !== null,
    checkedAt: new Date().toISOString(),
    elapsedMs: architectState.startedAt ? Math.max(0, Date.now() - Date.parse(architectState.startedAt)) : 0,
  };
}

function architectProgress(progress = {}) {
  architectState = {
    ...architectState,
    phase: progress.phase || architectState.phase || "reasoning",
    heartbeatAt: progress.at || new Date().toISOString(),
    attempt: Number.isInteger(progress.attempt) ? progress.attempt : architectState.attempt,
    activityCount: architectState.activityCount + 1,
    detail: progress.detail || null,
  };
}

function startArchitectRefresh(viewpoint = "") {
  if (architectJob) return false;
  const startedAt = new Date().toISOString();
  architectState = {
    status: "running", phase: "starting", startedAt, heartbeatAt: startedAt, finishedAt: null,
    attempt: 0, activityCount: 0, detail: null, result: null, error: null,
  };
  architectJob = runArchitect({ refresh: true, viewpoint, onProgress: architectProgress })
    .then((result) => {
      const finishedAt = new Date().toISOString();
      architectState = { ...architectState, status: "done", phase: "done", heartbeatAt: finishedAt, finishedAt, result, error: null, detail: null };
    })
    .catch((error) => {
      const finishedAt = new Date().toISOString();
      architectState = {
        ...architectState, status: "failed", phase: "failed", heartbeatAt: finishedAt, finishedAt,
        result: null, error: String(error?.message || error).slice(0, 500), detail: null,
      };
    })
    .finally(() => { architectJob = null; });
  return true;
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

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new HttpError(413, "Request body exceeds 1 MiB");
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
  const snapshot = getSnapshot();
  if (snapshot.storeErrors.length) throw new HttpError(409, "Repo Canvas store must pass check before saving layout");
  if (requestedRevision !== snapshot.revision) throw new HttpError(409, "Canvas changed; refresh before saving layout", { revision: snapshot.revision });
  const areas = new Map(snapshot.areas.map((item) => [item.id, item]));
  const entities = new Map(snapshot.entities.map((item) => [item.id, item]));
  const seen = new Set();
  const events = body.items.map((item) => {
    const kind = String(item?.kind || ""); const id = String(item?.id || "").trim();
    const x = Number(item?.x); const y = Number(item?.y); const key = `${kind}:${id}`;
    if (!id || seen.has(key)) throw new HttpError(400, "Each layout item must have a unique id and kind");
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new HttpError(400, `Layout coordinates must be finite for ${key}`);
    seen.add(key);
    if (kind === "area") {
      const current = areas.get(id); if (!current) throw new HttpError(404, `Area not found: ${id}`);
      const { actor, updatedAt, ...payload } = current;
      return createEvent("area.upsert", { actor: "owner", payload: { ...payload, x, y } });
    }
    if (kind === "entity") {
      const current = entities.get(id); if (!current) throw new HttpError(404, `Entity not found: ${id}`);
      const { actor, updatedAt, ...payload } = current;
      return createEvent("entity.upsert", { actor: "owner", payload: { ...payload, x, y } });
    }
    throw new HttpError(400, `Unsupported layout item kind: ${kind}`);
  });
  try {
    appendEvents(events, { expectedRevision: requestedRevision });
  } catch (error) {
    if (error.code === "STALE_REVISION") throw new HttpError(409, "Canvas changed; refresh before saving layout", { revision: error.currentRevision });
    throw error;
  }
  return { revision: requestedRevision + events.length, saved: events.length };
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
      "Cache-Control": "no-store",
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
      sendJson(response, 200, getSnapshot());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/revision") {
      const snapshot = getSnapshot();
      sendJson(response, 200, { revision: snapshot.revision, updatedAt: snapshot.updatedAt });
      return;
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
      sendJson(response, 201, { ok: true, ...result });
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
      const started = startArchitectRefresh(viewpoint);
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
  if (runtimeConfig.enabled && getSnapshot().semantic) {
    observerService = startObserver({ config: runtimeConfig });
    console.log(`Repo Canvas observer: ${observerService.observer.adapters.map((item) => item.id).join(", ")} sessions for ${runtimeConfig.repoRoot}`);
  }
});

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Repo Canvas received ${signal}; stopping.`);
  const deadline = setTimeout(() => {
    server.closeAllConnections?.();
    process.exit(0);
  }, 1_500);
  deadline.unref();
  observerService?.stop().catch((error) => console.error(`Observer shutdown error: ${error.message}`));
  server.close(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => server.closeAllConnections?.(), 100).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

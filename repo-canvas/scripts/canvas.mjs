#!/usr/bin/env node

import path from "node:path";

const [, , command = "help", ...rawArgs] = process.argv;

function parseArgs(args) {
  const parsed = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function required(args, key) {
  const value = args[key];
  if (value === undefined || value === true || String(value).trim() === "") {
    throw new Error(`Missing required option --${key}`);
  }
  return String(value);
}

function optionalNumber(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, received ${value}`);
  return parsed;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function list(value) {
  if (value === undefined || value === true || String(value).trim() === "") return undefined;
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function inferSession(args, status) {
  const explicitSurface = Boolean(args.surface);
  if (!explicitSurface && !new Set(["active", "changed"]).has(status)) return undefined;
  let kind = explicitSurface ? String(args.surface) : "";
  let id = args.session ? String(args.session) : "";

  if (!kind && process.env.CODEX_THREAD_ID) {
    kind = /desktop/i.test(process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || "") ? "codex-app" : "codex-cli";
    id = process.env.CODEX_THREAD_ID;
  }
  if (!kind && process.env.CLAUDE_CODE_SESSION_ID) {
    kind = "claude-cli";
    id = process.env.CLAUDE_CODE_SESSION_ID;
  }
  if (!kind && (process.env.KIMI_SESSION_ID || process.env.KIMI_CODE_SESSION_ID)) {
    kind = "kimi-cli";
    id = process.env.KIMI_SESSION_ID || process.env.KIMI_CODE_SESSION_ID;
  }
  if (!kind) return undefined;

  return compact({
    kind,
    id: id || undefined,
    title: args["session-title"] ? String(args["session-title"]) : undefined,
    pid: optionalNumber(args.pid),
    cwd: args.cwd ? path.resolve(process.cwd(), String(args.cwd)) : process.cwd(),
  });
}

function printHelp() {
  console.log(`Repo Canvas CLI

Commands:
  init        Initialize local runtime scripts and ignored state
  start       Run the foreground loopback canvas server
  area        Upsert a large semantic project area
  entity      Upsert a persistent module or responsibility
  relation    Upsert a structural relation between entities
  work        Upsert a small agent-work satellite attached to entities
  log         Record a decision or verification result
  snapshot    Print the reduced canvas state
  check       Validate the event log and print a summary
  repair      Preview corrupt-line recovery; add --apply to repair
  setup       Initialize, verify Codex, build the first semantic map and enable observation
  doctor      Verify subscription-backed Codex access
  architect   Build the first map; add --refresh to reconcile an existing map
  observer    Manage repository-scoped session observation: enable, disable, once, start, status

Global options:
  --root <path>  Explicit repository root
  --port <port>  Server port for start (default 4173)

Examples:
  repo-canvas init
  repo-canvas start
  repo-canvas area --id knowledge --title "Knowledge base" --order 1
  repo-canvas entity --id search --area knowledge --label "Standards search" --status operational --path src/search
  repo-canvas relation --from search --to registry --label "reads"
  repo-canvas work --id improve-search --title "Improve matching" --targets search --status active --actor codex
  repo-canvas setup
  repo-canvas architect --refresh
  repo-canvas observer status
`);
}

const args = parseArgs(rawArgs);
if (args.root === true) {
  console.error("Repo Canvas error: --root requires a path");
  process.exitCode = 1;
} else {
  if (args.root) process.env.REPO_CANVAS_ROOT = path.resolve(process.cwd(), String(args.root));

  try {
    if (command === "help" || command === "--help" || command === "-h") {
      printHelp();
    } else if (command === "start" || command === "serve") {
      if (args.port !== undefined) process.env.CANVAS_PORT = String(args.port);
      if (args.host !== undefined) process.env.CANVAS_HOST = String(args.host);
      await import("../../server.mjs");
    } else if (command === "init") {
      const { runInit } = await import("./canvas-init.mjs");
      runInit({
        upgrade: Boolean(args.upgrade),
        installSpec: args["install-spec"] && args["install-spec"] !== true ? String(args["install-spec"]) : null,
      });
    } else if (command === "doctor") {
      const { probeCodex } = await import("./model-runtime.mjs");
      const result = await probeCodex({ cwd: process.env.REPO_CANVAS_ROOT || process.cwd() });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "connected") process.exitCode = 1;
    } else if (command === "architect") {
      const { runArchitect } = await import("./architect.mjs");
      const result = await runArchitect({
        refresh: Boolean(args.refresh),
        model: args.model && args.model !== true ? String(args.model) : undefined,
        effort: args.effort && args.effort !== true ? String(args.effort) : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "setup") {
      const { runInit } = await import("./canvas-init.mjs");
      const { probeCodex } = await import("./model-runtime.mjs");
      const { runArchitect } = await import("./architect.mjs");
      const { getSnapshot } = await import("./canvas-store.mjs");
      const { writeRuntimeConfig } = await import("./runtime-config.mjs");
      runInit({
        upgrade: Boolean(args.upgrade),
        installSpec: args["install-spec"] && args["install-spec"] !== true ? String(args["install-spec"]) : null,
      });
      const probe = await probeCodex({ cwd: process.env.REPO_CANVAS_ROOT || process.cwd() });
      if (probe.status !== "connected") throw new Error(`Codex subscription is not available: ${probe.error || "probe failed"}`);
      let architect = null;
      if (!getSnapshot().semantic || args.refresh) {
        architect = await runArchitect({
          refresh: Boolean(args.refresh),
          model: args.model && args.model !== true ? String(args.model) : undefined,
          effort: args.effort && args.effort !== true ? String(args.effort) : undefined,
        });
      }
      const observer = writeRuntimeConfig({ enabled: true, providers: ["codex", "claude", "kimi", "qwen", "grok"] });
      console.log(JSON.stringify({ ok: true, probe, architect, observer }, null, 2));
    } else if (command === "observer") {
      const action = args._[0] || "status";
      const { readRuntimeConfig, writeRuntimeConfig } = await import("./runtime-config.mjs");
      if (action === "enable") {
        console.log(JSON.stringify(writeRuntimeConfig({ enabled: true, providers: ["codex", "claude", "kimi", "qwen", "grok"] }), null, 2));
      } else if (action === "disable") {
        console.log(JSON.stringify(writeRuntimeConfig({ enabled: false }), null, 2));
      } else if (action === "status") {
        console.log(JSON.stringify(readRuntimeConfig(), null, 2));
      } else if (action === "once") {
        const { runObserverOnce } = await import("./observer.mjs");
        console.log(JSON.stringify(await runObserverOnce({ replay: Boolean(args.replay) }), null, 2));
      } else if (action === "start") {
        const { startObserver } = await import("./observer.mjs");
        const service = startObserver();
        console.log(`Repo Canvas observer watching ${service.observer.config.repoRoot} via ${service.observer.adapters.map((item) => item.id).join(", ")}`);
        await new Promise((resolve) => {
          const stop = async () => { await service.stop(); resolve(); };
          process.once("SIGINT", stop); process.once("SIGTERM", stop);
        });
      } else {
        throw new Error(`Unknown observer action: ${action}`);
      }
    } else {
      const { appendEvent, createEvent, getSnapshot, repairStore } = await import("./canvas-store.mjs");
      const emit = (type, actor, payload) => {
        const event = appendEvent(createEvent(type, { actor, payload: compact(payload) }));
        console.log(JSON.stringify(event, null, 2));
      };

      if (command === "area") {
        emit("area.upsert", args.actor || "unknown", {
          id: required(args, "id"),
          title: required(args, "title"),
          note: args.note || "",
          x: optionalNumber(args.x), y: optionalNumber(args.y),
          width: optionalNumber(args.width), height: optionalNumber(args.height),
          order: optionalNumber(args.order),
        });
      } else if (command === "entity") {
        emit("entity.upsert", args.actor || "unknown", {
          id: required(args, "id"),
          areaId: required(args, "area"),
          label: required(args, "label"),
          status: args.status || "operational",
          path: args.path || "",
          purpose: args.purpose || "",
          note: args.note || "",
          inputs: list(args.inputs), outputs: list(args.outputs), dependsOn: list(args.depends),
          x: optionalNumber(args.x), y: optionalNumber(args.y), order: optionalNumber(args.order),
        });
      } else if (command === "relation") {
        const from = required(args, "from");
        const to = required(args, "to");
        emit("relation.upsert", args.actor || "unknown", {
          id: args.id || `${from}->${to}`,
          from, to,
          label: args.label || "",
          status: args.status || "existing",
        });
      } else if (command === "work") {
        const status = args.status || "planned";
        emit("work.upsert", args.actor || "unknown", {
          id: required(args, "id"), title: required(args, "title"), status,
          targets: list(required(args, "targets")), note: args.note || "", session: inferSession(args, status),
        });
      } else if (command === "log") {
        emit("activity.log", args.actor || "unknown", {
          message: required(args, "message"),
          level: args.level || "info",
        });
      } else if (command === "snapshot") {
        console.log(JSON.stringify(getSnapshot(), null, 2));
      } else if (command === "check") {
        const snapshot = getSnapshot();
        if (snapshot.storeErrors.length) {
          console.error(JSON.stringify(snapshot.storeErrors, null, 2));
          process.exitCode = 1;
        } else {
          console.log(
            `Repo Canvas OK — revision ${snapshot.revision}, ${snapshot.summary.areaCount} areas, ${snapshot.summary.entityCount} entities, ${snapshot.summary.activeWork} active work.`,
          );
        }
      } else if (command === "repair") {
        const result = repairStore({ apply: Boolean(args.apply) });
        console.log(JSON.stringify(result, null, 2));
        if (!args.apply && result.removableLines.length) process.exitCode = 2;
      } else {
        throw new Error(`Unknown command: ${command}`);
      }
    }
  } catch (error) {
    console.error(`Repo Canvas error: ${error.message}`);
    process.exitCode = 1;
  }
}

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

function configuredCodexModel() {
  try { return readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml"), "utf8").split(/^\[/m)[0].match(/^model\s*=\s*"([^"]+)"/m)?.[1] || ""; } catch { return ""; }
}
const configuredModel = configuredCodexModel();
export const MODEL_PROFILES = Object.freeze({
  architect: Object.freeze({
    model: process.env.REPO_CANVAS_ARCHITECT_MODEL || configuredModel,
    effort: process.env.REPO_CANVAS_ARCHITECT_EFFORT || "medium",
  }),
  observer: Object.freeze({
    model: process.env.REPO_CANVAS_OBSERVER_MODEL || configuredModel,
    effort: process.env.REPO_CANVAS_OBSERVER_EFFORT || "low",
  }),
  reviewer: Object.freeze({
    model: process.env.REPO_CANVAS_REVIEWER_MODEL || configuredModel,
    effort: process.env.REPO_CANVAS_REVIEWER_EFFORT || "low",
  }),
});

const PLATFORM_PACKAGE_BY_TARGET = Object.freeze({
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
});

const require = createRequire(import.meta.url);

export function codexTarget(platform = process.platform, arch = process.arch) {
  const triples = {
    linux: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
    android: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
    darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
    win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
  };
  const targetTriple = triples[platform]?.[arch];
  const packageName = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
  if (!targetTriple || !packageName) throw new Error(`Unsupported platform: ${platform} (${arch})`);
  return { targetTriple, packageName, binaryName: platform === "win32" ? "codex.exe" : "codex" };
}

export function resolveCodexExecutable(platform = process.platform, arch = process.arch) {
  const target = codexTarget(platform, arch);
  // A checkout's explicit development dependency takes precedence, as with
  // normal npm tools. Published packages do not install it; they use PATH.
  try {
    const manifest=require.resolve(`${target.packageName}/package.json`);
    const local=path.join(path.dirname(manifest),"vendor",target.targetTriple,"bin",target.binaryName);
    if(existsSync(local))return local;
  } catch {}
  for(const directory of (process.env.PATH||"").split(path.delimiter)) {
    const direct=path.join(directory,target.binaryName);if(existsSync(direct))return direct;
    const globalBinary=path.join(directory,"node_modules",target.packageName,"vendor",target.targetTriple,"bin",target.binaryName);
    if(existsSync(globalBinary))return globalBinary;
    const nestedBinary=path.join(directory,"node_modules","@openai","codex","node_modules",target.packageName,"vendor",target.targetTriple,"bin",target.binaryName);
    if(existsSync(nestedBinary))return nestedBinary;
  }
  throw new Error("Codex CLI не найден. Установите его отдельно: npm install -g @openai/codex, затем выполните codex login.");
}

const modelProcesses = new Set();
export function trackModelProcess(child) { modelProcesses.add(child); return () => modelProcesses.delete(child); }
export function stopModelProcesses() {
  for (const child of modelProcesses) {
    if (!child.pid) continue;
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    else child.kill();
  }
}
function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return { controller, clear: () => clearTimeout(timer) };
}

async function outputSchemaFile(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("outputSchema must be an object");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "repo-canvas-schema-"));
  const schemaPath = path.join(directory, "schema.json");
  await fs.writeFile(schemaPath, JSON.stringify(schema), "utf8");
  return { schemaPath, cleanup: () => fs.rm(directory, { recursive: true, force: true }).catch(() => {}) };
}

function parseStructuredResponse(finalResponse) {
  if (typeof finalResponse !== "string" || !finalResponse.trim()) throw new Error("Codex returned an empty structured response");
  try { return JSON.parse(finalResponse); }
  catch (error) { throw new Error(`Codex returned invalid JSON: ${error.message}`); }
}

export async function createIsolatedCodexHome(sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
  const sourceAuth = path.join(sourceHome, "auth.json");
  try { await fs.access(sourceAuth); }
  catch { throw new Error(`Codex subscription authentication was not found: ${sourceAuth}`); }
  // Codex's Windows helper binaries refuse homes under the OS temporary folder.
  // Keep isolation outside the repository and outside TEMP; each session still cleans up.
  const runRoot=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),".cache"),"RepoCanvas","codex-runs");
  await fs.mkdir(runRoot,{recursive:true,mode:0o700});
  const directory = await fs.mkdtemp(path.join(runRoot, "session-"));
  const linkedAuth = path.join(directory, "auth.json");
  try {
    try { await fs.link(sourceAuth, linkedAuth); }
    catch { await fs.symlink(sourceAuth, linkedAuth, "file"); }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Repo Canvas could not isolate Codex authentication: ${error.message}`);
  }
  return { directory, cleanup: () => fs.rm(directory, { recursive: true, force: true }).catch(() => {}) };
}

function isolatedCodexEnvironment(codexHome) {
  const env = { ...process.env, CODEX_HOME: codexHome, REPO_CANVAS_INTERNAL_SESSION: "1", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "repo_canvas" };
  for (const key of ["CODEX_THREAD_ID", "CODEX_THREAD_SOURCE", "CODEX_SPAWNED_BY"]) delete env[key];
  return env;
}

export function codexCommandArguments({ cwd, profile, schemaPath }) {
  return [
    "exec", "--experimental-json", ...(profile.model ? ["--model", profile.model] : []), "--sandbox", "read-only", "--cd", cwd,
    "--skip-git-repo-check", "--output-schema", schemaPath,
    "--config", `model_reasoning_effort=${JSON.stringify(profile.effort)}`,
    "--config", "web_search=\"disabled\"", "--config", "approval_policy=\"never\"",
    "--config", "mcp_servers={}", "--config", "project_doc_max_bytes=0",
    "--disable", "apps", "--disable", "browser_use", "--disable", "computer_use",
    "--disable", "hooks", "--disable", "memories", "--disable", "multi_agent",
    "--disable", "plugins", "--disable", "shell_tool", "--disable", "unified_exec",
  ];
}

export function codexResumeCommandArguments({ threadId, profile, schemaPath }) {
  if (!threadId) throw new Error("A Codex thread id is required to resume a structured session");
  return [
    "exec", "resume", "--json", ...(profile.model ? ["--model", profile.model] : []),
    "--skip-git-repo-check", "--output-schema", schemaPath,
    "--config", `model_reasoning_effort=${JSON.stringify(profile.effort)}`,
    "--config", "web_search=\"disabled\"", "--config", "approval_policy=\"never\"",
    "--config", "mcp_servers={}", "--config", "project_doc_max_bytes=0",
    "--disable", "apps", "--disable", "browser_use", "--disable", "computer_use",
    "--disable", "hooks", "--disable", "memories", "--disable", "multi_agent",
    "--disable", "plugins", "--disable", "shell_tool", "--disable", "unified_exec",
    threadId, "-",
  ];
}

export function codexProcessOptions(env = isolatedCodexEnvironment()) {
  return { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true };
}

function progressPhase(event) {
  if (event.type === "thread.started" || event.type === "turn.started") return "starting";
  if (event.type === "item.started" || event.type === "item.completed") {
    if (event.item?.type === "command_execution" || event.item?.type === "mcp_tool_call") return "inspecting";
    if (event.item?.type === "agent_message") return "validating";
    return "reasoning";
  }
  if (event.type === "turn.completed") return "validating";
  return "reasoning";
}

function report(onProgress, payload) {
  try { onProgress?.({ ...payload, at: new Date().toISOString() }); } catch { /* progress must not break the model call */ }
}

export async function createCodexStructuredSession({
  cwd,
  profile = MODEL_PROFILES.architect,
  executable = resolveCodexExecutable(),
} = {}) {
  if (!cwd) throw new Error("A working directory is required for a persistent Codex session");
  const home = await createIsolatedCodexHome();
  let closed = false;
  return {
    cwd,
    profile,
    executable,
    codexHome: home.directory,
    threadId: null,
    turns: 0,
    get closed() { return closed; },
    async close() {
      if (closed) return;
      closed = true;
      await home.cleanup();
    },
  };
}

export async function runCodexStructured({
  role,
  cwd,
  prompt,
  outputSchema,
  timeoutMs = role === "architect" ? 30 * 60_000 : role === "observer" ? 90_000 : 8 * 60_000,
  profile = MODEL_PROFILES[role],
  onProgress,
  executable = resolveCodexExecutable(),
  session = null,
  signal,
}) {
  if (!profile) throw new Error(`Unknown model role '${role}'`);
  if (session?.closed) throw new Error("Codex structured session is already closed");
  if (session && path.resolve(session.cwd) !== path.resolve(cwd)) throw new Error("Codex structured session cannot change its working directory");
  if (session && session.profile.model !== profile.model) throw new Error("Codex structured session cannot change its model");
  const { controller, clear } = timeoutSignal(timeoutMs);
  const schema = await outputSchemaFile(outputSchema);
  let codexHome = null;
  let child = null;
  let lines = null;
  try {
    codexHome = session ? { directory: session.codexHome, cleanup: async () => {} } : await createIsolatedCodexHome();
    const resuming = Boolean(session?.threadId);
    const command = resuming
      ? codexResumeCommandArguments({ threadId: session.threadId, profile, schemaPath: schema.schemaPath })
      : codexCommandArguments({ cwd, profile, schemaPath: schema.schemaPath });
    child = spawn(session?.executable || executable, command, {
      ...codexProcessOptions(isolatedCodexEnvironment(codexHome.directory)), signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    modelProcesses.add(child);
    report(onProgress, { phase: "starting", eventType: "process.started", pid: child.pid || null, resumed: resuming });
    const stderr = [];
    let stderrBytes = 0;
    child.stderr?.on("data", (chunk) => {
      if (stderrBytes >= 1024 * 1024) return;
      const bounded = Buffer.from(chunk).subarray(0, 1024 * 1024 - stderrBytes);
      stderr.push(bounded); stderrBytes += bounded.length;
    });
    // stdout is consumed before awaiting this outcome. Rejecting here would be
    // an unhandled rejection while the stream is still closing after an abort.
    const exit = new Promise((resolve) => {
      child.once("error", error => resolve({ error }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (!child.stdin || !child.stdout) throw new Error("Codex process did not expose stdio");
    child.stdin.on("error", () => {});
    child.stdin.end(prompt, "utf8");
    lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let finalResponse = "";
    let threadId = null;
    let usage = null;
    let failure = null;
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); }
      catch { throw new Error("Codex emitted an invalid JSON event"); }
      const reconnecting=event.type==="error"&&/^Reconnecting/i.test(event.message||event.error?.message||"");
      report(onProgress, { phase: progressPhase(event), eventType: reconnecting?"connection.retrying":event.type });
      if (event.type === "thread.started") threadId = event.thread_id || null;
      if (event.type === "item.completed" && event.item?.type === "agent_message") finalResponse = event.item.text || "";
      // A reconnect error is provisional. A completed turn supersedes it;
      // fatal turn.failed or a nonzero process exit still fails below.
      if (event.type === "turn.completed") {usage = event.usage || null;failure=null;}
      if (event.type === "turn.failed") failure = event.error?.message || "Codex turn failed";
      if (event.type === "error") failure = event.message || event.error?.message || "Codex runtime error";
    }
    const outcome = await exit;
    if (outcome.error) throw outcome.error;
    if (failure) throw new Error(failure);
    if (outcome.code !== 0 || outcome.signal) {
      const detail = outcome.signal ? `signal ${outcome.signal}` : `code ${outcome.code ?? 1}`;
      throw new Error(`Codex Exec exited with ${detail}: ${Buffer.concat(stderr).toString("utf8").trim()}`);
    }
    if (session) {
      if (!session.threadId && threadId) session.threadId = threadId;
      if (!session.threadId) throw new Error("Codex did not return a thread id for the persistent Architect session");
      session.turns += 1;
    }
    report(onProgress, { phase: "validating", eventType: "process.completed" });
    return { value: parseStructuredResponse(finalResponse), threadId: session?.threadId || threadId, profile, usage, resumed: resuming };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${role} model timed out after ${timeoutMs} ms`);
    throw error;
  } finally {
    clear(); lines?.close();
    modelProcesses.delete(child);
    try { if (child && !child.killed) child.kill(); } catch { /* process already ended */ }
    await schema.cleanup();
    if (!session) await codexHome?.cleanup();
  }
}

export async function probeCodex({ cwd = os.tmpdir() } = {}) {
  const schema = {
    type: "object", additionalProperties: false,
    properties: { answer: { type: "integer", enum: [4] } }, required: ["answer"],
  };
  const startedAt = Date.now();
  try {
    const result = await runCodexStructured({
      role: "observer", cwd, prompt: "What is 2+2? Return only the required structured answer.",
      outputSchema: schema, timeoutMs: 45_000,
    });
    return { provider: "codex", status: result.value.answer === 4 ? "connected" : "not-connected", model: result.profile.model, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { provider: "codex", status: "not-connected", model: MODEL_PROFILES.observer.model, latencyMs: Date.now() - startedAt, error: error.message };
  }
}

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { SESSION_SURFACES } from "./canvas-schema.mjs";

const execFileAsync = promisify(execFile);

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function requireSafeId(locator) {
  const id = String(locator.id || "").trim();
  if (!SAFE_SESSION_ID.test(id)) throw new Error(`Invalid ${locator.kind} session id`);
  return id;
}

function quoteDisplayArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9._:/\\-]+$/.test(text) ? text : `"${text.replaceAll('"', '\\"')}"`;
}

export function resolveSessionTarget(locator) {
  if (!locator || !SESSION_SURFACES.has(locator.kind)) return null;

  if (locator.kind === "codex-app") {
    const id = requireSafeId(locator);
    return { mode: "external", uri: `codex://threads/${encodeURIComponent(id)}`, exact: true, label: "Codex" };
  }

  if (locator.kind === "claude-app") {
    const id = requireSafeId(locator);
    return { mode: "external", uri: `claude://claude.ai/chat/${encodeURIComponent(id)}`, exact: true, label: "Claude" };
  }

  if (locator.kind === "kimi-app") {
    return {
      mode: "external",
      uri: "kimi-work://open",
      exact: false,
      label: "Kimi Work",
      reason: "Kimi Work 3.1 opens the Work surface but does not expose an exact-conversation deep link.",
    };
  }

  const id = requireSafeId(locator);
  const commands = {
    "codex-cli": { binary: "codex", args: ["resume", id], label: "Codex CLI" },
    "claude-cli": { binary: "claude", args: ["--resume", id], label: "Claude Code" },
    "kimi-cli": { binary: "kimi", args: ["-r", id], label: "Kimi CLI" },
    "qwen-cli": { binary: "qwen", args: ["--resume", id], label: "Qwen Code" },
    "grok-cli": { binary: "grok", args: ["--resume", id], label: "Grok" },
  };
  const command = commands[locator.kind];
  return {
    mode: "terminal",
    ...command,
    command: [command.binary, ...command.args].map(quoteDisplayArg).join(" "),
    exact: true,
  };
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

async function focusWindowsProcessTree(pid) {
  const script = String.raw`
$targetProcessId = [int]$args[0]
$seen = @{}
Add-Type -AssemblyName Microsoft.VisualBasic
while ($targetProcessId -gt 0 -and -not $seen.ContainsKey($targetProcessId)) {
  $seen[$targetProcessId] = $true
  try {
    $candidate = Get-Process -Id $targetProcessId -ErrorAction Stop
    if ($candidate.MainWindowHandle -ne 0) {
      if ([Microsoft.VisualBasic.Interaction]::AppActivate($candidate.Id)) { exit 0 }
    }
    $record = Get-CimInstance Win32_Process -Filter "ProcessId = $targetProcessId" -ErrorAction Stop
    $targetProcessId = [int]$record.ParentProcessId
  } catch { break }
}
exit 2
`;
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script, String(pid)],
      { timeout: 2_500, windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

async function focusMacProcess(pid) {
  try {
    await execFileAsync(
      "osascript",
      ["-e", `tell application "System Events" to set frontmost of first application process whose unix id is ${pid} to true`],
      { timeout: 2_500 },
    );
    return true;
  } catch {
    return false;
  }
}

async function focusLinuxProcess(pid) {
  try {
    const { stdout } = await execFileAsync("wmctrl", ["-lp"], { timeout: 2_500 });
    const windowId = stdout.split(/\r?\n/).find((line) => line.trim().split(/\s+/)[2] === String(pid))?.trim().split(/\s+/)[0];
    if (!windowId) return false;
    await execFileAsync("wmctrl", ["-ia", windowId], { timeout: 2_500 });
    return true;
  } catch {
    return false;
  }
}

export async function focusProcessTree(pid, platform = process.platform) {
  if (!processIsAlive(pid)) return false;
  if (platform === "win32") return focusWindowsProcessTree(pid);
  if (platform === "darwin") return focusMacProcess(pid);
  if (platform === "linux") return focusLinuxProcess(pid);
  return false;
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function openExternalUri(uri, platform = process.platform) {
  if (platform === "win32") return spawnDetached("rundll32.exe", ["url.dll,FileProtocolHandler", uri]);
  if (platform === "darwin") return spawnDetached("open", [uri]);
  return spawnDetached("xdg-open", [uri]);
}

export async function openSessionLocator(locator) {
  const target = resolveSessionTarget(locator);
  if (!target) throw new Error("This node has no supported work-session locator");

  if (target.mode === "external") {
    await openExternalUri(target.uri);
    return {
      outcome: target.exact ? "opened" : "surface-opened",
      exact: target.exact,
      label: target.label,
      title: locator.title || "",
      reason: target.reason || "",
    };
  }

  if (locator.pid && await focusProcessTree(Number(locator.pid))) {
    return { outcome: "focused", exact: true, label: target.label, title: locator.title || "" };
  }

  return {
    outcome: "resume",
    exact: true,
    label: target.label,
    title: locator.title || "",
    command: target.command,
    cwd: locator.cwd || "",
  };
}

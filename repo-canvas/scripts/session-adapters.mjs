import { listCodexSessionFiles, readSessionMeta, sessionBelongsToRepository, sessionSignals } from "./codex-sessions.mjs";
import { claudeSessionAdapter } from "./claude-sessions.mjs";
import { kimiSessionAdapter } from "./kimi-sessions.mjs";
import { qwenSessionAdapter } from "./qwen-sessions.mjs";
import { grokSessionAdapter } from "./grok-sessions.mjs";

function codexLocator(meta, firstUserMessage = "") {
  return {
    kind: /desktop/i.test(meta.originator || "") ? "codex-app" : "codex-cli",
    id: meta.id || meta.session_id,
    title: firstUserMessage.slice(0, 160) || "Observed Codex work",
    cwd: meta.cwd,
  };
}

export const codexSessionAdapter = Object.freeze({
  id: "codex",
  listFiles: listCodexSessionFiles,
  readMeta: readSessionMeta,
  belongsToRepository: sessionBelongsToRepository,
  signals: sessionSignals,
  locator: codexLocator,
});

const adapters = new Map([
  [codexSessionAdapter.id, codexSessionAdapter],
  [claudeSessionAdapter.id, claudeSessionAdapter],
  [kimiSessionAdapter.id, kimiSessionAdapter],
  [qwenSessionAdapter.id, qwenSessionAdapter],
  [grokSessionAdapter.id, grokSessionAdapter],
]);

export function sessionAdapter(id) {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`Unsupported session provider '${id}'`);
  return adapter;
}

export function sessionAdapters(ids = ["codex", "claude", "kimi", "qwen", "grok"]) {
  return [...new Set(ids)].map(sessionAdapter);
}

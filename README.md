# Repo Canvas

**Understand a large repository at a glance and see where coding agents are working right now.**

Repo Canvas builds a local, Miro-like map of an existing project. Permanent areas, modules and relations show how the system fits together. Live work cards show what Codex, Claude Code and Kimi Code sessions are changing. Double-click a work card to return to that session.

## Install with your coding agent

Send your agent this repository URL and one sentence:

```text
https://github.com/m0ast-git/repo-canvas
Install this project-visualization tool in the current repository, build the initial map, start it and give me the local Canvas URL.
```

The agent will follow [`INSTALL_WITH_AGENT.txt`](INSTALL_WITH_AGENT.txt). The exact commands are:

```text
npm install --save-dev --save-exact --ignore-scripts github:m0ast-git/repo-canvas#v0.11.0
npx --no-install repo-canvas setup
npm run repo-canvas:start
```

The server opens the protected loopback URL in your default browser. Keep that foreground terminal running while you use the Canvas.

## What you see

- project areas that group related parts of the system;
- persistent modules, responsibilities, stores, pipeline stages and integrations;
- circular human participants outside project areas, with directed relations showing what they provide, decide, expect or receive;
- meaningful runtime, data and control-flow relations;
- a provisional work card as soon as a supported agent turn is observed;
- live work attached to every semantic entity it affects;
- entity passports and recent activity in the left rail;
- collapsible project sections, full-map reset and an in-canvas legend;
- draggable area headers and entity cards with immediate, saved movement of their nested contents;
- owner-controlled area and entity names and descriptions, plus relation labels, by double-clicking the object;
- light and dark themes, readable active-area emphasis and relation labels revealed by a forgiving line hover;
- distinct header controls for reloading current Canvas data and regenerating the semantic map with Architect;
- a persistent Architect status surface with current phase, heartbeat, elapsed time, validation repair and the final result;
- a local Update button that appears only when a newer verified release is available;
- direct navigation back to Codex App or an exact Codex, Claude Code or Kimi Code CLI resume command.

The data model has no fixed entity cap. One Canvas can hold a small project or a map with hundreds of semantic entities.

The map keeps one stable project geography at every zoom: areas, nested capabilities and concrete entities never disappear or jump to another composition. Zoom only changes where live activity is emphasized: an area while cards are too small to read, the affected entity at middle distance, and the exact agent work card when it becomes readable. Area colors also identify outgoing relations. React Flow keeps interaction smooth while ELK computes the composition off the main UI thread; the relation router reserves separate lanes and keeps labels outside cards.

Dragging empty canvas space always moves the camera. An area moves from its framed header; an entity moves from its card. The small `⠿` mark identifies those draggable surfaces, while the surrounding area body remains available for panning.

## How it works

`setup` checks the local Codex connection, then runs a read-only Architect with `gpt-5.6-sol` at medium reasoning. Architect inventories current repository truth once, identifies responsibility boundaries and builds the map in the owner's working language. Its isolated headless session stays available for the whole acceptance cycle: every structural correction and reviewer response resumes the same Sol thread instead of starting another repository inspection. Human-visible labels explain the product instead of copying unexplained code jargon. A human role appears only when the product genuinely involves that participant; it stays outside project-owned areas and is connected to the exact responsibility it touches.

Before anything is written, Repo Canvas validates area membership, hierarchy, evidence paths, relation endpoints, removal references, participant placement and every end-to-end flow step. If the model returns an inconsistent cross-reference, the exact error returns to the same Sol session through a bounded repair using an explicit enum of allowed ids. A separate `gpt-5.6-luna` reviewer sees only the proposed map and answers what the project does, how it is divided and how its main lifecycle works. Each critical issue must point to an exact existing map id. Sol may refine that area and its necessary adjacent relations, while deterministic scope checks prevent changes to unrelated areas. The reviewer repeats until the map passes or the bounded focused-repair limit is exhausted; an incomprehensible result is never applied.

When the Canvas server is running, Observer watches public local session journals for this repository. It creates a provisional card on the first observed turn event, then uses `gpt-5.6-luna` at low reasoning to classify small event deltas and attach the work to the map. On completion, Observer updates affected passports and relations when the session contains enough evidence.

Observer supports:

| Agent surface | Live observation | Return to session |
| --- | --- | --- |
| Codex App | Yes | Exact task link |
| Codex CLI | Yes | `codex resume <session>` |
| Claude Code CLI | Yes | `claude --resume <session>` |
| Kimi Code CLI | Yes | `kimi -r <session>` |

Observer reads public user messages, agent messages and tool-call metadata. Claude `thinking`, Kimi `think`, hidden reasoning and tool results are ignored. It filters sessions by repository root and does not rescan product files during observation. Its local cursor file keeps only compact session identity and bounded recent turn state, writes only after a real change and retries short-lived Windows file locks, so a large session history does not turn every poll into a full rewrite.

Every Architect run appends a compact audit trail to ignored `.repo-canvas/architect-runs.jsonl`: model, role, thread id, resumed/fresh state, duration, input/cached/output token usage, validation errors, complete reviewer verdicts and the final outcome. Rejected candidates remain unapplied, but their acceptance history and subscription usage are no longer lost with temporary session cleanup.

## Requirements and installation footprint

- Node.js 22 or newer;
- Git;
- a locally authenticated Codex installation for Architect and Observer model calls;
- Windows or macOS.

The npm installation adds Repo Canvas as an exact development dependency. `setup` adds three package scripts, the ignored `.repo-canvas/` runtime directory and two `.gitignore` entries. It does not add coding-agent instructions or hooks.

The server binds to loopback only and opens a plain local Canvas URL. Loading that page establishes a host-only `HttpOnly`, `SameSite=Strict` browser session, so opening or refreshing the printed address is enough even after changing ports or clearing browser storage. The underlying random authorization token stays inside the project's ignored `.repo-canvas/` directory. Host, origin and browser fetch guards protect Canvas API reads and actions from unrelated web pages. Use `repo-canvas start --no-open` only when automatic browser opening is unwanted. Semantic events and Observer cursors stay in the same ignored runtime directory.

Internal Architect and Observer calls use the official local Codex runtime with the user's existing subscription authentication. Architect gets one temporary clean Codex home for its complete build-review-refine cycle; `codex exec resume` preserves its Sol thread between headless turns. Reviewer and Observer calls remain independently isolated. These homes contain only a filesystem link to authentication: project/global AGENTS files, skills, memories, plugins, hooks and MCP servers are excluded, the process has read-only repository access, and the temporary home is removed afterward. No API key or credential copy is added to the project. Windows launches use a hidden process; macOS and Linux use their native packaged Codex binary. Claude and Kimi adapters only parse their local journals; they do not copy credentials or call those providers.

From v0.8.6 onward, Canvas checks the public GitHub release feed in the background. If a newer release exists, an `Update` control appears at the bottom of the page. During installation the page follows the restart every 750 ms and reloads itself as soon as the new runtime is healthy. The updater requires the official `.tgz` asset and its GitHub SHA-256 digest, installs it side-by-side inside ignored `.repo-canvas/runtime/`, restarts the local server with the same browser authorization and keeps the previous runtime as a rollback. It does not rewrite the project's dependency or lockfile.

## Offline installation

Download `repo-canvas-0.11.0-kit.zip` from the [latest release](https://github.com/m0ast-git/repo-canvas/releases/latest). Copy `repo-canvas-0.11.0.tgz` and `INSTALL_WITH_AGENT.txt` into the target repository, then give the text file to a coding agent.

Manual commands:

```text
npm install --save-dev --save-exact --ignore-scripts ./repo-canvas-0.11.0.tgz
npx --no-install repo-canvas setup
npm run repo-canvas:start
```

## Useful commands

```text
npm run repo-canvas -- doctor
npm run repo-canvas -- architect --refresh
npm run repo-canvas -- observer status
npm run repo-canvas -- observer disable
npm run repo-canvas -- observer enable
npm run repo-canvas -- snapshot
npm run repo-canvas -- check
```

Model profiles can be overridden without code changes:

```text
REPO_CANVAS_ARCHITECT_MODEL
REPO_CANVAS_ARCHITECT_EFFORT
REPO_CANVAS_REVIEWER_MODEL
REPO_CANVAS_REVIEWER_EFFORT
REPO_CANVAS_OBSERVER_MODEL
REPO_CANVAS_OBSERVER_EFFORT
```

## License

[MIT](LICENSE)

Repo Canvas bundles `libavoid-js` for connector routing under LGPL-2.1-or-later. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for exact versions, source links, and license details.

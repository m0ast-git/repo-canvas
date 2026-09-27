# Repo Canvas

A local project map that keeps architecture, product intent, current work and history in view.

Code and project conversations provide the sources. The map explains responsibilities, inputs, outputs, decisions and directed scenarios in language the owner understands. Public coding-agent sessions and source changes update the live view after verification. Optional MCP tools give coding agents the same map, owner decisions and scenarios; hooks report their targets without a model call.

## Build this checkout

```sh
npm ci
npm run build
node repo-canvas/scripts/canvas.mjs init
node repo-canvas/scripts/canvas.mjs skeleton
npm start
```

Requirements: Node.js 22+ and Git. The first structural map and the saved map work without a model. Semantic explanation and verification use an authenticated local Codex, Claude Code or Kimi Code CLI. Choose the provider in Settings; each has an independent adapter.

The server opens its loopback URL. Keep the terminal running. For a different port, use `node repo-canvas/scripts/canvas.mjs start --port 4280`.

## Use it

- Open Map, Scenarios, Decisions, Health or Settings directly. The overview shows readable area summaries and aggregated links. On a narrow screen, step through the areas. Find a responsibility with Ctrl/Cmd+F.
- Play a scenario with Next/Back or arrow keys. Each step shows its two modules, action and condition; the complete sequence is one click away.
- Drag a card, group header or area header; nested contents move together. Resize an area from its corner. Double-click to rename. Undo protects intervening edits from another window.
- Explain a correction in ordinary words. Wording changes are checked for equivalent meaning; factual changes are checked against sources. Decisions, names and manual grouping survive regeneration.
- History opens as chapters grouped by work, owner edits and dates. Open a chapter or switch to all original checkpoints. Compare from a commit, session or checkpoint; return to Live at any time. There is no autoplay.
- Read a historical source fragment or leave a comment without changing the past. Missing history is visible. Optional Git reconstruction runs separately, within the selected budget, without checking out the user's working tree.
- Copy a compact explanation into a new agent conversation.

The interface uses white/graphite surfaces and contrasting status and selection colors, with a dark option. Large maps progressively reveal details. Layout and connector routing run in workers; saved history reuses stored geometry.

Zoom from area summaries into the original module geography. The [design system](docs/design-system.md) uses white/graphite surfaces and distinct moss, teal, ochre, blue, plum and clay area colors. Reciprocal connections preserve both source colors. Libavoid routes the selected semantic focus around complete geometry in a worker; moving the camera does not reroute it. Large unfocused graphs show area aggregates, with at most 60 detailed routes after a selection. Open `/design-system.html` for the component catalog. [Visual evidence](design-qa.md) records the latest checks and their limits.

## Models and sources

Architect, historian, evidence verifier, readability reviewer, editor and live observer are separate roles. Automatic selection uses the permitted local model catalog and task complexity. Individual roles can be overridden in the settings panel; names of particular models are not built into the routing rules.

The builder reads prepared code excerpts and public project messages. User-authored words guide the explanation profile; agent jargon, quoted code and hidden reasoning do not establish the user's knowledge. A user decision proves intent. An agent saying “done” does not prove implementation or execution of tests.

Source verification is required before a candidate replaces the map. A fact-verified candidate can be saved with an explicit incomplete-readability status and resumed. Cached module cards and static imports reduce repeated source reading. A shared usage journal counts every role, errors and missing metadata. Background calls have hourly limits and a daily token allowance; final retries are bounded across restarts. Settings show build estimates and editable limits. Actual consumption can differ from the estimate; model prices are not inferred.

Source policy and model choices are saved locally. Dialog reading can be disabled. Selected excerpts are sent to the selected provider; secret files and unrelated projects are excluded. Model workers receive prepared context with their workspace tools disabled. Existing CLI authentication is reused through isolated settings; no credential is stored in the project. Codex homes are created outside TEMP in the user application-data directory and removed after each session.

Codex has been exercised through real model calls. Kimi reached its provider but returned upstream HTTP 500 during acceptance. Claude's adapter has automated coverage; its CLI was not installed on the acceptance machine. These limitations are not presented as verified end-to-end support.

## Data and delivery

The server binds to loopback and checks Host, Origin and a local token. Loading its page establishes an HttpOnly/SameSite browser session. All persistent project data lives in ignored `.repo-canvas/`.

The event journal remains format v1. Checkpoints add metadata without rewriting old events. Current state and history indexes are disposable caches; stored geometry, comments, corrections and archived evidence are persistent data. Back up or transfer the **whole `.repo-canvas` directory**. Old history is not silently compacted into summaries.

Build a local installable package:

```sh
npm run build
npm pack
```

In another repository, install the delivered archive outside the project:

```sh
npm install --global --ignore-scripts /path/to/repo-canvas-0.14.0.tgz
cd /path/to/project
repo-canvas init
repo-canvas skeleton
repo-canvas start
```

Default `init` creates `.repo-canvas/` and a local Git exclusion; it does not edit `package.json`, instructions or hooks. Explicit `init --project-install` retains project-local npm scripts. Install and authenticate a model CLI separately, then choose **Update map**. The first structure is clearly marked as file/import facts, not a verified product explanation.

Browser updates arrive through SSE; HTTP polling resumes when the stream is unavailable. Hashed assets use immutable caching. The updater requires both SHA-256 integrity and GitHub build provenance, verified by the installed `gh` CLI against this repository, its release workflow and the exact version tag. Missing verification fails closed and restores the previous runtime. A locally built package is distinct from a published signed release.

[Connect MCP and hooks](docs/agent-connections.md) · [Five-question evaluation](docs/evaluation.md)

Checks: `npm run test:review` (one process with fake model runners), `npm test`, `npm run build`, `npm run test:package`, `npm run test:update`. Package tests require a tarball in `dist/`. CI builds the UI before packing on Windows, macOS and Linux. Interactive acceptance measurements were taken in Windows/Chromium, not on a physical low-end notebook or Mac.

[Documentation map](docs/README.md) · [System overview](docs/system-map.md) · [Russian product guide](docs/product-guide.md) · [Implementation and verification](docs/implementation-status.md) · [Install with an agent](INSTALL_WITH_AGENT.txt)

## License

[MIT](LICENSE). Connector routing bundles `libavoid-js` under LGPL-2.1-or-later; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

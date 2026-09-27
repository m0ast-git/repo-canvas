# Third-party notices

Repo Canvas remains licensed under the MIT License. It includes the following third-party components and assets:

## Model Context Protocol

- `@modelcontextprotocol/sdk` 1.30.1 — MIT; https://github.com/modelcontextprotocol/typescript-sdk. Stdio protocol implementation.
- `zod` 4.6.5 — MIT; https://github.com/colinhacks/zod. SDK schema dependency.
- Their licenses are distributed with the installed dependencies.

## Tree-sitter source parsing

- Package: `@vscode/tree-sitter-wasm` 0.3.1, maintained by the Visual Studio Code team.
- License: MIT; upstream notices are distributed with the npm dependency.
- Source: https://github.com/microsoft/vscode-tree-sitter-wasm
- The matching WebAssembly runtime and language grammars run locally on the server, outside the browser bundle. No compiler or grammar download is required at runtime.

## Ajv and TanStack Query

- `ajv` 8.20.0 — MIT; https://github.com/ajv-validator/ajv. Used on the server; license included with the dependency.
- `@tanstack/react-query` 5.102.8 and `@tanstack/query-core` — MIT; https://github.com/TanStack/query. Browser license: [public/licenses/TanStack-Query-MIT.txt](public/licenses/TanStack-Query-MIT.txt).

## elkjs-libavoid

- Package: `@mr_mint/elkjs-libavoid` 0.5.0
- License: MIT
- Source: https://github.com/MrMint/elkjs-libavoid

## libavoid-js / Adaptagrams libavoid

- Package: `libavoid-js` 0.5.0-beta.5
- License: LGPL-2.1-or-later
- Package source: https://github.com/Aksem/libavoid-js
- Upstream algorithm: https://github.com/mjwybrow/adaptagrams/tree/master/libavoid

Repo Canvas distributes the upstream `libavoid.wasm` binary and a bundled JavaScript loader. The complete LGPL license text is included by the installed `libavoid-js` dependency at `node_modules/libavoid-js/LICENSE`; the corresponding source is available from the links above.

## IBM Plex Sans

- Local font assets in weights 400, 500 and 600, served by Google Fonts.
- License: SIL Open Font License 1.1; full text: [public/licenses/IBM-Plex-Sans-OFL.txt](public/licenses/IBM-Plex-Sans-OFL.txt).
- Source: https://github.com/IBM/plex
- Copyright 2017 IBM Corp., with Reserved Font Name "Plex". The delivered font metadata also records Copyright 2019 IBM Corp.

## Phosphor Icons

- Package: `@phosphor-icons/react` 2.1.10.
- License: MIT; full text: [public/licenses/Phosphor-MIT.txt](public/licenses/Phosphor-MIT.txt).
- Source: https://github.com/phosphor-icons/react

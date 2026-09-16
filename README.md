# Huaqiu PCB EDA for DeepSeek Harness (DSH)

Brings Huaqiu electronic-design capabilities into
[DeepSeek Harness (DSH)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) as
standalone, published DSH plugins: Huaqiu part search, symbol/footprint generation, and
schematic / system-design generation — with an eda.cn account login flow and a local
preview-artifact store.

The codebase is migrated out of the HQ Edge monorepo into self-contained DSH plugins,
each able to stand on its own and be published to npm.

## Packages

| Package | Shape | What it does | Status |
|---|---|---|---|
| `@huaqiu/dsh-auth` | dual-face | eda.cn login HIT (embedded `auth.eda.cn` iframe) + sidebar login; node `huaqiuAuth` credential cache | Phase 0A — working |
| `@huaqiu/dsh-artifacts` | node + routes | filesystem artifact store + HTTP preview routes; `huaqiuArtifacts` service | Phase 0B — working |
| `@huaqiu/dsh-ui-theme-huaqiu` | browser Bundle | HuaQiu red palette, HQ marks, sidebar name, and blank-session slogan | working |
| `@huaqiu/dsh-tool-part-search` | node only | 4 part-search tools wrapping the published `@huaqiu/part-search` library | Phase 1 — **published v0.1.0** |
| `@huaqiu/dsh-tool-symbol-footprint` | dual-face | symbol / footprint generation over `wss://www.eda.cn/componentV2/chat` + dimension-confirmation HIT card | working |
| `@huaqiu/dsh-tool-schematic-gen` | dual-face | schematic + system-design generation via gen.eda.cn CopilotKit SSE + zip export + ECAD preview card | working |

## Architecture

### DSH plugin model

Every package is a DSH plugin composed into a profile's layer stack by its
`cordis.patch.yml` (`dsh.bundle.patch` in `package.json`):

```yaml
# e.g. packages/dsh-tool-schematic-gen/cordis.patch.yml
- insert:
    - id: huaqiu-tool-schematic-gen
      name: '@huaqiu/dsh-tool-schematic-gen'
      inject: ['tools']   # node services this half depends on
```

Two plugin shapes:

- **Node-only** (`inject: ['tools']`, no `dsh.client`) — part search. Returns JSON,
  never renders UI, so there is no browser bundle.
- **Dual-face** (`inject: ['tools', ...]` + `dsh.client.inject: ['@deepseek-ai/dsh-client-runtime']`) —
  auth, symbol/footprint, schematic-gen. A cordis node half registers tools/services/routes,
  and a browser half registers React `tool.call.toolview` cards for human-in-the-loop steps.

### Node half (cordis plugin)

- Registers agent-visible tools via `ctx.tools.register` (`defineTool`), e.g.
  `generate_schematic_from_description`, `generate_system_module_graph`.
- Provides cross-plugin services via `ctx.provide`:
  - `huaqiuAuth` (`@huaqiu/dsh-auth`) — capability API `isAuthenticated()` /
    `getAccessToken()` / `getUserInfo()`; token is never baked in.
  - `huaqiuArtifacts` (`@huaqiu/dsh-artifacts`) — in-process artifact store; tools call it
    directly (no HTTP loopback).
- Mounts plugin-owned HTTP routes on `ctx.webServer` (the smallest supported extension
  point — DSH's `apiProxy` dispatch table is closed):
  - `/api/v1/huaqiu/auth` — browser→node credential channel.
  - `/api/v1/huaqiu/artifacts/<id>` + `/content` — preview metadata / raw bytes.

### Browser half (React HIT cards)

- Registers `tool.call.toolview` slot entries keyed by tool name, replacing the stock JSON
  fallback. Cards are rendered from the frozen `ToolCallBlock` via a pure projection, and
  human answers (e.g. "regenerate") are sent back to the agent through
  `sessions.binding(sessionId).session.prompt`.
- Reads the auth plugin's localStorage credential cache (`huaqiu.dsh.auth`) for display.
- Renders ECAD previews with the published `@huaqiu/ecad-renderer` (`renderSchematic` for a
  single sheet, `loadProjectZip` → root sheet for a project zip).

### Cross-plugin dependencies

```
@huaqiu/dsh-tool-symbol-footprint ──► huaqiuAuth, huaqiuArtifacts
@huaqiu/dsh-tool-schematic-gen   ──► huaqiuAuth, huaqiuArtifacts
@huaqiu/dsh-tool-part-search     ──► (none — public API only)
```

Tools require the auth/artifacts services at runtime; a `needs_auth` result is returned
when the eda.cn login is missing (never a hard throw — it surfaces a login HIT instead).

## Dataflow

### Authentication (login HIT)

```
browser ──► auth.eda.cn iframe ──postMessage (category-1 envelope)──► parse (validate
envelope) ──► localStorage cache ──► POST /api/v1/huaqiu/auth/session
      ──► node InMemoryHuaqiuAuthService ──► tools read getAccessToken()/getUserInfo()
```

The origin gate is intentionally dropped (the harness runs fully offline on `127.0.0.1`),
but the envelope is still validated (`category: 1` + well-formed `token`/`userId`) so
unrelated window messages can never corrupt the cache. Envelope types:
`update_access_token`, `logout`, `close_dialog`.

### Part search (node only, no auth)

```
agent → tool → @huaqiu/part-search library → kiapi.eda.cn → JSON → agent
```

### Symbol & footprint (datasheet image → KiCad files)

```
agent → tool → resolve account (huaqiuAuth) → WebSocket wss://www.eda.cn/componentV2/chat
  → generated .kicad_sym / .kicad_mod → store in huaqiuArtifacts (in-process)
  → result JSON { artifact ids } → browser card fetches /content → renders via ecad-renderer
```

Footprint generation is **human-in-the-loop**: dimensions extracted from the image are
returned as a `needs_confirmation` result; the browser card shows a dimension editor, the
user confirms/corrects, and only then does the agent call
`generate_footprint_from_dimensions`.

### Schematic & system design (CopilotKit SSE + zip export)

```
agent → tool → resolve account → POST gen.eda.cn/api/copilotkit (SSE stream,
STATE_DELTA → STATE_SNAPSHOT) ──►
  schematic: extract inline .kicad_sch sheets → store each as 'schematic' artifact
  system:    extract module_graph → POST gen.eda.cn/api/modular_circuit/export-zip
             → store the KiCad project zip as 'zip' artifact (single source of truth)
→ result JSON { artifact ids } → browser card fetches /content (text for a sheet,
  ArrayBuffer for a zip) → renders the sheet (or the root sheet matching the
  .kicad_pro name) via ecad-renderer → download / regenerate / inspect
```

The backend design agents are slow (single runs routinely take 9–12+ minutes), so the
SSE/tool budget is **30 minutes** (`HTTP_TIMEOUT_MS = 1_800_000` in
`packages/dsh-tool-schematic-gen/src/sse.ts`).

### Artifacts

Filesystem-backed store under `~/.dsh/artifacts/dsh-artifacts` with `meta.json`,
atomic writes, TTL expiry, a `maxBytes` cap, and strict id validation (`^art_[0-9a-f]+$`).
The `/content` route returns **already-decoded bytes** (base64 is decoded at store time) —
clients must read it as an `ArrayBuffer`, never as text.

## Development

### Prerequisites

- Node ≥ 22, pnpm 11 (`pnpm-workspace.yaml` globs `packages/*`).
- The `dsh` CLI is on public npm as `@deepseek-ai/dsh` — run with `npx` to avoid a
  global install.

### Commands

```bash
pnpm install
pnpm -r typecheck      # tsc --noEmit per package
pnpm -r test           # vitest per package
pnpm -r build          # tsdown → lib/
pnpm -r pack --dry-run # confirm npm-packable output
pnpm run check:publish # pre-publish integrity gate (entry/client/patch/exports)
```

### Local run

`pnpm launch-dsh` rebuilds nothing — it kills port 3080, links every local package into the
`web` profile (`dsh plugin add <path>`), and starts the web profile:

```bash
pnpm launch-dsh   # → http://127.0.0.1:3080
```

Per-package layout:

```
packages/<pkg>/
  src/index.ts        # cordis plugin entry: name, inject, apply()
  src/tools.ts        # agent tool bodies (defineTool)
  src/client/         # browser half: HIT cards (React), ecad helpers, theme
  cordis.patch.yml    # profile insert
  tsdown.config.ts    # build → lib/ (client bundle for dual-face packages)
  test/               # vitest
```

Smoke-test scratch space lives in `.smoke/` (a throwaway `DSH_HOME` so nothing touches the
real DSH home).

## Releasing to npm

The five `@huaqiu/dsh-*` packages are released **as one unit** (auth/artifacts are
peer-dependencies of the tool packages, so their versions move together). Publishing
follows the community DSH-plugin patterns (see `/Users/admin/code/dsh-plugin`): a Git tag
`vX.Y.Z` triggers the release pipeline, and the tag must equal every `package.json`
version.

### 1. Bump

```bash
node scripts/bump.mjs 0.1.1    # write versions, rewrite @huaqiu/* peer deps, refresh lockfile
```

The bump is always applied — there is no dry-run mode.

`bump.mjs` keeps the root marker + all five packages on one version and rewrites the
hardcoded in-workspace peer references (`^0.0.0` → `^<new>`). It can force-resync an
out-of-sync workspace by passing an explicit version.

### 2. Commit + tag

```bash
git add -A
git commit -m "chore: release v0.1.1"
git tag v0.1.1
git push origin main --tags
```

### 3. GitHub pipeline

- `.github/workflows/ci.yml` — on push/PR: install → typecheck → test → build →
  pack dry-run → `check:publish`.
- `.github/workflows/release.yml` — on tag `v*` (or manual dispatch with `version` /
  `publish` / `dry_run` inputs): validates every package version against the tag, runs the
  full gate (incl. `check:publish:release` which requires a clean tree), then publishes
  via `node scripts/publish.mjs --provenance`.

Publishing uses **npm Trusted Publishing (OIDC)** — no `NPM_TOKEN` secret needed (it is
only a fallback). One-time setup on npmjs.com for each `@huaqiu/*` package: Settings →
Publishing access → Add Trusted Publisher → GitHub Actions, org `Huaqiu-Electronics`,
repo `dsh-pcb-eda`, workflow `release.yml`.

### Local / manual checks

```bash
node scripts/check-publish.mjs              # entry/client/patch/exports integrity
node scripts/check-release-version.mjs 0.1.1 --tag v0.1.1
node scripts/publish.mjs --dry-run          # build + gate + pack, nothing published
node scripts/publish.mjs                    # live publish (auth via OIDC or NODE_AUTH_TOKEN)
```

Publishing is idempotent: a version already on npm is skipped, never re-published.
Packages publish in dependency order: `dsh-auth` → `dsh-artifacts` → `dsh-tool-part-search`
→ `dsh-tool-symbol-footprint` → `dsh-tool-schematic-gen`.

## How to use

### Install the plugins

Local development (link each package from this repo):

```bash
npx @deepseek-ai/dsh plugin --profile web add ./packages/dsh-auth
npx @deepseek-ai/dsh plugin --profile web add ./packages/dsh-artifacts
npx @deepseek-ai/dsh plugin --profile web add ./packages/dsh-tool-part-search
npx @deepseek-ai/dsh plugin --profile web add ./packages/dsh-tool-symbol-footprint
npx @deepseek-ai/dsh plugin --profile web add ./packages/dsh-tool-schematic-gen
```

Or add the published packages by name once they are published (e.g.
`@huaqiu/dsh-tool-part-search` is on npm today).

### Run

```bash
npx @deepseek-ai/dsh web --no-open   # then open http://127.0.0.1:3080
```

### Login (required for eda.cn-backed tools)

The generation tools require a Huaqiu EDA (eda.cn) account. Log in via the **华秋EDA AI**
button in the sidebar, or let the agent trigger a login HIT — a card with an embedded
`auth.eda.cn` iframe appears and the agent waits for you to finish before retrying.
Part search does not require login.

### Agent usage

Ask in natural language, e.g.:

- *"Find the eda models for `<part>`"* (part search)
- *"Convert /path/to/datasheet.png into a footprint"* (footprint — confirm the extracted
  BGA/QFP dimensions in the card)
- *"Generate a schematic for a minimal ESP32 dev board using the schematic gen tool"*
- *"Create a mini ESP32 design using the system design tool"* (system design → project zip
  preview)

### Runtime configuration (env)

| Variable | Default | Used by |
|---|---|---|
| `HQ_EDA_COPILOTKIT_URL` | `https://gen.eda.cn/api/copilotkit` | schematic / system design |
| `HQ_EDA_EXPORT_ZIP_URL` | `https://gen.eda.cn/api/modular_circuit/export-zip` | system design zip export |
| `HQ_EDA_COMPONENT_WS_URL` | `wss://www.eda.cn/componentV2/chat` | symbol / footprint (whitelist-checked) |
| `HQ_EDA_COOKIE` | — | optional cookie for schematic backend |

## Phase status

- **Phase 0A** `dsh-auth` — login HIT + node credential cache: working.
- **Phase 0B** `dsh-artifacts` — filesystem store + preview routes: working.
- **Phase 1** `dsh-tool-part-search` — first published plugin (`v0.1.0`): done.
- **Phases 2–3** `dsh-tool-symbol-footprint`, `dsh-tool-schematic-gen` — tools + React HIT
  cards + ECAD preview: implemented and exercised end-to-end; publishing tracked in
  `docs/tasks/` (see `phase0-implementation-spec.md` and `comment-on-migration-plan.md`
  for the exact contracts).

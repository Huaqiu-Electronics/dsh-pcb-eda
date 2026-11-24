# Huaqiu PCB EDA for DeepSeek Harness (DSH)

Brings Huaqiu electronic-design capabilities into
[DeepSeek Harness (DSH)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) as
standalone, published DSH plugins: Huaqiu part search, symbol/footprint generation,
schematic / system-design generation, and the **Hardware Engineering** product —
schematic / PCB / 3D / BOM viewing of a real KiCad project, native-app launch, and
PCB / SMT order placement on eda.cn — with an eda.cn login flow and a local
preview-artifact store.

The codebase is migrated out of the HQ Edge monorepo into self-contained DSH plugins,
each able to stand on its own and be published to npm. The products are composed by a
single bundle package; see [Product composition](#product-composition-one-bundle-many-plugins)
and [Branch topology](#branch-topology-master-integrates-desktop-releases).

## Packages

| Package | Shape | What it does | Status |
|---|---|---|---|
| `@huaqiu/dsh-auth` | dual-face | eda.cn login HIT (embedded `auth.eda.cn` iframe) + sidebar login; node `huaqiuAuth` credential cache | Phase 0A — working |
| `@huaqiu/dsh-artifacts` | node + routes | filesystem artifact store + HTTP preview routes; `huaqiuArtifacts` service | Phase 0B — working |
| `@huaqiu/dsh-ui-theme-huaqiu` | browser Bundle | HuaQiu red palette, HQ marks, sidebar name, and blank-session slogan | working |
| `@huaqiu/dsh-tool-part-search` | node only | 4 part-search tools wrapping the published `@huaqiu/part-search` library | Phase 1 — **published v0.1.0** |
| `@huaqiu/dsh-tool-symbol-footprint` | dual-face | symbol / footprint generation over `wss://www.eda.cn/componentV2/chat` + dimension-confirmation HIT card | working |
| `@huaqiu/dsh-tool-schematic-gen` | dual-face | schematic + system-design generation via gen.eda.cn CopilotKit SSE + zip export + ECAD preview card | working |
| `@huaqiu/dsh-kicad` | node + skills | 10 KiCad PCB tools over the official KiCad IPC API, bundled with the `kicad-ipc` and `hardware-design-brief` skills | working |
| `@huaqiu/hardware-artifacts` | node + routes | host capability: project/board discovery, CAD installation resolution, schematic/PCB/BOM/3D export and the eda.cn order flow | working |
| `@huaqiu/dsh-hardware-ui` | dual-face | engineering navigation (Schematic / PCB / 3D / BOM / Order) + right-panel artifact viewer + order confirmation panel | working |
| `@huaqiu/hardware-engineering` | bundle | **the product bundle** — composes the plugin rows a profile mounts; ships as one versioned unit | working |

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

Three plugin shapes:

- **Node-only** (`inject: ['tools']`, no `dsh.client`) — part search. Returns JSON,
  never renders UI, so there is no browser bundle.
- **Dual-face** (`inject: ['tools', ...]` + `dsh.client.inject: ['@deepseek-ai/dsh-client-runtime']`) —
  auth, symbol/footprint, schematic-gen. A cordis node half registers tools/services/routes,
  and a browser half registers React `tool.call.toolview` cards for human-in-the-loop steps.
- **Node + bundled skills** (`inject: ['skills', 'tools']`) — `dsh-kicad`. Registers tools
  *and* every skill under the package's `skills/` in the same `apply()`, so installing the
  plugin makes the skills available with no second installation step. The `skills/` directory
  ships in `files[]` and is located at runtime relative to the loaded module:

  ```js
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
  const skillDir = join(root, 'kicad-ipc')          // one directory per skill id
  ctx.skills.register({
    name: 'kicad-ipc',
    description,                                     // from SKILL.md frontmatter
    content: readFileSync(join(skillDir, 'SKILL.md'), 'utf8'),
    resourceBase: { kind: 'directory', path: skillDir },
  })
  ```

  `resourceBase` is what lets the agent resolve the skill's `scripts/` and `references/`
  relative paths. See `packages/dsh-kicad/README.md`.

### Product composition: one bundle, many plugins

A profile never lists the individual plugins. It selects **one** bundle:

```jsonc
// $DSH_HOME/profiles/<profile>/package.json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@huaqiu/hardware-engineering"      // mounts all eleven Huaqiu rows
] } }
```

`@huaqiu/hardware-engineering` is not a plugin. It is composition plus a version
ledger:

| Concern | Where |
|---|---|
| Which rows mount, in what order, with what `inject` | `packages/hardware-engineering/cordis.patch.yml` |
| The same list, machine-readable | `packages/hardware-engineering/src/index.ts` (`HARDWARE_ENGINEERING_PLUGINS`) |
| Exact plugin versions tested together | its `dependencies` (`workspace:*` locally, pinned on release) |

Two rules explain most boot failures:

- **A dependency installs a package; the patch row activates it.** Adding a plugin
  to `dependencies` without an `insert:` row is a silent no-op.
- **Row ids must be unique per profile.** Each plugin's own `cordis.patch.yml`
  uses the same id as the bundle row on purpose, so double-mounting (bundle *and*
  profile-local `plugin add`) fails loudly instead of running two copies.

### Branch topology: master integrates, desktop releases

```
dsh-pcb-eda master ──► npm (@huaqiu/hardware-engineering x.y.z) ──► harness `desktop` branch
  plugin code + composition        the release unit                 pinned in apps/cli + packaging
```

- **This repo's `master` is the integration mainline.** Features, UI work and the
  composition live here; the harness `master` branch carries no `@huaqiu/*`
  dependency at all.
- **The harness `desktop` branch is a release branch.** It only holds what a
  shipped build needs: the pinned bundle version in `apps/cli/package.json`, the
  offline bundle scripts, and the activation/distribution verifiers. Product work
  is never done there, and no feature change requires a harness checkout.
- All `@huaqiu/dsh-*` packages move to one version together (`scripts/bump.mjs`),
  because the tool packages peer-depend on auth/artifacts.

The day-to-day loop therefore runs the **official DSH web profile**, not the
desktop build — see [Dev loop](#dev-loop-web-profile).

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
@huaqiu/dsh-hardware-ui          ──► hardware-artifacts HTTP routes (viewer/order data)
@huaqiu/hardware-engineering     ──► every product package (composition + version ledger)
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

### Dev loop (web profile)

The desktop application is the release target: it is built from the harness
`desktop` branch, packages an offline bundle, installs an app, and is gated by
activation/distribution fixtures. Using it as the inner loop costs minutes per
iteration and keeps a second repo in sync.

The official DSH **web profile** runs the same code straight from this checkout —
`$DSH_HOME/profiles/web` links `@huaqiu/hardware-engineering` with `link:`, so the
running server loads `packages/*/lib`. Same node rows, same client bundle, same
routes; none of the packaging, install or signing steps.

| Step | Desktop (release loop) | Web profile (dev loop) |
|---|---|---|
| Code under test | published bundle pinned on `desktop` | `link:` to this checkout |
| Build | harness + bundle packaging | three product packages (or none with `--no-build`) |
| Install | desktop app install/reinstall | profile `pnpm install`, only when deps change |
| Boot | app launch + activation fixture | `dsh web`, one command |
| Feedback | packaged app | reload the browser tab |

```bash
pnpm launch-dsh:standalone             # build the 3 product packages, reset the profile, boot
pnpm launch-dsh:standalone --no-build  # boot the current lib/ (host untouched, docs/tests)
pnpm launch-dsh:standalone --all       # rebuild every workspace package
pnpm launch-dsh:standalone --no-install  # skip the profile install (links already correct)
```

It requires the harness repo as a **sibling** (`<code>/deepseek-harness`, exposing
`pnpm dsh`), then:

1. builds `hardware-artifacts`, `dsh-hardware-ui`, `hardware-engineering` (the three
   packages this loop edits; the rest already ship a built `lib/`);
2. rewrites the profile to exactly `dsh-base` + `dsh-web-app` +
   `@huaqiu/hardware-engineering` and **removes every other `@huaqiu/*`
   dependency** — a previous `pnpm launch-dsh` run links each plugin separately,
   which inserts the bundle's row ids twice and aborts boot;
3. installs the profile so the `link:` resolves here;
4. frees port 3080 (a survivor would serve old code) and starts `dsh web` →
   `http://127.0.0.1:3080`.

What to rebuild after a change:

| Change | Reaction |
|---|---|
| node half (`src/*.ts`, routes, export/order logic) | build that package, restart the server (rows compose at boot) |
| browser half (`src/client/*`) | build the package, reload the tab (assets are served `no-cache`; restart if the old bundle persists) |
| a `cordis.patch.yml` row, a new plugin, a new dependency | full `launch-dsh:standalone` (profile + lockfile change) |
| unit-level work | `pnpm --filter ./packages/<pkg> test`, no server |

`scripts/launch-dsh.mjs` (`pnpm launch-dsh`) is the *legacy* per-plugin launcher:
it `plugin add`s every workspace package into the profile. It still works for a
single-package experiment, but it pollutes the profile and fights the bundle — the
bundled launcher is the supported loop.

Per-package layout:

```
packages/<pkg>/
  src/index.ts        # cordis plugin entry: name, inject, apply()
  src/tools.ts        # agent tool bodies (defineTool)
  src/client/         # browser half: HIT cards (React), ecad helpers, theme
  skills/             # optional bundled skills (dsh-kicad) — must be in files[]
  cordis.patch.yml    # profile insert
  tsdown.config.ts    # build → lib/ (client bundle for dual-face packages)
  test/               # vitest
```

Smoke-test scratch space lives in `.smoke/` (a throwaway `DSH_HOME` so nothing touches the
real DSH home).

### Repo skills

`.workbuddy/skills/` holds the design notes for this workflow as agent skills, so a
future session (human or agent) does not have to re-derive them:

| Skill | Answers |
|---|---|
| `dsh-product-bundle-integration` | How a plugin joins the master branch: package shape, the three places a row is registered, why dependencies do not activate, the duplicate-row-id / `pending` failure modes, and why the `desktop` branch is release-only |
| `dsh-web-profile-dev-loop` | How the web profile replaces the desktop build in the inner loop: launcher flags, what to rebuild after each kind of change, stub-driven e2e, and the pitfalls (stale `lib/`, port 3080, profile pollution) |

They are repo-scoped. To use them in a session, link them into the user skill store:

```bash
ln -s "$PWD/.workbuddy/skills/dsh-product-bundle-integration" ~/.workbuddy/skills/dsh-product-bundle-integration
ln -s "$PWD/.workbuddy/skills/dsh-web-profile-dev-loop"        ~/.workbuddy/skills/dsh-web-profile-dev-loop
```

## Releasing to npm

Every package under `packages/` is released **as one unit** — versions move in
lockstep because the tool packages peer-depend on auth/artifacts. New packages are
discovered automatically; whether a package is user-visible in the release catalog
is a separate, explicit allowlist (`CATALOG_PLUGIN_NAMES` in
`scripts/utils/packages.mjs`). Publishing follows the community DSH-plugin patterns
(see `/Users/admin/code/dsh-plugin`): a Git tag `vX.Y.Z` triggers the release
pipeline, and the tag must equal every `package.json` version.

### 1. Bump

```bash
node scripts/bump.mjs patch          # or minor|major, or an explicit 0.7.14
```

The bump is always applied — there is no dry-run mode.

`bump.mjs` keeps the root marker and every package on one version and rewrites the
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
Packages publish in **topological** order (leaves first, so providers land before
consumers), computed from the workspace graph — `dsh-auth` / `dsh-artifacts` before
the tool packages, `hardware-artifacts` / `dsh-hardware-ui` before
`hardware-engineering`.

## How to use

### Install

Install **the bundle**, not the individual plugins — one dependency mounts every
Huaqiu row, and adding plugins separately duplicates row ids:

```bash
npx @deepseek-ai/dsh plugin --profile web add @huaqiu/hardware-engineering
npx @deepseek-ai/dsh web --no-open     # then open http://127.0.0.1:3080
```

From this checkout, use the launcher instead — it links the bundle with `link:` and
normalises the profile for you:

```bash
pnpm launch-dsh:standalone    # build + link + boot → http://127.0.0.1:3080
```

`dsh plugin add ./packages/<pkg>` still exists for isolating a single package, but a
profile containing both the bundle and a child plugin will fail boot on duplicate
row ids. See [Dev loop](#dev-loop-web-profile).

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

### Hardware Engineering (project viewer + ordering)

Designate a KiCad installation in **Settings** (a KiCad root or a `kicad-cli` path),
then point the workspace at a KiCad project. The conversation header carries five
destinations — **Schematic / PCB / 3D / BOM / Order** — which drive the right panel;
the panel stays mounted when collapsed or expanded so switching destinations does not
re-read the project.

Ordering is two steps by design: preview (select board, quantity, review the package
summary) then **Submit PCB order** / assembly order behind an explicit confirmation.
The host exports gerbers/drill/positions, uploads multipart to the eda.cn order
endpoint, and hands the **final order page** to the OS browser (`Open in browser`
re-opens it later). Payment and address happen on that page — this plugin never
collects them.

### Runtime configuration (env)

| Variable | Default | Used by |
|---|---|---|
| `HQ_EDA_COPILOTKIT_URL` | `https://gen.eda.cn/api/copilotkit` | schematic / system design |
| `HQ_EDA_EXPORT_ZIP_URL` | `https://gen.eda.cn/api/modular_circuit/export-zip` | system design zip export |
| `HQ_EDA_COMPONENT_WS_URL` | `wss://www.eda.cn/componentV2/chat` | symbol / footprint (whitelist-checked) |
| `HQ_EDA_COOKIE` | — | optional cookie for schematic backend |
| `HUAQIU_ORDER_BASE_URL` | `https://www.eda.cn` | PCB / SMT order upload endpoint (point it at a stub for e2e) |
| `HUAQIU_ACCESS_TOKEN` | — | optional order upload credential; used only when the logged-in session has none |

## Phase status

- **Phase 0A** `dsh-auth` — login HIT + node credential cache: working.
- **Phase 0B** `dsh-artifacts` — filesystem store + preview routes: working.
- **Phase 1** `dsh-tool-part-search` — first published plugin (`v0.1.0`): done.
- **Phases 2–3** `dsh-tool-symbol-footprint`, `dsh-tool-schematic-gen` — tools + React HIT
  cards + ECAD preview: implemented and exercised end-to-end; publishing tracked in
  `docs/tasks/` (see `phase0-implementation-spec.md` and `comment-on-migration-plan.md`
  for the exact contracts).
- **Hardware Engineering** `hardware-artifacts` + `dsh-hardware-ui` +
  `hardware-engineering` — project discovery, five-destination viewer, BOM / 3D export,
  native launch, PCB / SMT ordering: implemented; gate-by-gate evidence in
  `docs/m1/hardware-engineering-artifact-viewer-poc-impl-report.md`. Desktop
  distribution verification (Windows x64, 24/24 activation) stays on the release
  branch.

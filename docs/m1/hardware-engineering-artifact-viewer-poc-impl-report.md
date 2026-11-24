# Hardware Engineering artifact viewer — implementation report

Implements `docs/tasks/hardware-engineering-artifact-viewer-poc-impl-spec.md`.

Verification environment: macOS arm64, Node 22.22, KiCad **10.0.7**
(`/Applications/KiCad/KiCad.app`), official DSH **web** profile at
`~/.dsh/profiles/web` with `@huaqiu/hardware-engineering` linked from this
checkout (`pnpm launch-dsh:standalone`). No HQ Edge, no Huaqiu desktop shell.

---

## 1. Summary of implemented behavior

One product UI plugin (`@huaqiu/dsh-hardware-ui`) plus one host capability
(`@huaqiu/hardware-artifacts`), both mounted by the existing
`@huaqiu/hardware-engineering` bundle. The DSH shell is extended in one place
only — the right panel's chrome — for the reasons in §1.1.

- Five persistent destinations (Schematic, PCB, BOM, 3D CAD, Order Placing) are
  the right panel's own header. There is no second copy above the chat: the
  panel header IS the product's navigation.
- Expanding the right panel opens Hardware Engineering directly. The tab type
  registers as the panel's default page (`default: true`), so the official
  "Start" page is never seeded into this product's panel.
- Each destination switches the `hardware-engineering` tab's navigation params
  (`sidebar.right.pane.tab`, `keepMounted`). Navigating again changes the tab's
  navigation params **and** its monotonic revision, so the body refreshes
  without remounting the tab.
- Schematic and PCB render from the saved file through the existing
  `@huaqiu/kicad-sexpr-parser` + `@huaqiu/ecad-renderer` packages.
- 3D CAD exports GLB with `kicad-cli pcb export glb`, caches it by source
  content hash, and renders it locally with Three.js.
- BOM is produced by `kicad-cli sch export bom` and grouped in the host.
- "Open in KiCad" launches the configured installation with an explicit argv
  for the exact selected artifact. No shell.
- Settings (`settings.section`) edit the two installation roots through the
  existing DSH `configForms` service; values persist in the profile's
  `cordis.patch.yml`.
- A skippable first-run wizard guides the user to a local KiCad/SolidCraft
  installation. It is a full-screen modal, so it renders only once both facts it
  depends on are known — the host config sync (`status !== 'loading'`) and one
  local install probe — instead of mounting on `loading`/`undefined` and hiding a
  frame later, which is what flashed on first launch and on every refresh.
- Order Placing packages the board with `kicad-cli`, posts the same forms KiCad
  posts, and opens the resulting order page — the exact URL KiCad loads in its
  own order webview — in the system default browser.
- Agent context (`/environment`) reports the configured toolchain and the
  resolved project; child env is returned per call (no `process.env` mutation).
- All visible text is zh_CN, sourced from one dictionary
  (`src/client/copy.ts`); host error codes are translated at the transport
  boundary, so no English host sentence reaches the panel (§9).
- Every empty viewer is one centred placeholder that names what is missing and
  then says how to get it: ask the agent to create the schematic, PCB or 3D
  model, and BOM follows the schematic automatically (§10).

### 1.1 Panel shell contract (the one `deepseek-harness` change)

The right panel is a generic tab surface: a tab strip with chips, an add control,
a split control and a chrome slot, plus a seeded "Start" page. This product is a
single-page workspace, so that surface is reduced to what it actually uses:

| Shell behaviour | Before | Now | Where |
| --- | --- | --- | --- |
| Default page | the guide ("Start") | the type declaring `default: true` | `contract/seed.ts`, `tab-registry.ts` |
| Tab strip | chips + add + split + chrome | not drawn in the docked panel | `shell/SidebarRight.module.css` |
| Panel controls | full screen + split + collapse, at the strip's end | full screen + collapse only, over the page header's end | `shell/SidebarRight.tsx` |
| Restored layouts | any saved layout, including a Start tab | new persistence namespace (`v2`), so a Start tab cannot come back | `persistence.ts` |

The page header is drawn 38px tall and the two controls are centred in a 38px
overlay at the same top edge, so the two rows read as one. The overlay rides the
docked items' slide, so a **collapsed** column hides both controls and leaves only
the conversation header's one expand button in that corner — the messy doubled
corner came from the chrome staying mounted behind that button. Both controls
come from one shared button definition (`PanelToggleButton.tsx`), so the collapse
button is the same glyph and size as the expand button. The overlay stacks one
layer above the dock host (which rises from 10 to 40 in fullscreen) so both
buttons stay clickable in either presentation; a focus-scoped command target is
what made the fullscreen button a no-op before, and the switch now resolves
against the on-screen Session explicitly. Floating panels keep their own strip
and header: the CSS is scoped to `[data-dockkit-host='dock']`.

`defaultSeed` still falls back to the guide when no type declares itself the
default, so the shell keeps working for a profile without this bundle.

---

## 2. Files changed

`dsh-pcb-eda` (the product) plus the `ui-sidebar-right` package in
`deepseek-harness` for the panel shell (§1.1). Nothing else in the shell is
touched.

| Package | File | Change |
| --- | --- | --- |
| root | `package.json` | adds `launch-dsh:standalone` |
| root | `scripts/launch-dsh-standalone.mjs` | new: build the three packages, seed/repair the official web profile with only this bundle, launch `dsh web` |
| `hardware-artifacts` | `src/index.ts` | volatile config (`kicadRoot`, `solidcraftRoot`, `onboardingComplete`, order base/token); live settings accessor |
| `hardware-artifacts` | `src/order.ts` | board facts, KiCad-compatible PCB/SMT forms, positions/BOM CSVs, zip, multipart, the two final page URLs |
| `hardware-artifacts` | `src/service.ts` | live-read roots; BOM column aliases; fabrication packaging cache; `placeOrder` and `openOrderUrl` |
| `hardware-artifacts` | `src/routes.ts` | `/fabrication`, `/order`, `/order/pcb`, `/order/smt`, `/order/open` |
| `hardware-artifacts` | `test/service.test.ts` | real `kicad-cli` BOM header test; canonical test root |
| `hardware-artifacts` | `test/order.test.ts` | new: forms, CSVs, submit bodies, final URLs, URL guard, browser hand-off |
| `dsh-hardware-ui` | `src/client/copy.ts` | new: the only zh_CN dictionary — viewer, discovery, placeholders, preview, order, wizard, settings, host error codes |
| `dsh-hardware-ui` | `src/client/index.ts` | two seats (`sidebar.right.pane.tab` with `default: true`, `settings.section`); controller inject face |
| `dsh-hardware-ui` | `src/client/model.ts` | `HardwareController`, navigation params, discovery/installation shapes; labels read from `copy.ts` |
| `dsh-hardware-ui` | `src/client/store.ts` | `applyNavigation`, non-clobbering discovery refresh |
| `dsh-hardware-ui` | `src/client/components.tsx` | viewer body with the product header as the panel's top edge, centred empty states with guidance, settings section |
| `dsh-hardware-ui` | `src/client/preview.tsx` | per-destination stages; KiCad-gated BOM/3D/order; one centred placeholder with title + reason + guidance |
| `dsh-hardware-ui` | `src/client/order.tsx` | new: fabrication summary, confirmation dialog, result card, reopen in browser |
| `dsh-hardware-ui` | `src/client/transport.ts` | fabrication/order calls, `openOrderUrl`; host `code` → zh sentence, `messageOf` |
| `dsh-hardware-ui` | `src/client/theme.ts` | new: prototype-aligned tokens and primitives |
| `dsh-hardware-ui` | `src/client/ecad.ts` | sized canvas + post-layout re-fit + disposal |
| `dsh-hardware-ui` | `src/client/wizard.tsx` | new: three-step skippable wizard |
| `dsh-hardware-ui` | `src/client/wizard.tsx` | first-run gate (`wizardPhase`) so the modal never mounts on pre-hydration facts |
| `dsh-hardware-ui` | `test/client.test.ts` | seat/scope assertions, tab-type `default`, placeholder contract |
| `dsh-hardware-ui` | `test/copy.test.ts` | new: zh_CN coverage, host-code contract, error/discovery translation, placeholder guidance |
| `deepseek-harness` | `packages/client/ui-sidebar-right/src/client/contract/seed.ts` | `defaultSeed` prefers a type declaring `default: true`; guide stays the fallback |
| `deepseek-harness` | `packages/client/ui-sidebar-right/src/client/tab-registry.ts` | `SidebarRightTabDefinition.default` |
| `deepseek-harness` | `packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx` | the two panel controls move out of the strip into an overlay over the page header |
| `deepseek-harness` | `packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css` | docked strip not drawn; `.panelChrome` overlay rides the docked slide/hide rules and stacks one layer above the dock host |
| `deepseek-harness` | `packages/client/ui-sidebar-right/src/client/shell/PanelToggleButton.tsx` / `.module.css` | one shared compact button for the expand/collapse ends and the fullscreen switch, so no corner can drift or double |
| `deepseek-harness` | `packages/client/ui-sidebar-right/src/client/shell/ExpandButton.tsx` | the collapsed corner's expand button now uses the shared definition |
| `deepseek-harness` | `packages/client/ui-sidebar-right/src/client/index.ts` | the fullscreen switch resolves against the on-screen Session (`commandTarget(null)`), not the focused element |
| `deepseek-harness` | `packages/client/ui-sidebar-right/src/client/persistence.ts` | namespace `v2`, so a saved Start layout cannot be restored |
| `deepseek-harness` | `packages/client/ui-sidebar-right/README.md` / `.zh.md` / `.i18n.yaml` | panel-shell contract documented and the bilingual pair re-recorded |

New fixes in this pass, worth calling out:

- **Two store handles, not one.** DSH pins a store handle to the first scope it
  mounts under. `settings.section` is `root`; `sidebar.right.pane.tab` is
  `session`. One shared handle produced `store handle mounted under
  "sidebar.right.pane.tab" (scope "session") is already mounted under scope
  "root"`. The seats now own separate instances; the viewer's own navigation
  params carry everything a destination switch needs.
- **Volatile config is a reference, not a value.** `.volatile()` makes the
  config field a `{ get(): T }` reference; passing it to `path.resolve`
  produced `ERR_INVALID_ARG_TYPE` → HTTP 500 on `/installations`. Resolved via
  `readConfig()` at call time.
- **The page KiCad opens is not the URL the backend returns.** For PCB it is a
  composed `/mycenter/orders/pcb/quote` URL (`type=PCB`, id, guid, `tid=354`,
  token); for assembly it is the `…/orders/smt/quote` page composed from the
  returned id with `source=bom` and the token. Both must carry the *signed-in*
  Huaqiu token — hqpcb is a Huaqiu business, so there is no second credential.
  The host builds both, and `responseUrl` keeps the raw string.
- **Assembly geometry copies the board form.** `pcb_ban_width` must equal
  `pcb_form.blength` (the outline's longer axis as the form defines it), not the
  X extent; the pad count now comes from the board instead of KiCad's 1133
  sample default.
- **BOM grouping only matched `Reference`/`Quantity`.** `kicad-cli` 10.x emits
  `Refs,Value,Footprint,Qty,DNP`, so every real row was skipped and the table
  was empty. Aliases + comma-separated reference cells fixed it; a regression
  test now uses the real header.

---

## 3. Host routes and authorization contracts

All under `/api/v1/hardware` (`packages/hardware-artifacts/src/routes.ts`).

| Route | Method | Body / query | Purpose |
| --- | --- | --- | --- |
| `/projects` | GET | `session`, `cwd`, `project` | deterministic discovery |
| `/installations` | GET | — | resolved KiCad/SolidCraft state |
| `/environment` | GET | `session` | agent context text + child env |
| `/source` | GET | `session`, `path`, `revision`, `cwd` | saved artifact text + content revision |
| `/fabrication` | POST | `session`, `path`, `schematic`, `cwd` | gerber/drill/CSV package, local only |
| `/bom` | POST | `session`, `path`, `cwd`/`workspace` | grouped BOM projection |
| `/glb` | POST | `session`, `path`, `cwd` | export or reuse a board GLB |
| `/glb-file` | GET | `path` | stream the cached GLB |
| `/order/pcb`, `/order/smt` | POST | `session`, `path`, `schematic`, `confirm` | real order upload |
| `/order/open` | POST | `url` | reopen a created order page in the browser |
| `/open` | POST | `application`, `artifactPath`, `kind` | native launch |

Authorization, applied before dispatch:

1. `Host` header must be loopback; `Origin`, when present, must be loopback
   (`403 forbidden` otherwise).
2. **Roots are per scope, and additive.** `session` names the DSH session the
   request belongs to; the host resolves that session's workspace from its own
   header (`sessions` → `sessionPersistence` → `sandboxPolicy`) and unions it
   with whatever that same session discovered. Roots never come from a
   process-wide "last discovery" and a request can only add roots, never revoke
   another scope's — a workspace switch is just another session discovering, so
   it cannot invalidate a viewer that stayed open. A caller-named root that is a
   file (the panel holds the `.kicad_pro`) is read as its directory.
3. Every read or export path is canonicalized and must stay inside those
   roots. Traversal, absolute escapes, and symlinks that escape the root are
   rejected. `/open` is the one route without a root check: it only launches an
   existing `.kicad_sch` / `.kicad_pcb` / `.kicad_pro` in the configured editor,
   and it must keep working when the session cannot be resolved.
4. Only `.kicad_sch` / `.kicad_pcb` (and declared mechanical types) are
   readable; source reads are capped by `maxSourceBytes` (`413 too-large`).
5. `revision` is honoured as an optimistic concurrency check
   (`409 stale-revision`).
6. Errors are `{ ok: false, error: { code, message } }` with a status that
   names the failure: `not-configured`/`missing-executable`/`unsupported-artifact`
   (412/412/415), `export-timeout` (504), `export-failed` (502).

No route consults PATH for a binary. A missing or invalid configuration is a
reported state, never a fallback.

---

## 4. Renderer and GLB lifecycle

`ecad.ts` — per mount: create an absolutely positioned canvas, size it to the
panel, call `renderPcb`/`renderSchematic` with
`{ canvas, container, interactive: true }`, then re-fit after two animation
frames (the renderer fits to the canvas size at load time). Disposal removes the
canvas and drops the viewer.

`preview.tsx` — every stage is keyed by `destination:path:revision`, owns one
`AbortController`, and disposes its predecessor. A load that resolves after the
viewer moved on is disposed, never attached (`live` flag + `AbortError`
filtering). 3D additionally mounts Three.js `GLTFLoader` output into the same
sized host and disposes renderer/controls on unmount.

`service.ts` — GLB export: cache key is `path:contentHash`; one in-flight export
is shared per key; output is written to a temp directory, validated (non-empty,
`glTF` magic), then renamed; timeout/abort leaves nothing behind and serves no
partial file. BOM export caches by content revision and writes/validates a temp
CSV the same way.

---

## 5. Artifact identity and revision strategy

- Identity is the artifact's kind + canonical absolute path + owning project
  (`artifact(kind, path, projectPath, sourcePath)`), so a semantic view (BOM,
  3D) keeps the identity of its source artifact.
- Discovery ranks candidates deterministically: explicit manifest → project-named
  file → the only unambiguous candidate. Multiple unowned boards stay
  `selectionRequired` instead of silently taking the first.
- Revision is the SHA-256 of the saved file content (`sourceRevision`), not
  mtime, so same-size/same-mtime edits still invalidate caches and stale reads.
- The UI navigates with `{ destination, path, kind, navigationRevision }`. The
  revision is monotonic per client, so re-clicking the same destination still
  refreshes (verified: one extra `/source` read, no tab remount).

---

## 6. Native KiCad launch behavior

`service.open()` resolves the configured installation, picks the executable for
the requested kind (schematic → eeschema, pcb/pcb-3d/bom → pcbnew), and spawns
with an explicit argv and `shell: false`. Missing artifacts and unsupported
kinds are rejected before spawn (`missing-executable`, `artifact-not-found`).
The UI exposes the action only in the viewer, with the resolved artifact in
scope, and disables it when no installation is configured.

---

## 7. Settings and agent environment

- `packages/hardware-artifacts/src/index.ts` declares `kicadRoot`,
  `solidcraftRoot`, `onboardingComplete` — all `.volatile()` so DSH projects them
  into an editable, persisted form.
- The settings section reads that form through `ctx.configForms.get(entryId)`
  (`useSyncExternalStore`), writes with `form.set(field, value)`, then
  re-validates through `/installations` and reports "validated and saved" or the
  concrete validation error.
- Persistence is the profile's `cordis.patch.yml` patch layer; a restart
  reconstructs the validation state (`v10.0.7`, resolved `kicad-cli`).
- `/environment` renders `<hardware_environment>` with the KiCad version, CLI
  and editors, the SolidCraft state, and the resolved project/schematic/board,
  plus a per-call `childEnv` (`HUAQIU_KICAD_*`, `HUAQIU_SOLIDCRAFT*`). Global
  `process.env` is never modified.

---

## 8. Quote/order integration

Order Placing is a file-level port of KiCad's own `PlaceOrder` action. KiCad
builds `PCB_FORM` / `PCB_SMT_FORM`, zips gerbers + drill outputs, posts multipart
and shows the returned page in an embedded webview. Without a KiCad GUI process
there is no in-process exporter or webview, so the host does the same work with
`kicad-cli` and hands the *same final URL* to the OS:

| Step | PCB | PCBA |
| --- | --- | --- |
| package | `kicad-cli pcb export gerbers` + `drill` → `<board>.zip` | same zip + `pcb export pos` and schematic BOM → two CSVs |
| post | `POST <base>/openapi/api/hqpcb/External/fileQuote` (form fields + `file`) | `POST <base>/openapi/pcba/saveDfmTmpOrder` (`reqParseVO`, `pcbFile`, `coordFile`, `bomFile`) |
| page URL | `<page>/mycenter/orders/pcb/quote?type=PCB&id=…&guid=…&tid=354&token=…` | `<page>/mycenter/orders/smt/quote?id=…&source=bom&token=…` |
| launch | OS default browser (`open` / `rundll32` / `xdg-open`, `shell:false`) | same |

Details that matter:

- The two URLs are built by `pcbOrderUrl` / `smtOrderUrl` and mirror
  `place_order_for_pcb.h` / `place_order_for_smt.h`, down to the query the hqpcb
  page actually shows:
  `…/pcb/quote?type=PCB&id=4679157&guid=…&tid=354&token=…` and
  `…/smt/quote?id=1309829474627354699&source=bom&token=…`. The assembly page is
  composed from the returned `id` (the endpoint's own URL is that page), so the
  result does not depend on which origin answered the POST; if a response ever
  carries no id, `smtOrderUrlFromBackend` falls back to appending `token` and
  `source=bom` exactly as the reference does. The raw backend string is still
  returned as `responseUrl`; `orderUrl` is what KiCad's webview would load, and
  it is what gets opened.
- `POST /order/open { url }` reopens a page without re-submitting; the result
  card's "Open in browser" uses it. Only `https`, or `http` on loopback, is
  accepted; credentials in the URL and other schemes are refused.
- Confirmation is two-sided: the panel requires an explicit checkbox and a
  confirm click, and the host refuses `POST /order/{pcb,smt}` unless
  `confirm: true`. Nothing is uploaded from a preview or a refresh.
- The token is the signed-in Huaqiu session (`huaqiuAuth.getAccessToken()`,
  read lazily through `ctx.get` so the plugin still works without auth mounted);
  an explicit config/env token remains an override for scripted runs. Both kinds
  require it and fail with `unauthorized` before uploading — a page without the
  token opens signed out. The assembly endpoint also sends it as
  `authorization`; the board endpoint takes no header, exactly like the
  reference client.
- Board facts come from the saved `.kicad_pcb`: copper layers, outline,
  thickness, minimum track/drill, stackup copper weight, pad count. They are
  snapped onto the tiers the form offers, not invented.
- No price is computed anywhere. The backend owns the quote and the order id;
  the panel only shows what will be uploaded.

The four quote tools (`quote_pcb`, `place_pcb_order`, `quote_smt`,
`place_smt_order`) stay registered and unchanged; they still report
`FAILED_PRECONDITION` without a quote backend, which does not block activation,
viewing or this file-level order flow.

---

## 9. Localization (zh_CN)

Every string the product renders is in `packages/dsh-hardware-ui/src/client/copy.ts`;
no component holds a literal sentence. One `COPY` object, one locale
(`LOCALE = 'zh_CN'`), functions for interpolation.

- **Why one module.** The same sentence is drawn from up to three seats (nav row,
  viewer body, settings section). Per-call-site literals had already drifted
  ("Open in KiCad" vs "KiCad missing" vs "not configured" naming the same state
  differently). The dictionary makes "is this translated?" mechanical.
- **Why zh_CN only.** Chinese-first product (`hq-eda-ai` resolves
  `languageMap[lang] || 'zh'`), eda.cn accounts, and a second language would ship
  untested. This is also why the dictionary is not registered with DSH's locale
  service: its typed overload takes `Record<BuiltInLocaleId, LocaleDictOf<N>>`,
  i.e. both `zh` and `en` are required, and the untyped single-locale arm would
  leave an en-active host resolving raw keys (`FALLBACK_LOCALE = 'en'`, and a
  `zh`-only namespace is not in `en`'s chain). Sibling packages hit the same wall
  and self-contained for the same reason (`dsh-auth/src/client/i18n.ts`,
  `dsh-tool-plugin-update/src/client/copy.ts`).
- **Adding `en` later.** `COPY` becomes `{ zh, en }` with
  `en: Record<CopyKeys, string>` (the `dsh-auth` shape, so a missing key is a
  compile error) and the locale comes from `<html lang>`. If the second language
  becomes real, move the dictionary into `ctx.locale.register` and declare
  `locale:` on the three slot registrations to get the framework's reactive `t`
  seat. No render site moves either way — they all read through this module.
- **Host text does not leak through.** Two different vocabularies:
  - *error envelope* — `transport.request` maps the route's stable `code`
    (`unauthorized`, `export-failed`, `order-rejected`, …) through
    `describeHostError`. Host detail is appended only where it is technical
    output (`kicad-cli` stderr, HTTP failure); for the rest it merely restated
    the code in English. Unknown codes keep the host sentence, so an unmodelled
    failure still says something specific.
  - *discovery issue* — `issueText` re-derives the sentence from `issue.code`
    plus the count/cwd, instead of echoing `issue.message`.
  - `PlacedOrder.message` (host English) is no longer rendered; the result card
    composes its own sentence from `kind` + `status`.
- **Commands are not prose.** `kicad-cli pcb export glb`, `.kicad_pcb`,
  file names, paths, revisions and units stay verbatim.
- **Contract test** (`test/copy.test.ts`): reads
  `hardware-artifacts/src/{routes,service}.ts`, extracts every code the host can
  emit, and fails if `COPY.errors` misses one — so a code added on the host side
  surfaces as a red test rather than an English sentence inside a Chinese panel.
  The same file asserts every discovery code actually translates and every
  destination label is present.
- **Visible text now Chinese:** navigation (`原理图 / PCB / BOM / 3D 模型 / 下单`),
  viewer strip and empty states, project/sheet/board selectors, wizard (three
  steps, buttons, hints), settings section (cards, validate/save result lines),
  preview stages (loading, errors, overlays, BOM header and columns), the whole
  Order Placing panel (cards, board facts, confirm dialog, quantity, result
  card), plus tab title and settings section label.

---

## 10. Empty views (centred, and never a dead end)

A destination with nothing to render shows one placeholder, centred on both axes
(`CENTER` in `preview.tsx` for a stage, the `missing` card in `components.tsx`
for a whole destination). The BOM's placeholder used to sit at the stage's left
edge: its wrapper was a row box, so a `height:100%` child shrank to its text. The
wrapper and the child now both stretch (`flex: 1 1 auto`), and every stage shares
the same column.

The copy is destination-specific and always ends with the way out:

| Destination | Pill | Guidance |
| --- | --- | --- |
| Schematic | 暂无原理图 | ask the agent to create the schematic (`.kicad_sch`), it appears here |
| PCB | 暂无 PCB | ask the agent to create and lay out the PCB (`.kicad_pcb`) |
| BOM | 暂无 BOM | BOM is generated from the schematic; create the schematic and it updates automatically |
| 3D | 暂无 3D 模型 | the model comes from the PCB; create the PCB and the preview appears |
| Order | 暂无可下单的板 | fabrication and assembly both need a PCB |
| no project | 暂无… | ask the agent to create the KiCad project (`.kicad_pro`) in this workspace |

Two deliberate exceptions:

- A **selection prompt** (several projects) keeps the reason but drops the
  guidance: the project select is directly above the card, and a second
  instruction would point at a control the user can already see.
- A **missing or failed KiCad installation** is a setting, not a missing
  artifact, so the stage shows the configuration hint instead of the agent
  guidance. The bare "不可用" pill is gone from every stage.

`missingState` is exported and unit-tested (title, reason, guidance per
destination); `copy.test.ts` asserts every destination has both strings, that the
BOM copy mentions the schematic and automatic update, and that the dictionary no
longer contains "不可用".

---

## 11. Test matrix

Legend: **U** unit (vitest), **I** integration (live web profile + headless
Chrome, real KiCad CLI), **S** source inspection, **B** blocked.

| Gate | Status | Evidence |
| --- | --- | --- |
| U1 panel default page | PASS U+S | the tab type registers `default: true`; `defaultSeed` seeds it into an empty docked pane, so expanding the column opens Hardware Engineering and no Start page exists (`client.test.ts`; shell `seed` contract) |
| U2 right-panel persistence | PASS I | collapse (panel at x=1441 > viewport) → reopen → fullscreen (1439px) → new session → return: body stayed mounted, `canvas` count stayed 1, no extra `/source` |
| U3 navigation revision | PASS U+I | repeat click on the same destination produced exactly 1 new `/source` read; `applyNavigation` bumps revision (`client.test.ts`) |
| U4 contextual action safety | PASS I | "Open in KiCad" rendered in the viewer header; DSH expand control switched 647→1439px with the body mounted, then restored |
| U5 settings persistence | PASS I | saved root survived a server restart; `/installations` returned `configured:true, version 10.0.7` |
| U6 one navigation, one header | PASS U+S | only two seats are registered (`sidebar.right.pane.tab`, `settings.section`); `conversation.header.leading` is gone, and the panel header carries the five destinations |
| U7 panel chrome | PASS S | docked strip is not drawn (`[data-dockkit-strip]` hidden); the overlay holds full screen + collapse (`panelChrome`) and hides with the docked items while collapsed; split/add/chips have no render path |
| U8 empty-view guidance | PASS U | `missingState` per destination title/reason/guidance; BOM copy names the schematic; dictionary contains no 不可用 (`client.test.ts`, `copy.test.ts`) |
| U9 corner + fullscreen | PASS I | real-browser CDP: collapsed corner shows 1 control (chrome hidden), expanded shows 2; button clicks flip push→fullscreen→push, a real mouse click in fullscreen restores push, and the hit-test lands on the buttons in both presentations (`ui-sidebar-right` 322/322, `dsh-hardware-ui` 42/42) |
| A1 canonical project | PASS U+I | fixture resolves one project with root sheet + 3 boards |
| A2 ambiguous project | PASS U | two `.kicad_pro` → `selection-required` |
| A3 board ownership | PASS U+I | owned board ranks first; 3-board manifest renders a Board selector |
| A4 schematic hierarchy | PASS U | child sheets from sheet references; unrelated siblings excluded; cycle-safe |
| A5 schematic rendering | PASS I | full sheet rendered, caption shows the source revision |
| A6 PCB rendering | PASS I | board fills the panel; selector switches to `simple_led` and re-renders |
| A7 stale rendering | PASS U+S | stage keyed by revision, per-stage `AbortController`, late results disposed. A deliberate mid-flight race was not scripted |
| A8 unmount cleanup | PASS S+I | canvas removed on dispose; board switch kept exactly one canvas |
| A9 BOM | PASS U+I | real KiCad 10 export → 14 grouped lines with refs/qty/value/footprint; DNP grouping in unit tests. MPN/manufacturer/custom fields only appear when the schematic defines them (fixture defines none); multi-unit/hierarchical grouping is unit-level only |
| G1 export + render | PASS I | GLB 951 384 B for `simple_led`, rendered with orbit/zoom |
| G2 source invalidation | PASS I | edit → `cached:false`, new revision; restore → original revision |
| G3 concurrent requests | PASS U | one shared in-flight export per content key |
| G4 interrupted export | PASS U | timeout → `export-timeout`, no partial file |
| G5 missing CLI | PASS U+I | `not-configured` 412; unit test asserts no PATH fallback |
| H1 exact launch | PASS U+S | per-kind argv assertions; live GUI launch not executed (would open the desktop app) |
| H2 shell-free launch | PASS U+I | `shell:false`; invalid/traversal paths rejected 403/415 |
| H3 environment context | PASS I | `/environment` payload quoted in §7 |
| Q1 offline registration | PASS U+I | 12 quote-tool tests; boot reports `no quote service configured`; viewing and file-level ordering unaffected |
| Q2 configured endpoint | PASS U+I (stub) | real `kicad-cli` export + real multipart POST to a local stub speaking the eda.cn contract: PCB 50 parts / 59 503 B, PCBA 4 parts / 56 828 B with `authorization`; final URLs recorded. The production endpoint is reachable (probed) but no real order was created — that is a commercial action |
| Q3 order URL ownership | PASS U+I | host builds exactly the webview URL (`pcbOrderUrl` / `smtOrderUrl`), including the token the signed-in session provides: observed `…/pcb/quote?type=PCB&id=STUB42&guid=stub-guid&tid=354&token=7047…` and `…/smt/quote?id=1309829474627354699&source=bom&token=7047…`; the UI displays it and never rewrites it. `responseUrl` keeps the backend's raw string |
| Q4 explicit confirmation | PASS U+I | panel requires a checkbox + confirm; host rejects `confirm !== true`; preview and refresh never upload |
| R1 offline activation 24/24 | PARTIAL | desktop fixture inherited from `docs/m1/…-poc-report.md`; the web profile reproduces the 11 mounted rows (`bundle.test.ts`: no duplicate rows, no HQ Edge injection) |
| R2 HQ Edge independence | PASS I | the whole walk ran without HQ Edge installed |
| R3 existing functionality | PASS U | `dsh-tool-pcb-viewer` 58/58, `hardware-engineering` 16/16, `hardware-artifacts` 62/62, `dsh-hardware-ui` 42/42, `ui-sidebar-right` 322/322 |
| R4 Windows x64 distribution | **B** | no Windows x64 host available |
| L1 zh_CN copy | PASS U+I | `copy.test.ts` 10/10: every destination labelled, every host error code translated (extracted from `routes.ts`/`service.ts`), every discovery code translated, unmodelled codes passed through, every empty view names its artifact and points at the agent. The corner controls were also checked in the live web profile with headless Chrome (U9). |

Baseline failures in unrelated packages, unchanged by this work and reproduced
on the untouched tree: `dsh-kicad` (bundled skill drifted from upstream
kicad-agent, 4), `dsh-plugin-log` (multi-process isolation/crash recovery, 4),
`dsh-analytics` (`defineTool` name tracking, 1), `dsh-tool-symbol-footprint`
(endpoint default drift, 2), `dsh-huaqiu-about` (no test files, fails
`pnpm -r test`).

---

## 12. Packaging and activation

- `pnpm launch-dsh:standalone` builds the three packages and rewrites the web
  profile to exactly
  `['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@huaqiu/hardware-engineering']`,
  removing stray `@huaqiu/*` links that duplicate bundle row ids. It is
  idempotent and repairs a profile previously polluted by `launch-dsh`.
- Boot with the product bundle logs no plugin error, no store-scope error, and
  no console warnings other than the expected quote-backend notice.
- Bundle tests assert: 11 mounted rows, no duplicate ids/names, providers
  ordered before consumers, exact dependency ledger, `workspace:*` ranges, no
  `@hqedge` reference anywhere, and no row gated on `hqEdge`.

---

## 13. Known limitations and deferred work

- **Windows x64 packaging (R4)** and the **desktop 24/24 activation fixture
  (R1)** were not re-run: this pass deliberately targets the official web
  profile as the fast dev loop, and the desktop branch is the release branch.
- **A production order (Q2)** was not created. The flow is exercised end to end
  against a contract stub with real `kicad-cli` output; creating a real order
  needs an account and is a commercial action, so the production endpoint was
  only probed for reachability.
- **Browser hand-off** is verified by recording the opener invocation
  (`openExternal` fake → `open <final URL>`); no automated walk was allowed to
  open a visible browser window. The production opener is `open` on macOS,
  `rundll32 url.dll,FileProtocolHandler` on Windows and `xdg-open` elsewhere,
  always with `shell:false`.
- **Native launch** was verified by argv/route assertions, not by opening KiCad,
  to avoid launching GUI applications during automated walks.
- A deliberate mid-flight race (A7) and a forced unmount during a pending fetch
  (A8) were reasoned through the keyed stages and disposal code, not scripted.
- MPN/manufacturer/custom BOM columns depend on schematic fields; the fixture
  defines none, so only refs/qty/value/footprint/DNP were observed live.
- SolidCraft is environment-context only: no native launch, no mechanical
  preview. The 3D destination always renders the selected PCB.
- The prototype's workspace project-artifact list and its above-chat navigation
  bar are intentionally not implemented (not required by the spec); the panel
  header carries the five destinations instead.
- The panel's split view, tab chips and add control are not reachable in this
  product: the docked strip is not drawn. The docking machinery still exists
  (a floating panel keeps its own header), so re-enabling a multi-tab panel is a
  stylesheet decision, not a rewrite.

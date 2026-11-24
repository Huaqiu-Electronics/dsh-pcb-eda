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
`@huaqiu/hardware-engineering` bundle. No DSH shell source is modified.

- Five persistent destinations (Schematic, PCB, BOM, 3D CAD, Order Placing)
  render in `conversation.header.leading`, above the chat panel, and stay
  visible without a session.
- Each destination opens the right-panel tab `hardware-engineering`
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
  installation.
- Order Placing packages the board with `kicad-cli`, posts the same forms KiCad
  posts, and opens the resulting order page — the exact URL KiCad loads in its
  own order webview — in the system default browser.
- Agent context (`/environment`) reports the configured toolchain and the
  resolved project; child env is returned per call (no `process.env` mutation).

---

## 2. Files changed

`dsh-pcb-eda` (only repository touched; `deepseek-harness` working tree clean)

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
| `dsh-hardware-ui` | `src/client/index.ts` | seat registration; two store handles; controller inject face |
| `dsh-hardware-ui` | `src/client/model.ts` | `HardwareController`, navigation params, discovery/installation shapes |
| `dsh-hardware-ui` | `src/client/store.ts` | `applyNavigation`, non-clobbering discovery refresh |
| `dsh-hardware-ui` | `src/client/components.tsx` | navigation row, viewer body, settings section |
| `dsh-hardware-ui` | `src/client/preview.tsx` | per-destination stages; KiCad-gated BOM/3D/order |
| `dsh-hardware-ui` | `src/client/order.tsx` | new: fabrication summary, confirmation dialog, result card, reopen in browser |
| `dsh-hardware-ui` | `src/client/transport.ts` | fabrication/order calls, `openOrderUrl` |
| `dsh-hardware-ui` | `src/client/theme.ts` | new: prototype-aligned tokens and primitives |
| `dsh-hardware-ui` | `src/client/ecad.ts` | sized canvas + post-layout re-fit + disposal |
| `dsh-hardware-ui` | `src/client/wizard.tsx` | new: three-step skippable wizard |
| `dsh-hardware-ui` | `test/client.test.ts` | seat/handle/inject-face/navigation assertions |

New fix in this pass, worth calling out:

- **Two store handles, not one.** DSH pins a store handle to the first scope it
  mounts under. `conversation.header.leading` and `settings.section` are `root`;
  `sidebar.right.pane.tab` is `session`. One shared handle produced
  `store handle mounted under "sidebar.right.pane.tab" (scope "session") is
  already mounted under scope "root"`. The two halves now coordinate only
  through tab params + revision, which is what the slot contract allows.
- **Volatile config is a reference, not a value.** `.volatile()` makes the
  config field a `{ get(): T }` reference; passing it to `path.resolve`
  produced `ERR_INVALID_ARG_TYPE` → HTTP 500 on `/installations`. Resolved via
  `readConfig()` at call time.
- **The page KiCad opens is not the URL the backend returns.** For PCB it is a
  composed `/mycenter/orders/pcb/quote` URL (id, guid, `tid=354`, token); for
  assembly it is the backend URL plus `token` and `source=bom`. The host now
  builds those, and `responseUrl` keeps the raw string.
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
| `/projects` | GET | `cwd`, `project` | deterministic discovery |
| `/installations` | GET | — | resolved KiCad/SolidCraft state |
| `/environment` | GET | `cwd` | agent context text + child env |
| `/source` | GET | `path`, `revision` | saved artifact text + content revision |
| `/bom` | POST | `path`, `cwd`/`workspace` | grouped BOM projection |
| `/glb` | POST | `path`, `cwd` | export or reuse a board GLB |
| `/glb-file` | GET | `path` | stream the cached GLB |
| `/open` | POST | `application`, `artifactPath`, `kind` | native launch |

Authorization, applied before dispatch:

1. `Host` header must be loopback; `Origin`, when present, must be loopback
   (`403 forbidden` otherwise).
2. Every artifact path is canonicalized and must stay inside the caller's
   `cwd`/`workspace` roots or the host's own roots. Traversal, absolute
   escapes, and symlinks that escape the root are rejected.
3. Only `.kicad_sch` / `.kicad_pcb` (and declared mechanical types) are
   readable; source reads are capped by `maxSourceBytes` (`413 too-large`).
4. `revision` is honoured as an optimistic concurrency check
   (`409 stale-revision`).
5. Errors are `{ ok: false, error: { code, message } }` with a status that
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
| page URL | `<page>/mycenter/orders/pcb/quote?type=PCB&id=…&guid=…&tid=354&token=…` | backend `result.url` + `token` + `source=bom` |
| launch | OS default browser (`open` / `rundll32` / `xdg-open`, `shell:false`) | same |

Details that matter:

- The two URLs are built by `pcbOrderUrl` / `smtOrderUrl` and mirror
  `place_order_for_pcb.h` / `place_order_for_smt.h` field for field. The raw
  backend string is still returned as `responseUrl`; `orderUrl` is what KiCad's
  webview would load, and it is what gets opened.
- `POST /order/open { url }` reopens a page without re-submitting; the result
  card's "Open in browser" uses it. Only `https`, or `http` on loopback, is
  accepted; credentials in the URL and other schemes are refused.
- Confirmation is two-sided: the panel requires an explicit checkbox and a
  confirm click, and the host refuses `POST /order/{pcb,smt}` unless
  `confirm: true`. Nothing is uploaded from a preview or a refresh.
- The assembly endpoint's `authorization` header is the configured Huaqiu token;
  the board endpoint takes none, exactly like the reference client.
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

## 9. Test matrix

Legend: **U** unit (vitest), **I** integration (live web profile + headless
Chrome, real KiCad CLI), **S** source inspection, **B** blocked.

| Gate | Status | Evidence |
| --- | --- | --- |
| U1 nav without session | PASS U+I | fresh profile: nav visible, no session; registered in `conversation.header.leading` (`client.test.ts`) |
| U2 right-panel persistence | PASS I | collapse (panel at x=1441 > viewport) → reopen → fullscreen (1439px) → new session → return: body stayed mounted, `canvas` count stayed 1, no extra `/source` |
| U3 navigation revision | PASS U+I | repeat click on the same destination produced exactly 1 new `/source` read; `applyNavigation` bumps revision (`client.test.ts`) |
| U4 contextual action safety | PASS I | "Open in KiCad" rendered in the viewer header; DSH expand control switched 647→1439px with the body mounted, then restored |
| U5 settings persistence | PASS I | saved root survived a server restart; `/installations` returned `configured:true, version 10.0.7` |
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
| Q3 order URL ownership | PASS U+I | host builds exactly KiCad's webview URL (`pcbOrderUrl` / `smtOrderUrl`); the UI displays it and never rewrites it. `responseUrl` keeps the backend's raw string |
| Q4 explicit confirmation | PASS U+I | panel requires a checkbox + confirm; host rejects `confirm !== true`; preview and refresh never upload |
| R1 offline activation 24/24 | PARTIAL | desktop fixture inherited from `docs/m1/…-poc-report.md`; the web profile reproduces the 11 mounted rows (`bundle.test.ts`: no duplicate rows, no HQ Edge injection) |
| R2 HQ Edge independence | PASS I | the whole walk ran without HQ Edge installed |
| R3 existing functionality | PASS U | `dsh-tool-pcb-viewer` 58/58, `hardware-engineering` 16/16, `hardware-artifacts` 51/51, `dsh-hardware-ui` 12/12 |
| R4 Windows x64 distribution | **B** | no Windows x64 host available |

Baseline failures in unrelated packages, unchanged by this work and reproduced
on the untouched tree: `dsh-kicad` (bundled skill drifted from upstream
kicad-agent, 4), `dsh-plugin-log` (multi-process isolation/crash recovery, 4),
`dsh-analytics` (`defineTool` name tracking, 1), `dsh-tool-symbol-footprint`
(endpoint default drift, 2), `dsh-huaqiu-about` (no test files, fails
`pnpm -r test`).

---

## 10. Packaging and activation

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

## 11. Known limitations and deferred work

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
  bar are intentionally not implemented (not required by the spec); the
  conversation header carries the five destinations instead.

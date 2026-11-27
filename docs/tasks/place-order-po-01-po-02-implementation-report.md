# PO-01 / PO-02 Implementation Report — Place Order

**Scope:** `C:\code\dsh-pcb-eda` (Huaqiu DSH plugin) and `C:\code\deepseek-harness` (desktop fork, branch `desktop`)
**Tasks:** `docs/tasks/PO-01-plugin-owned-place-order-workflow.md`, `docs/tasks/PO-02-huaqiu-dsh-desktop-native-place-order-menu.md`
**Date:** 2026-11-27

The user's constraint drove every decision below: the pipeline *prepare order form → POST to backend → load the returned URL into an MDI view* **already exists**. PO-01 therefore adds no manufacturing code — it adds a project-selection entry point that hands the chosen project to the existing order destination. PO-02 adds no business code at all — it adds a menu entry that calls one plugin method.

Ordering itself was then reduced to **one click**: the confirmation dialog and its consent flag were removed from the panel, the transport and the two `POST /order/*` routes (see §3.4), because the click on the order card is the decision.

---

## 1. Source audit — what already existed and is reused verbatim

### 1.1 Host (`packages/hardware-artifacts`)

| Capability | Location | Reused by PO-01 as |
|---|---|---|
| Deterministic project scan (`.hardware-engineering.json` > explicit project > walk of `.kicad_pro`) | `src/service.ts:729` `discover()` | the only scanner; the new view renders its answer |
| Order capability probe (`configured`, `baseUrl`, `hasToken`) | `src/service.ts:1168` `orderConfig()`, `src/routes.ts:258` `GET /order` | the sign-in chip and the sign-in block reason |
| Token source (Huaqiu login or `HUAQIU_ACCESS_TOKEN`) | `src/service.ts:1187` `orderToken()` | untouched; no second auth path |
| Packaging (kicad-cli Gerber / drill / positions / BOM + validation) | `src/service.ts:1206` `fabricate()`, `POST /fabrication` | untouched |
| Upload + URL synthesis (`pcbOrderUrl` / `smtOrderUrl`) | `src/service.ts:1362` `placeOrder()`, `POST /order/pcb` (`routes.ts:293`), `POST /order/smt` (`routes.ts:328`) | untouched; the view never calls these directly |
| Page hand-off to the OS browser (fallback only) | `POST /order/open` (`routes.ts:363`) | untouched |

Agent tools (`hardware_place_pcb_order` and friends) and `order-watcher.ts` are unchanged — the agent entry point still converges on the same `service.placeOrder`.

### 1.2 Client (`packages/dsh-hardware-ui/src/client`)

| Capability | Location | Reused by PO-01 as |
|---|---|---|
| Order destination UI (two cards → one click uploads → page opens) | `order.tsx:136` `OrderPanel` | the only place an order is placed (its confirmation dialog was removed, §3.4) |
| Page opener (panel tab → Host `/order/open` → `window.open`) | `order-page.ts:34` `openOrderPage` | unchanged |
| Order MDI tab (`kind = hardware-order`, one tab per order, iframe, `referrerPolicy=no-referrer`) | `order-tab.tsx:27/77` | unchanged |

### 1.3 Desktop (`C:\code\deepseek-harness`)

The Windows "native menu bar" is drawn in the renderer by the preload script, not by the main process:

- `apps/desktop/src/preload-menu.ts` — `installWindowsMenu()` builds a shadow-DOM `[role=menubar]` with the `Application` and `Edit` buttons, each invoking `DESKTOP_IPC.windowsMenu` to open a native popup.
- `apps/desktop/src/locale.ts` — eight locale dictionaries sharing one keyset.

PO-02 therefore touches only those two files plus their tests. No new IPC channel, no main-process menu, no menu-extension framework.

---

## 2. PO-01 — project discovery as data, not as UI

`HardwareProject` gained a readiness field computed by the same `projectFrom()` that already decides boards and schematics:

```ts
interface OrderReadiness { readonly ready: boolean; readonly reason?: 'no-board' | 'no-schematic' }
// HardwareProject.order: { pcb: OrderReadiness; pcba: OrderReadiness }
```

- `pcb` — blocked (`no-board`) when the project resolved no PCB artifact.
- `pcba` — additionally blocked (`no-schematic`) when no root schematic resolved, because positions and the BOM are exported from it.

It deliberately says nothing about KiCad being installed or the account being signed in: those are per-machine facts (`orderConfig()`), not per-project facts, and mixing them would make one project's row depend on another user's setup.

**Files:** `src/service.ts` (`OrderReadiness`, `HardwareProject.order`, `projectFrom()`), `src/index.ts` (type export).

---

## 3. PO-01 — the plugin-owned Place Order view

`packages/dsh-hardware-ui/src/client/place-order.tsx` — `PlaceOrderBody`, mounted in the existing panel seat as its own tab (`PLACE_ORDER_TAB_KIND = 'hardware-place-order'`, single instance).

It does exactly two jobs:

1. **List** — `discover(cwd, undefined, sessionId)` from the session's workspace, plus `installations()` and `loadOrderConfig()` for the two machine-level chips. Re-runs on mount and on the explicit `重新扫描` button; no polling, no watcher.
2. **Hand off** — one click calls `controller.orderProject({ projectPath, boardPath, schematicPath?, kind })`, which opens the existing hardware tab at `destination: 'order'` carrying `orderKind`.

From there the existing `OrderPanel` runs the whole known pipeline: package → one click → `POST /order/{pcb,smt}` → `openOrderPage(url)` → `hardware-order` tab. `orderKind` places the operation the user just chose as soon as the package and the account are ready, so choosing PCB/PCBA in the selector is already the order — no second click, no dialog.

`schematicPath` travels with the navigation because discovery also assigns a *unique* schematic from the scanned tree; without it, a panel that had another project open would package the new board's PCBA with the old project's BOM and positions.

**Readiness is shown, never guessed.** A blocked operation keeps its button visible, disabled, with the reason next to it (`no-board`, `no-schematic`, KiCad missing, not signed in). While the two probes are still running the chips read `检测中… / Checking…` instead of claiming readiness.

### 3.1 Entry points

| Entry | Path |
|---|---|
| Desktop menu (PO-02) | `preload-menu.ts` → `runPlaceOrderHandler()` → the callback the plugin registered through `dshDesktop.registerPlaceOrder` → `controller.placeOrder()` → `sidebarRight.openTab('hardware-place-order', { revealIfOpened: true })` |
| Agent (unchanged) | `hardware_place_pcb_order` etc. → `service.placeOrder()` → `order-watcher` opens the page |

`placeOrder()` is idempotent for the same reason the tab type is single-instance: a second press reveals the first view instead of stacking a second one. It returns `false` when the panel is absent, so the menu can say so rather than pretend.

The plugin registers inside an `effect()` and withdraws the registration on dispose, so a plugin reload leaves no stale callback behind.

**Why not a window global.** Desktop windows run with `contextIsolation: true` and `sandbox: true` (`apps/desktop/src/main.ts`). A property the page sets on `window` lives in the renderer main world; the preload sees a different `window` object, so a global handle is never visible to the caption menu — that is exactly the installed-build symptom "the Huaqiu EDA plugin is not loaded yet" while the plugin was loaded. The contract therefore crosses the boundary the supported way: preload owns a registry (`preload-place-order.ts`) and publishes `registerPlaceOrder` on the existing `dshDesktop` product API through `contextBridge`; the plugin hands its callback in and removes it on unload.

### 3.4 One click, not two (follow-up on the confirmation)

The confirmation dialog and the `confirm: true` flag it produced are gone:

| Layer | Before | Now |
|---|---|---|
| Panel (`order.tsx`) | card → dialog with file list + acknowledgement checkbox → upload | card → upload; the card's own button reads `提交 PCB 订单 / Place PCB order`, and a one-line `uploadHint` states that the click uploads |
| Transport (`transport.ts`) | `placeOrder(kind, { …, confirm: true })` | no `confirm` field; the body is path/schematic/cwd/session/quantity |
| Host routes (`routes.ts`) | `POST /order/pcb` and `/order/smt` answered `400 confirmation-required` unless `confirm === true` | both accept the request directly; only a missing `path` is rejected (`invalid-request`) |
| `focus` from the selector | opened that kind's dialog | places that kind through the same `submit()` |
| Agent tools (`tools.ts`) | unchanged | unchanged — `hardware_place_pcb_order` still requires its own `confirm` argument, because that guard belongs to the model, not to a file-upload dialog |

Safety that survives the removal: the package is still prepared and listed *before* the button becomes clickable, the buttons stay disabled until KiCad is configured and the account is signed in, one in-flight upload is enforced by a ref (double click = one order), and the panel shows the exact archive name and size it uploaded.

**Files:** `order.tsx`, `transport.ts`, `routes.ts`, `copy.ts`, `locales.ts`, plus tests (§7).

**Files:** `place-order.tsx` (new), `model.ts` (`HardwareProjectInfo.order`, `ViewerNavigationParams.orderKind/schematicPath`, `placeOrder(): boolean`, `orderProject()`), `store.ts` (`applyNavigation` honours `schematicPath`), `components.tsx` + `preview.tsx` (`orderKind` down to `OrderPanel.focus`), `order.tsx` (`focus` prop, `autoPlaced` ref, places the chosen kind once), `copy.ts` + `locales.ts` (zh/en strings), `index.ts` (tab type, slot body, handle, constants).

---

## 4. PO-02 — the desktop menu entry

```
Application    Edit    🛒 Place Order
```

- Third button in `preload-menu.ts`, cart glyph inlined as SVG, label from the locale dictionary, `aria-label`/`title` set so the entry is discoverable without the glyph.
- It is **not** a popup: pressing it *is* the command (`role=menuitem`, no `aria-haspopup`). No new IPC channel, no main-process code.
- One thing is asked of the plugin: it registers `dshDesktop.registerPlaceOrder(handler)` while active. The shell never names a project, an order type or a URL, and it does not see any of the plugin's business logic.
- Keyboard parity: ArrowLeft/Right now cycle over three entries (previously a two-entry pair), Enter/Space run the workflow.
- Feedback: a small shadow-DOM notice under the title bar, auto-hidden after 4 s, shown when the plugin is absent (`placeOrderUnavailable`) or the call throws (`placeOrderFailed`, also `console.error('Desktop place order menu failed', …)`). `Application` and `Edit` are untouched by any failure.
- Localization: `placeOrder`, `placeOrderUnavailable`, `placeOrderFailed` added to **all eight** dictionaries (`en zh ja es fr de ru pt`).

**Files:** `apps/desktop/src/preload-menu.ts`, `apps/desktop/src/locale.ts`, `apps/desktop/tests/preload-menu.client.spec.ts` (+ snapshot update).

---

## 5. Reuse boundary (the "no second implementation" claim)

| Concern | Single owner |
|---|---|
| Project scanning | `service.discover()` — the new view calls it through `GET /projects` |
| Readiness | `service.projectFrom()` — the new view only renders `project.order` |
| Packaging / validation | `service.fabricate()` |
| Token / auth | `service.orderToken()` |
| Upload + URL synthesis | `service.placeOrder()`, `order.ts` helpers |
| The upload *trigger* | one click on the order card in `OrderPanel` (`data-hardware-order-action`) |
| Page display | `openOrderPage()` → `ORDER_TAB_KIND` |
| Agent compatibility | `createHardwareTools()` + `order-watcher` (untouched) |

The desktop shell's total contribution is one button and one handle call.

---

## 6. Acceptance matrix

### PO-01

| # | Criterion | Evidence |
|---|---|---|
| 1 | Invoke without an agent message | `hardware-place-order` tab × desktop menu; `place-order.test.tsx` › desktop shell handle |
| 2 | Multiple projects discovered correctly | `service.test.ts` discovery cases (existing) + view renders one row per project (`project list` › shows every project…) |
| 3 | Duplicate basenames distinguishable | row identity = path, subtitle = path relative to workspace; `keeps two projects with the same basename apart…` |
| 4 | Works independently of open MDI documents | discovery is a filesystem walk (`service.ts:729`); the view never reads the viewer store |
| 5 | Selection view hosted in MDI | `PLACE_ORDER_TAB_KIND` registered in `sidebarRightTabs`, body in `sidebar.right.pane.tab`; `client.test.ts` |
| 6 | PCB order uses the selected project's PCB | hand-off test asserts `boardPath` = that project's `defaultBoard` |
| 7 | PCBA uses the selected project's PCB + BOM data | hand-off test asserts `kind: 'smt'` + `schematicPath` of that project; `sends no schematic at all…` when absent |
| 8 | Unavailable types explained | `readiness reasons` describe (no board, no schematic, KiCad missing, not signed in, probing) |
| 9 | hqpcb page opens in MDI with token | `OrderPanel` one-click `placeOrder()` → `openOrderPage()` → `hardware-order` tab (unchanged path, now reachable from the new entry) |
| 10 | Agent ordering still functional | tools and `order-watcher` untouched; host suite 151 passed |
| 11 | No parallel manufacturing implementation | §5 table; new view issues no POST except through the controller |

### PO-02

| # | Criterion | Evidence |
|---|---|---|
| 1 | Beside `Application` and `Edit` | snapshot `english`/`chinese`; bar order Application, Edit, Place Order |
| 2 | Cart icon visible | inline SVG in the third button (`data-place-order`) |
| 3 | Available regardless of active document | the menu is mounted from `[data-shell-overlay]`, not from any document |
| 4 | Click invokes the plugin workflow | `runs the loaded plugin workflow…` — `placeOrder` called, zero IPC |
| 5 | Plugin opens its view in MDI | plugin handle test: `openTab('hardware-place-order', { revealIfOpened: true })` |
| 6 | User can continue to hqpcb | §3 hand-off tests + existing order path |
| 7 | Repeat clicks: no duplicate views | single-instance tab kind + `revealIfOpened`; test calls the handle twice and asserts the same tab kind |
| 8 | Plugin failure does not affect DSH | menu catches, logs, shows a notice; `Application`/`Edit` untouched; absent-plugin test |
| 9 | No business logic in the shell | menu imports nothing from the plugin; it runs only the callback the plugin registered through `dshDesktop.registerPlaceOrder` |
| 10 | Agent compatibility | §5 |

---

## 7. Tests and checks run

| Suite | Command | Result |
|---|---|---|
| Client typecheck | `pnpm --filter @huaqiu/dsh-hardware-ui exec tsc --noEmit -p tsconfig.json` | clean |
| Client tests | `… exec vitest run --reporter=dot` | **177 passed** (17 files) — incl. new `test/place-order.test.tsx` (15) and `test/order-panel.test.tsx` (6) |
| Host typecheck | `pnpm --filter @huaqiu/hardware-artifacts exec tsc --noEmit -p tsconfig.json` | clean |
| Host tests | `… exec vitest run --reporter=dot` | **151 passed** (was 148; +1 readiness, +2 order routes) |
| Client build | `pnpm --filter ./packages/dsh-hardware-ui build` | `lib/client.js` 5.52 MB, contains `hardware-place-order`, `data-hardware-order-hint`, `registerPlaceOrder`; no `data-hardware-order-confirm` / `data-hardware-order-ack` |
| Host build | `pnpm --filter ./packages/hardware-artifacts build` | ok |
| Desktop typecheck | `pnpm exec tsc -b tsconfig.host.json tsconfig.client.json` (the build's own project-reference gates) | clean |
| Desktop full build | `pnpm build` in `C:\code\deepseek-harness` | **10 passed, 0 failed** (135 s) |
| Desktop menu + locale | `npx vitest run apps/desktop/tests/preload-menu.client.spec.ts apps/desktop/tests/locale.spec.ts` | **30 passed** (menu spec 13, snapshots updated) |

New/updated test cases worth naming:

- `service.test.ts` — *states order readiness from the files it found…*: `both` ready/ready, `nosch` ready/`no-schematic`, `noboard` `no-board`/`no-board` (one directory per case, because discovery also adopts a unique schematic or board from the scanned tree).
- `place-order.test.tsx` — 15 cases: rows and artifact summary, several projects, duplicate basenames, empty workspace, scan failure, PCB/PCBA hand-off (board + schematic), no-schematic hand-off, three readiness reasons, probing chips, refresh rescans, handle installed/removed, handle reports failure without a panel.
- `order-panel.test.tsx` — 6 cases: one-click upload with no dialog and no `confirm` in the body, PCBA with quantity, double click = one order while both cards wait, `focus` places the chosen kind exactly once, signed-out and package-failed states keep the buttons disabled.
- `routes.test.ts` — *uploads without requiring a confirmation flag from the client*: both `POST /order/pcb` and `/order/smt` answer 200 for a request without `confirm`, and the service never sees a `confirm` key; a missing `path` is still `400 invalid-request`.
- `preload-menu.client.spec.ts` — 13 cases: the original 8 plus workflow invocation without IPC, absent-plugin notice, rejected invocation, a withdrawn registration returning to the notice, arrow cycling past the third entry.

---

## 8. Known limitations and constraints

1. **No browser E2E for this round.** The `127.0.0.1:3080` dev web server still serves a frozen 21 MB client bundle whose source could not be located (byte count unchanged after injecting a `throw` into `packages/dsh-hardware-ui/lib/client.js`). The rebuilt `lib/client.js` is 5.53 MB and does contain the new markers, so the staleness is in the dev server's serving path, not in the build. UI evidence is therefore jsdom DOM assertions, not screenshots.
2. **One click is real.** There is no undo inside the shell: pressing the order card uploads and creates the order at Huaqiu. The compensating affordances are informational, not blocking — the package (file names, zip name and size) is prepared and listed before the button enables, the button label says it orders, and `uploadHint` says the click uploads. The host route no longer refuses an unconfirmed request, so any client that posts one is believed. If a later product decision wants a consent step back, it belongs in `OrderPanel` (and optionally a route flag), not in the agent tools.
3. **macOS menu not touched.** PO-02 targets the Windows caption bar, which is the menu this machine shows. The macOS build uses a separate native app menu; adding the same entry there is a second, independent change.
4. **The menu reaches the plugin through `contextBridge`, not a global.** Desktop windows run `contextIsolation: true` + `sandbox: true`, so the plugin cannot publish a callback by assigning `window.huaqiu` — a page-set global is invisible to preload, which is why the first installed build reported "the plugin is not loaded yet" while the plugin was running. Preload now owns a one-handler registry (`preload-place-order.ts`), publishes `registerPlaceOrder` on the existing `dshDesktop` product API, and the menu runs whatever is registered; no registration degrades to the `placeOrderUnavailable` notice, which is the PO-02 "plugin unavailable" requirement rather than a silent no-op. An installed build therefore needs a rebuilt preload — repackaging, not just replacing the plugin bundle.
   Its arrow-key navigation indexes a `buttons` array, and the desktop build compiles that file with `noUncheckedIndexedAccess` — so the neighbour is guarded (`if (next === undefined) return`) instead of asserted. `tsc -p apps/desktop/tsconfig.json` does not see this; `tsc -b tsconfig.host.json` (what `pnpm build` runs) does.
5. **PCBA readiness is file-based only.** It checks board + root schematic; a schematic with no components still reports ready and fails later during packaging, with the packaging error shown by the existing order panel.
6. **`builder`/`agent-instructions.spec.ts` baseline** in the harness still has 3 environment-level failures (Windows symlink `EPERM`), unrelated to this work.

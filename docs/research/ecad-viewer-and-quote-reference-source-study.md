# Artifact-viewer POC — ecad-viewer integration and quote reference source study

**Date:** 2026-11-23  
**Status:** Revised implementation specification; supersedes the rendering, SolidCraft, DFM and quote-backend gates in `docs/tasks/hardware-engineering-artifact-viewer-poc.md`  
**Specs linked from:** `docs/m1/hardware-engineering-artifact-viewer-poc-report.md`  
**Local baselines:** `dsh-pcb-eda` `8566f75` (POC work uncommitted), `ecad-viewer` `a2679a11` (clean), `kicad` `8a9453e765` (clean), `deepseek-harness` `8097be700f` (clean)

This study is based on the actual local source trees, not on the Backplane reference commit named in the original task. It answers the two source-level questions requested before detailed coding:

1. Which ecad-viewer APIs are reusable for schematic, PCB and GLB rendering, with what dependencies and smallest DSH adapter?
2. What does the KiCad quote reference do, and what is already covered by the existing DSH quote/order tools?

---

## 1. Scope reset from the blocker decisions

The user's blocker decisions replace several original acceptance items. The new baseline is:

| # | Decision | Consequence for the POC |
|---|---|---|
| 1 | Browser rendering is solved by the ecad-viewer packages. | Implement schematic and PCB rendering with `@huaqiu/kicad-sexpr-parser` + `@huaqiu/ecad-renderer`; do not re-host `@huaqiu/dsh-tool-pcb-viewer`. |
| 2 | SolidCraft needs no further integration beyond a user-configured installation path; it is already agent-ready. | Keep the settings field and compact agent context. Remove SolidCraft native launch, file-opening arguments and launch acceptance. |
| 3 | KiCad GUI handoff will be tested by the user on Windows. | Keep the shell-free launch contract and exact-artifact validation. Interactive window verification is an external validation step, not a coding blocker. |
| 4 | Renderers are available at `/Users/admin/code/ecad-viewer`. | Use the local package APIs and versions documented below. |
| 5 | No DFM tab in this POC. | Remove the DFM destination, DFM selectors and DFM score gates. |
| 6 | GLB only, converted from `.kicad_pcb` with `kicad-cli`. | Remove STEP/STP conversion and mechanical-model selection. PCB 3D is derived from the selected board. |
| 7 | Reuse ecad-viewer packages to render both PCB and schematic. | `@huaqiu/ecad-renderer` becomes the single 2D rendering foundation in the product tab. |
| 8 | Quote reference is `/Users/admin/code/kicad/copilot/assistant/quote`. | Audit it: KiCad is a thin wrapper that builds a PCB/SMT form, POSTs it and opens the backend-returned URL in a webview/browser. Reuse the existing DSH quote/order tools and hq-edge router. Do not build a DSH-side quote backend. |
| 9 | Plain three.js is preferable for GLB because ecad-viewer is only a wrapper on it. | Use a small pinned `three` GLB component in the existing UI plugin. Do not import the ecad-viewer app's custom-element 3D shell. |

The unchanged target is **one product UI plugin, one host capability, and at most one small DSH shell change**. This study finds **no shell change required**: the existing webServer route surface and Cordis client slots are sufficient. There is no new runtime, project database, daemon, embedded editor, universal IR or parallel renderer architecture.

---

## 2. ecad-viewer integration audit

### 2.1 Packages and versions

| Local package | Version | Role | Public entry points | Evidence |
|---|---|---|---|---|
| `packages/kicad-parser` | `@huaqiu/kicad-sexpr-parser@0.1.1` | Parse native KiCad S-expressions into PODs | `.` → `dist/index.js` / `dist/index.mjs`, types `dist/index.d.ts` | `packages/kicad-parser/package.json`; MIT header in `src/schematic_parser.ts:1-4` and `src/board_parser.ts:1-4` |
| `packages/ecad-renderer` | `@huaqiu/ecad-renderer@0.2.4` | Browser canvas/WebGL rendering of parser PODs | `.`, `/symbol`, `/footprint`, `/schematic`, `/pcb`, `/project`, `/worker` | `packages/ecad-renderer/package.json`; `src/index.ts:1-13` |
| `packages/ecad-viewer-app` | `ecad-viewer-app@1.0.0` | Standalone application / web-component shell; not the reusable rendering API | `.` → app bundle | `packages/ecad-viewer-app/package.json` |

The two library packages already have built `dist/` trees in the local checkout, and the exact versions are published on npm (`npm view @huaqiu/kicad-sexpr-parser version` → `0.1.1`; `npm view @huaqiu/ecad-renderer version` → `0.2.4`). Their versions match the existing DSH pins: `@huaqiu/kicad-sexpr-parser@^0.1.1` is used by `packages/dsh-tool-pcb-viewer/package.json:37` and `packages/dsh-tool-symbol-footprint/package.json:52`; `@huaqiu/ecad-renderer@^0.2.4` is used by `packages/dsh-tool-symbol-footprint/package.json:51`. The ecad-viewer root `LICENSE.md` is an MIT-style Huaqiu license requiring notice retention.

### 2.2 Parser API

`packages/kicad-parser/src/index.ts:1-12` exports:

- `BoardParser` (`src/board_parser.ts:700`) — `parse(text)` returns `boardProto.I_KicadPCB`.
- `SchematicParser` (`src/schematic_parser.ts:667`) — `parse(text)` returns `schematicProto.I_KicadSch`; `parseLibSymbols(text)` at `src/schematic_parser.ts:736`.
- `parseLibSymbol`, serializers, `parse_drawing_sheet`, and the POD namespaces `boardProto`, `schematicProto`, `drawingSheetProto`, `commonProto`.

The schematic POD retains KiCad identity and hierarchy fields: UUIDs, `sheet_instances`, `symbol_instances`, symbol `instances.projects[].paths`, and `sheets` (`src/proto/schematic.ts:252-389`). This is enough to render a selected root sheet and to keep an exact sheet identity. It does **not** by itself resolve a whole multi-file hierarchy into one document: there is no `KicadSch.sheetfile` field, and `SchematicParser.parse()` only produces one POD per file. The app supplies sub-sheet filenames later through `KicadSch.fill_filename()` using a `name → path` map (`packages/ecad-viewer-app/src/kicad/schematic.ts:49,103-105,120-125,385-390`), not through the parser. Sheet selection and root-sheet mapping therefore remain host responsibilities, as identified in the Backplane study.

**Decision:** send the exact selected `.kicad_sch` / `.kicad_pcb` text from the host to the browser and parse it there. Do not invent a host-side parsed-document wire format. This is the pattern already proven offline in `packages/dsh-tool-symbol-footprint/src/client/ecad.ts:1-97`.

### 2.3 Renderer API

`packages/ecad-renderer/src/index.ts:1-13` exports:

- `renderSchematic(schematic, options)` — `src/render.ts:87`.
- `renderPcb(pcb, options)` — `src/render.ts:104`.
- `renderSymbol` / `renderFootprint` — `src/symbol.ts:41`, `src/footprint.ts:6`; these are adapters that build the smallest schematic/board POD around a library symbol or footprint.
- `loadProjectZip` (`src/project.ts`) and `renderProjectFromZip` (`src/project-render.ts:21`).
- `createRendererWorker` / `createRendererClient` (`src/worker.ts:12,16`).

`RenderOptions` is deliberately small (`src/types.ts:9-17`):

```ts
interface RenderOptions {
  canvas?: HTMLCanvasElement
  container?: HTMLElement
  interactive?: boolean
}
```

`RenderResult` returns `{ canvas, viewer, dispose() }` (`src/types.ts:19-23`), with `viewer` typed as `unknown`; only the documented `dispose()` contract should be used. `render.ts:38-53` appends a created canvas to `container` or `document.body`, suppresses the browser context menu for right-drag pan, and syncs backing resolution to CSS size × DPR. `render.ts:55-85` mounts the existing `SchematicViewer` / `BoardViewer`, sets `show_drawing_sheet = false`, awaits `setup()`, `load()` and `loaded`, and returns the dispose handle. The package is ESM-only: `package.json` exports `import` entries but no `require` condition, and `dist/index.js` itself uses `export` syntax.

The README (`packages/ecad-renderer/README.md`) states the intended contract: all APIs accept parser PODs, no renderer-specific model is introduced, the CJK stroke glyph table is bundled, and there is no font CDN or network dependency. It also notes that the bundled glyph table adds about 2 MB and that the current worker protocol is parser-only while rendering remains on the Canvas/WebGL path. The exported `createRendererWorker` / `createRendererClient` protocol is currently a stub: `src/renderer.worker.ts:8-10` always returns an error, and the README calls it parser-only. DSH must not call it in this POC.

The renderer uses fixed default themes (`render.ts:94,113`) and does not expose an API for theme overrides or viewer-internal selection. A DSH adapter should pass `interactive: true` where appropriate, own the DOM node and size, and rely only on `dispose()`.

**Decision:** use the subpath exports `@huaqiu/ecad-renderer/schematic` and `/pcb` in the existing `@huaqiu/dsh-hardware-ui` client bundle. The host already owns exact artifact selection, so `renderProjectFromZip` is unnecessary. The worker API is unnecessary for this POC.

### 2.4 What the app adds, and what must not be copied

`packages/ecad-renderer/examples/mini-integration/main.ts:18-51` is the smallest complete usage example: fetch raw `.kicad_sym` / `.kicad_mod` / `.kicad_sch` / `.kicad_pcb` text, parse with `SchematicParser` / `BoardParser`, then call `renderSymbol` / `renderFootprint` / `renderSchematic` / `renderPcb` with an existing canvas and `interactive: true`.

`packages/ecad-viewer-app` adds UI-shell concerns that DSH already owns:

- project and ZIP loading (`src/kicanvas/project.ts`, `src/ecad-viewer/ecad_viewer.ts`);
- custom elements and tab headers (`src/kc-ui/`, `src/ecad-viewer/tab_header.ts`);
- web host / iframe bridges (`src/eda_host/`, `src/ecad-viewer/iframe_bridge.ts`);
- app-only BOM visitors (`src/kicad/schematic_bom_visitor.ts`, `board_bom_visitor.ts`, `bom_item.ts`), which are not exported by `@huaqiu/ecad-renderer`;
- the separate 3D custom element (`src/3d-viewer/`).

None of those app-shell pieces should be re-hosted. DSH already has the settings shell, right-sidebar tab, session state and native action slots.

### 2.5 GLB and three.js

The user's "wrapper on three.js" characterization applies to the **GLB app path**, not to the 2D renderer: `renderSchematic` / `renderPcb` use ecad-viewer's own canvas/WebGL painters and do not import three.js. That distinction reinforces the chosen split: reuse ecad-renderer for 2D, use plain three.js only for GLB.

The GLB path is app-only:

- `packages/ecad-viewer-app/src/ecad-viewer/tab_header.ts:27` recognizes `.glb`.
- `src/ecad-viewer/ecad_viewer.ts:703-713,888-906` loads GLB blobs, dispatches app events and dynamically imports `3d-viewer`.
- `src/3d-viewer/online_3d_viewer.ts:11-111` defines the `ecad-3d-viewer` custom element.
- `src/3d-viewer/viewer.ts:30-38` imports `three` and loaders including `GLTFLoader`, `KTX2Loader`, `DRACOLoader`, `MeshoptDecoder`, `EXRLoader` and `RoomEnvironment`; lines 44-49 build decoder URLs from `https://unpkg.com/three@<revision>.x`.
- `packages/ecad-viewer-app/static/three/three.module.js` is a vendored app asset; `three` is not a declared runtime dependency of the renderer package and is not resolvable from the ecad-viewer workspace root.

`@huaqiu/ecad-renderer` exports no GLB/three API. Its worker export is parser-oriented (`src/worker.ts:5-9`), and its rendering path is Canvas/WebGL for 2D PODs.

**Decision:** render GLB with a small plain three.js component inside `@huaqiu/dsh-hardware-ui`, using the DSH-pinned `three@^0.185.1` already declared by `packages/dsh-tool-pcb-viewer/package.json:38`. Keep all loader/decoder assets local; no CDN and no ecad-viewer app events. The host generates the GLB from the selected `.kicad_pcb` using `kicad-cli pcb export glb`, then serves it on the same loopback-guarded route surface.

### 2.6 Dependencies and browser constraints

| Concern | Finding | DSH handling |
|---|---|---|
| Parser runtime deps | None declared in `kicad-parser/package.json`; dev-only esbuild/TS/Jest. | Safe to bundle into the browser half. |
| Renderer runtime deps | `@huaqiu/kicad-sexpr-parser@^0.1.1`, `immutable@^5.0.0-beta.5`, `jszip@^3.10.1`. | Bundle with the existing tsdown client config; keep React/DSH platform externals. |
| DOM | Renderer calls `document.createElement`, appends canvases, uses ResizeObserver through the viewers. | Instantiate only in the client half after the tab mounts. |
| WebGL | 2D renderer has a WebGL path; GLB needs WebGL. | Accept explicit unavailable state in non-WebGL environments; POC scope is DSH Desktop. |
| Font | CJK stroke glyph table bundled in renderer, about 2 MB. | Acceptable offline cost; note in release size checks. |
| Node FS | None in parser/renderer library packages. | Host keeps all filesystem and process work. |
| License | MIT-style root license; notice must be retained. | Keep package notices in the bundled client artifact. |

### 2.7 Smallest DSH adapter

No new package is required. The smallest adapter is confined to the two existing POC packages:

1. **`@huaqiu/hardware-artifacts` (host)** — extend the existing `createHardwareHandler` surface in `src/routes.ts` with two loopback-guarded reads:
   - raw artifact text for a canonical, authorized `.kicad_sch` or `.kicad_pcb` path;
   - PCB GLB bytes derived from the selected `.kicad_pcb` via `kicad-cli pcb export glb`, cached by absolute path + size + mtime, with bounded failure states.
   Keep the existing `/projects`, `/installations`, `/environment` and `/open` routes. No project database is introduced; the cache is derived from native files.

2. **`@huaqiu/dsh-hardware-ui` (client)** — add two small modules beside `src/client/index.ts`:
   - `ecad.ts`: fetch raw text, `new SchematicParser().parse(...)` / `new BoardParser().parse(...)`, call `renderSchematic` / `renderPcb` with an owned canvas, and call `dispose()` when the artifact revision changes. Wrap parse/render failures in contextual `Error` objects because the libraries throw plain `Error`; use only the documented `RenderResult.dispose()`, never undocumented viewer internals; do not use the worker stub;
   - `glb.ts`: a plain three.js `GLTFLoader` view over the host GLB route, with explicit loading/error/unsupported states and resource disposal.

3. **Bundle wiring** — add `@huaqiu/kicad-sexpr-parser@^0.1.1`, `@huaqiu/ecad-renderer@^0.2.4` and `three@^0.185.1` to `dsh-hardware-ui`; force-bundle parser/renderer/three in `tsdown.config.ts`, matching the subpath-aware approach in `packages/dsh-tool-symbol-footprint/tsdown.config.ts:17-45`. The renderer is ESM-only with no CJS `require` condition, so the bundle must resolve its `import` entries; keep `react`, `react-dom` and `@deepseek-ai/*` external.

4. **Existing PCB viewer** — leave `@huaqiu/dsh-tool-pcb-viewer` intact for its tool, turn-tail card and standalone route. Do **not** re-host its panel or duplicate its renderer in the product tab. This removes the original "reuse the existing PCB viewer" requirement without breaking its regression gate.

The raw-text route and parser-in-client choice preserve the current product invariant: native files are authoritative; selection is exact and host-validated; the browser receives only the selected artifact.

---

## 3. Quote reference audit

### 3.1 KiCad reference implementation — a thin form-to-URL wrapper

The user's clarification is confirmed by the four source files: **KiCad is simply a wrapper on the backend API**. It does not price, validate or create the order itself. The workflow is exactly:

1. KiCad builds the PCB or SMT form from the currently open board.
2. KiCad POSTs the form (plus generated artifacts) to the backend.
3. The backend returns a URL.
4. KiCad launches that URL in an embedded webview (`DIALOG_WEBVIEW`); the same URL is valid in an external browser.

| File | Role | Source facts |
|---|---|---|
| `copilot/interface/settings/site_env.h` | Backend host and transport scheme | `kEDA_CN_HOST = "www.eda.cn"` with `kUseHttps = true` in normal builds; RC builds use `www.fdatasheets.com` with plain HTTP (lines 33-43). `SITE_ENV` carries `eda_cn_host`, `version`, `use_https` and `site_paths` (lines 46-53). |
| `copilot/interface/settings/site_paths.h` | Backend endpoint paths | `pcb_quote = "/openapi/api/hqpcb/External/fileQuote"` and `smt_quote = "/openapi/pcba/saveDfmTmpOrder"` (lines 41-42). A request URL is `<scheme>://<host><path>`. |
| `copilot/assistant/quote/quote_controller.cpp` | HTTP client construction only | `QUOTE_CONTROLLER()` at lines 32-34 creates `httplib::SSLClient(host, 443)` or `httplib::Client(host)` from `get_edn_cn_host()`. There is no other logic in the file. |
| `pcbnew/fab/place_order_for_pcb.h` | PCB form submit and final URL | `PlaceOrderForPCB()` at lines 49-77 zips the board, builds `PCB_FORM`, calls `pcb_quote(form, zip)`, then formats `https://www.hqpcb.com/mycenter/orders/pcb/quote?type=PCB&id=...&guid=...&tid=354&token=...` from the backend response. |

The resolved backend endpoints are therefore `https://www.eda.cn/openapi/api/hqpcb/External/fileQuote` for PCB and `https://www.eda.cn/openapi/pcba/saveDfmTmpOrder` for SMT. **Correction to an earlier draft:** the paths `https://edn.cn/api/eda/advanced/quote/upload` and `/api/eda/advanced/quote/upload_smt` recorded previously do not exist anywhere in this source tree and are withdrawn. `get_edn_cn_host()` is a historical function name; its value is `SITE_ENV.eda_cn_host` (`copilot/assistant/settings/site_env_mgr.cpp:45-48`), overridable by the `SITE_ENV` JSON loaded in `copilot/assistant/settings/webview_settings_manager.cpp`; path getters are at `site_env_mgr.cpp:76-84` and `use_https()` at lines 97-100. DSH must not copy these constants.

The two submit methods perform only this wrapper work:

- `copilot/assistant/quote/pcb_quote.cpp:37-108` serializes `PCB_FORM` to multipart text fields, optionally attaches a `.zip` as `application/zip`, POSTs to `get_pcb_quote_path()`, and on HTTP 200 reads the backend's `url` or `redirect` field and extracts `id`/`guid` from it. No authorization header is added.
- `copilot/assistant/quote/smt_quote.cpp:59-93` adds an `authorization` header from `get_access_token().token`, attaches `pcbFile`, `coordFile` and `bomFile`, sends `reqParseVO` as JSON, POSTs to `get_smt_quote_path()`, and returns `result.url` from `PCB_SMT_QUOTE_RESPONSE`.
- `pcbnew/fab/place_order_for_smt.h:120-168` builds the PCB/SMT forms and BOM/position CSVs, then appends `token` and `source=bom` to the backend-returned URL.
- `pcbnew/fab/place_order_wrapper.h:50-117` validates login, runs `PlaceOrderForPCB()`/`PlaceOrderForSMT()` on the thread pool, and calls `LaunchPlaceOrderUrl(*res)`. `include/fab_info_getter.h` implements that by creating a `DIALOG_WEBVIEW` titled "Place Order"/"HQ_PCB", calling `LoadUrl(aUrl)` and `ShowModal()` — the returned URL is launched in a webview and is equally usable from a browser.

This is the **place-order/URL flow**. It is distinct from the real-time **price-query flow** (`quote_pcb` / `quote_smt` below): both are wrappers over a backend API, but the C++ methods described here submit a form and return a URL, while DSH's price tools call hq-edge and return normalized price JSON. Do not merge the two.

Form and response contracts live outside these files:

- `copilot/interface/quote/quote_controller.h:34-54` declares `PCB_SMT_QUOTE_FILE_PATHS` and the two quote methods.
- `copilot/interface/quote/pcb_form.h:29-81` defines `PCB_FORM` with fabrication fields such as `blayer`, `blength`, `bwidth`, `bcount`, `board_tg`, `bheight`, `lineweight`, `vias`, `color`, `cover`, `spray`, `insidecopper` and many provider-specific defaults. `copilot/interface/quote/smt_form.h:30-82` defines `SMT_FORM`.
- `copilot/interface/quote/pcb_smt_form.h:29-35` composes `PCB_FORM` and `SMT_FORM`; `pcb_quote_response.h:25-36` and `pcb_smt_quote_response.h:31-41` define the two URL/ID response shapes.
- `copilot/interface/settings/webview_settings_manager.h:64-114` documents that access tokens are owned by `auth::AUTH_STORE`, not by the settings manager, and exposes host/quote path getters.

There are **two distinct backend surfaces**, and they must not be conflated:

- The place-order HTTP backend at the `SITE_PATHS` endpoints above. It accepts the PCB/SMT form upload and returns the URL that KiCad opens in `DIALOG_WEBVIEW`. This is the backend the user's workflow description refers to, and it is external to this repository.
- The DSH-facing service contract `hq.fab.v1.QuoteService` in `hq/proto/hq/fab/v1/quote.proto:421-438`, declared in `hq/runtime/include/hq_quote_service.h:18-41` and implemented in `hq/runtime/src/hq_quote_service.cpp:33-54`: `QuotePcb`, `QuoteSmt`, `PlacePcbOrder`, `PlaceSmtOrder`. The `Place*` RPCs are a pure trigger: the EDA host performs the form upload to the first backend and opens the returned URL in its own dialog (`quote.proto:385-415`). The KiCad `QUOTE_CONTROLLER` is the editor-side implementation of that upload step, not a service DSH should reimplement.

The callers confirm that these are **place-order workflows**, not a standalone pricing UI:

- `pcbnew/fab/place_order_for_pcb.h:47-76` zips the current board, calls `pcb_quote()`, and appends `id`, `guid`, `tid=354` and `token` to an hqpcb.com order URL.
- `pcbnew/fab/place_order_for_smt.h:126-172` derives board data, writes UTF-8 BOM and position CSVs, calls `smt_quote()`, and appends `token` and `source=bom` to the returned URL.
- The actions are registered in `common/fab/fab_action.cpp:42-56` and declared as `ACTIONS::placeOrderForPCB` / `ACTIONS::placeOrderForSMT` (`include/tool/actions.h:318-319`). The quote sources are built explicitly in `copilot/assistant/CMakeLists.txt:25-27`.

**Reference conclusion:** the C++ code owns request assembly and file packaging for the KiCad desktop editor. It does not define a service that DSH should reimplement, and it is not an agent-facing capability. Its provider fields, token handling and URL construction are host/application concerns.

### 3.2 Existing DSH implementation

`@huaqiu/dsh-tool-quote@0.7.11` is already the DSH adapter:

| Concern | DSH fact | Evidence |
|---|---|---|
| Registered tools | `quote_pcb`, `quote_smt`, `place_pcb_order`, `place_smt_order` | `packages/dsh-tool-quote/src/tools.ts` |
| Architecture | Thin adapter only; no provider logic, no form serialization, no provider URL parsing | `src/index.ts:1-26`, `src/client.ts:1-11` |
| Backend contract | Explicitly mirrors `hq.fab.v1.QuoteService`; the plugin is a thin transport, not a second implementation | `src/config.ts:1-14`, `src/tools.ts:1-20`; `hq/runtime/src/hq_quote_service.cpp:33-54` |
| Backend route | `POST <base>/api/v1/quote/{pcb,smt}` and `POST <base>/api/v1/quote/place/{pcb,smt}`, mapping one-to-one to the four RPCs | `src/config.ts:54-71`; `test/quote-tools.test.ts` route assertions |
| Base URL | overlay `hqEdgeBaseUrl` → `HUAQIU_QUOTE_BASE_URL` → `HQ_EDGE_BASE_URL`; optional late-bound `ctx.get('hqEdge')` | `src/config.ts:28-49`, `src/index.ts:83-104` |
| Activation | `inject = ['tools']`; a missing backend does not remove tools | `src/index.ts:71` |
| Offline failure | `QuoteToolError` with `FAILED_PRECONDITION` / status 412 and no fetch | `src/client.ts:69-78`; `test/quote-tools.test.ts` case "throws FAILED_PRECONDITION without a base URL" |
| Error mapping | stable hq-edge envelope → semantic kinds; `EDA_HOST_NOT_READY` normalized to `FAILED_PRECONDITION` for place orders | `src/client.ts:42-50,120-136` |
| Quote vs place | quote tools return normalized price JSON; place tools trigger the EDA host's place-order workflow and return `{ orderUrl, status, message }` | `src/tools.ts` tool descriptions and execute bodies |
| Auth | token/login remains in the backend or EDA host; the plugin never handles a token | `src/index.ts:1-26`, `src/client.ts` |

### 3.3 Reuse map

| KiCad reference concept | Existing DSH capability | Status |
|---|---|---|
| `get_edn_cn_host()` + HTTP/HTTPS client | `resolveQuoteToolConfig()` + `createQuoteToolClient()` | **Already covered.** Host-neutral name is `HUAQIU_QUOTE_BASE_URL`; HQ Edge compatibility retained. |
| `hq.fab.v1.QuoteService` four RPCs | explicit hq-edge router routes used by the four DSH tools | **Already covered.** One contract, one transport adapter; do not add a second service implementation. |
| `PCB_FORM` fabrication fields | `quote_pcb` parameters + hq-edge form derivation | **Already covered.** Tool exposes price-relevant overrides; hq-edge owns canonical form and menu snapping. |
| ZIP attachment from current board | hq-edge → EDA host place-order workflow via `place_pcb_order` | **Do not copy.** DSH does not create multipart order packages in the product UI. |
| C++ `pcb_quote()` submit returning `id`/`guid` from the backend URL | `place_pcb_order` returning `{ orderUrl, status, message }` | **Different contract by design.** The C++ method is a place-order form submit, not a price query; do not parse its URL in DSH. Price queries use `quote_pcb` → normalized JSON from `POST /api/v1/quote/pcb`. |
| SMT `pcbFile`/`coordFile`/`bomFile` and `reqParseVO` | `quote_smt` + `place_smt_order` through hq-edge | **Already covered.** BOM/positions preparation belongs to the backend/host. |
| `authorization` header from `AUTH_STORE` | backend/host-owned login | **Do not copy.** The DSH plugin must not receive or forward a raw access token. |
| Backend-returned order URL launched in KiCad's `DIALOG_WEBVIEW` | `place_pcb_order` / `place_smt_order` return `orderUrl`; hq-edge → EDA host opens its place-order dialog | **Already the DSH boundary.** The URL belongs to the backend/host. The product UI may surface `orderUrl` as a link, but must not build the URL, add `tid`/`token`/`source` or reconstruct KiCad's webview. |
| Quote → review → place boundary | four separate tools with explicit descriptions | **Already covered.** The UI must not merge quote and submit into one action. |

### 3.4 Order UI decision

The Order destination in `@huaqiu/dsh-hardware-ui` should remain an entry-point surface. It carries the selected PCB path and selected schematic/BOM context, then surfaces the existing four tool names. It must not implement pricing, multipart upload, auth, token URLs, or a second order state machine.

The corrected wrapper model makes one UI rule explicit: the backend owns the returned order URL and the host owns its launch. KiCad builds a form, POSTs it and opens the returned URL in `DIALOG_WEBVIEW`; DSH's `place_pcb_order` / `place_smt_order` already delegate the same work to the EDA host through hq-edge and return `orderUrl`. The Order tab may display that URL as a link for webview/browser launch, but it must never construct or sign it.

One honesty constraint remains: `quote_pcb` / `quote_smt` obtain board-derived facts from the open EDA host and otherwise use reference defaults, with explicit overrides available as tool parameters. If the selected artifact is not open in an editor, the smallest in-scope improvement is a thin resolver in `hardware-artifacts` that derives board size/layer facts from the selected `.kicad_pcb` and supplies existing `quote_pcb` parameters. That is context preparation inside the one host capability, not a new pricing backend. SMT BOM detail is not exposed by the current tool schema; keep that with the existing backend/host rather than inventing a new field.

The current `FAILED_PRECONDITION` warning in the implementation report is correct behavior for an unconfigured backend; it is not evidence that a backend must be built for this POC. Acceptance should assert that tools are registered and fail with that semantic kind offline, and that a configured `HUAQIU_QUOTE_BASE_URL` is the only requirement for live pricing.

No DSH shell change is needed for quote/order.

---

## 4. Revised implementation specification

### 4.1 Architecture invariants

- One product UI plugin: `@huaqiu/dsh-hardware-ui`.
- One host capability: `@huaqiu/hardware-artifacts`.
- Bundle entry point: `@huaqiu/hardware-engineering`; no new bundle row beyond the two already added.
- No DSH shell modification, Electron change, HQ Edge dependency, daemon, Python runtime, project database or embedded native editor.
- One 2D rendering foundation: parser PODs + `@huaqiu/ecad-renderer`.
- One GLB path: host `kicad-cli pcb export glb` + small pinned three.js viewer.
- Native files remain authoritative; the store holds only selection and tab revision.

### 4.2 Package-level change plan

| Package | Change | Extension point / boundary |
|---|---|---|
| `@huaqiu/hardware-artifacts` | Add authorized raw-file content route and bounded PCB→GLB export route; extend artifact metadata with source path and revision where needed. Existing `webServer` prefix handler in `src/routes.ts`. | Host only; loopback guard and workspace boundary already present. |
| `@huaqiu/dsh-hardware-ui` | Add `ecad.ts`, `glb.ts`, a canvas host in `HardwareViewerBody`, and dependencies on parser/renderer/three. Remove DFM and SolidCraft launch selectors. | Existing `sidebar.right.pane.tab`, `conversation.header.leading`, `settings.section` slots; one declared store. |
| `@huaqiu/dsh-tool-pcb-viewer` | No change. Keep tool, turn-tail and standalone viewer behavior. | Regression only. |
| `@huaqiu/dsh-tool-quote` | No change. | Order surface calls existing tool names. |
| `@huaqiu/hardware-engineering` | No new row; keep existing ledger/tests accurate if the dependency set changes. | Bundle activation gate. |
| `release-manifest/plugins-release-manifest.json` | No new entry; update only if a package version changes. | Release gate. |

### 4.3 Implementation sequence

1. Add the host raw-content and GLB routes to `hardware-artifacts`, including canonical path validation, loopback/origin checks, size bounds, GLB cache key and explicit error codes.
2. Add the client ecad adapter: parse selected `.kicad_sch` / `.kicad_pcb` text and render into an owned canvas; dispose the previous viewer on project, artifact or tab-revision change.
3. Add the thin three.js GLB view for PCB 3D; the selected board is the single source of the GLB.
4. Remove the DFM destination and all STEP/STP/mechanical selectors; keep six→five destinations: Schematic, PCB, BOM, 3D CAD, Order.
5. Keep SolidCraft only as a setting and agent-context field; remove native-launch actions and launch validation for it.
6. Wire Order actions to `quote_pcb`, `quote_smt`, `place_pcb_order`, `place_smt_order`; preserve the quote-versus-submit boundary.
7. Run package tests, bundle contract, release gates and the real offline activation fixture; refresh the POC report with evidence.

### 4.4 Revised acceptance gates

**Keep and prove**

- One canonical project resolves without manual configuration; multiple projects require explicit selection.
- Multiple boards are selectable; a hierarchical sheet keeps its root schematic identity.
- Artifact identity uses canonical absolute path, not basename; BOM and PCB 3D retain source identity.
- Schematic and PCB render inside the existing right-panel tab using parser PODs and ecad-renderer.
- Switching artifact, project or tab revision disposes the previous viewer and shows no stale canvas.
- PCB 3D shows a GLB generated from the selected `.kicad_pcb` through `kicad-cli`.
- Loading, unsupported, unconfigured and failed states are explicit.
- KiCad path can be configured and validated; Open in KiCad launches the exact selected schematic or PCB without a shell.
- The agent receives validated KiCad/SolidCraft installation facts through compact context and scoped child env names; no global `process.env` mutation.
- Product bundle activates offline with no HQ Edge; existing PCB viewer, schematic analysis and quote/order tools remain functional.

**Remove from POC gates**

- DFM viewer, DFM score, and DFM native action.
- STEP/STP import, conversion and mechanical-model selection.
- SolidCraft native launch, file-opening arguments and GUI handoff.
- Re-hosting `@huaqiu/dsh-tool-pcb-viewer` or adding a second PCB renderer.
- Building a DSH quote backend, provider form serializer, token forwarder or multipart uploader.
- Requiring a configured live quote backend for offline acceptance.

**External validation, not a coding blocker**

- User-side Windows KiCad GUI handoff test.
- npm publication of the new 0.7.11 artifacts and synchronized manifest/CLI cut.
- Live quote with a configured `HUAQIU_QUOTE_BASE_URL`.

### 4.5 Test matrix

| ID | Test | Expected result |
|---|---|---|
| T1 | Parse a real `.kicad_sch` in the client and render with `renderSchematic`. | Canvas mounted; `dispose()` releases it; no network fetch. |
| T2 | Parse a real `.kicad_pcb` and render with `renderPcb`. | Canvas mounted; selected board path is shown. |
| T3 | Switch boards or sheets without remounting the tab. | Previous viewer disposed; new canvas corresponds to the new canonical path. |
| T4 | Request GLB for a selected board. | Host invokes `kicad-cli pcb export glb`; cached bytes render in three.js; unsupported/CLI-missing state is explicit. |
| T5 | Select multiple projects/boards. | Host returns `selection-required` or deterministic selection; no arbitrary first match. |
| T6 | Open in KiCad from each 2D artifact. | Host validates exact path and launches with explicit argv and `shell: false`. |
| T7 | Open Settings → Hardware Engineering. | KiCad and SolidCraft paths persist; installation state is reported; no launch action is offered for SolidCraft. |
| T8 | Ask the agent which installations are configured. | Answer matches the compact host context and scoped environment names. |
| T9 | Exercise Order destination offline. | Four existing tools are registered; quote returns `FAILED_PRECONDITION` without a backend. |
| T10 | Exercise Order with a mocked hq-edge base URL. | Correct `/api/v1/quote/{pcb,smt}` or `/place/{kind}` route and payload; no token in DSH payload. |
| T11 | Run the offline desktop activation fixture. | 11/11 product rows active; no HQ Edge; no network escape. |
| T12 | Run release-version, publish and script gates at 0.7.11. | All pass with unchanged catalog semantics. |

---

## 5. Risks and explicit non-goals

- The renderer's bundled CJK glyph table adds about 2 MB to the client bundle; this is an offline trade-off, not a blocker.
- WebGL availability must be checked at runtime; headless CI can validate API contracts but not pixel output.
- GLB quality and flags depend on the installed `kicad-cli` version; broken or unsupported exports must surface as explicit states.
- ecad-viewer's parser PODs expose hierarchy fields but do not replace host-side root-sheet resolution or project-owned board ranking from the Backplane study.
- ecad-viewer's app BOM visitors are not public renderer APIs; BOM remains a semantic view derived from the selected schematic and existing analysis, not from rendered pixels.
- No embedded KiCad/SolidCraft window, unsaved-state sync, DFM, STEP/STP, new quote backend, new project DB or parallel rendering framework is part of this POC.

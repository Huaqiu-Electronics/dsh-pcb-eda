# DSH MDI ECAD Document Rendering — Source Audit Report

**Date:** 2026-11-25  
**Type:** Source audit and integration feasibility (research only)  
**Governing specification:** [`docs/tasks/dsh-mdi-ecad-document-rendering-source-audit.md`](../tasks/dsh-mdi-ecad-document-rendering-source-audit.md)  
**Result:** ECAD renderers can be delivered through the existing document-preview extension point. No DSH shell change is required. Schematic and PCB previews are fully source-proven; 3D is split — `.glb` works today with in-tree code, standalone `.step`/`.stp` is feasible through a vendored wasm converter pending an LGPL review (§6).

---

## 1. Method and baselines

### 1.1 Repositories inspected

| Repository | Path | HEAD | Working tree |
|---|---|---|---|
| DSH | `/Users/admin/code/deepseek-harness` | `5d830fc6f3e68ace0d7170dad5c115416f8624c7` (2026-11-19) | clean |
| Huaqiu DSH plugins | `/Users/admin/code/dsh-pcb-eda` | `159b106510543543dc39e5526b3581fa3db581b4` (2026-11-25) | clean |
| ECAD viewer | `/Users/admin/code/ecad-viewer` | `c37404bcd756ce67712981a715d904b1efc9f69e` (2026-11-09) | clean |
| KiCad (installed application) | `/Applications/KiCad/KiCad.app` | KiCad 10 CLI present | n/a |

Both source trees were confirmed clean before reading, so every line reference below is a committed line. No file in either repository was modified by this audit.

### 1.2 Correction to the specification's assumptions

Two assumptions in the task document are stale and are corrected here:

| Spec statement | Actual |
|---|---|
| `@huaqiu/ecad-renderer` `0.2.4` | `0.2.6` is what ships (`packages/dsh-hardware-ui/package.json:39` pins `0.2.6`; `packages/component-gen-app/package.json:33` and `packages/dsh-tool-symbol-footprint/package.json:51` use `^0.2.6`) |
| `@huaqiu/kicad-sexpr-parser` `0.1.1` | `0.1.3` (`packages/dsh-hardware-ui/package.json:40` dev-dep `0.1.3`; the lockfile still carries `0.1.1` and `0.1.2` for older consumers) |
| "The right-panel modifications … have already been reverted" | Confirmed: the harness tree is clean at `5d830fc6`, `persistence.ts:7` is `dsh.sidebar-right.v1`, and no `PanelToggleButton`/product viewer tab exists in the shell |

The audit therefore starts from a stock DSH shell, which is the correct baseline for the document-centric direction.

---

## 2. D1 — Executive conclusion

**Can ECAD renderers integrate into the existing DSH document MDI without modifying the shell? Yes.**

DSH already separates two layers, and the extension point lives in the second one:

1. **Tab-type layer** (`ctx.sidebarRightTabs`): one type, `kind: 'text'`, claims *every* session file address (`dsh-resource://file/[\s\S]+`) at the `fallback` band (`ui-sidebar-documentpreview/src/client/definition.ts:45-55`).
2. **Document-body layer** (`ctx.documentPreviews` + the keyed `sidebar.right.tab.document` slot): an extension-ordered list of renderer implementations. The body host picks the best match for the current filename (`TextPreview.tsx:81-88`) and mounts that implementation's component under its `id`.

Consequences that decide the whole design:

- A `.kicad_sch`, `.kicad_pcb` or `.step` file needs **no new tab type**, no new address scheme, no new opening service, and no project selection. It needs one `documentPreviews.register({...})` plus one keyed slot registration.
- Both opening paths (explorer click and agent-response file link) already converge on `ISidebarRight.openResource` → `placeResource` → `tabs.claim` → store `openContent`, so ECAD documents inherit tab reuse, titles, restore, refresh and deletion behavior for free.
- An external registration defaults to the `extension` band, which **outranks** the builtin renderers for the same suffix length (`document/registry.ts:48-52`). Claiming `kicad_sch`/`kicad_pcb`/`step` therefore replaces today's plain-text fallback without touching code renderer behavior for any other suffix.

**Exact extension point required**

```ts
ctx.documentPreviews.register({
  id, extensions, binaryExtensions?, priority?, title, loading, wrap?, sourceLines?,
})                                   // document/registry.ts:99
ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
  { name: 'sidebar.right.tab.document', key: id, locale }, Body),
)                                   // per renderer, e.g. image/index.ts:49-55
```

This is the documented public contract (`ui-sidebar-documentpreview/README.md:37`, `docs/subsystems/sidebar-right.md:118-120`).

**Smallest implementation**

One renderer plugin (recommended: the existing `@huaqiu/dsh-hardware-ui` package, reshaped) that registers three document bodies — `.kicad_sch`, `.kicad_pcb`, and `.glb` — each a thin `bytes → parse → mount → dispose` adapter over the in-tree renderer/viewer code. STEP becomes a fourth registration only if the licence review in §6 passes. Estimated new code: three small bodies, one shared mount/dispose helper, one locale file, and tests. No DSH change, no new tab system.

**Blockers**

| # | Blocker | Severity | Resolution |
|---|---|---|---|
| B1 | No STEP converter ships with the product. A working wasm converter (`occt-import-js` 0.0.21, 8.8 MB, LGPL-2.1) is vendored in an adjacent local project and already wired to three.js, so standalone STEP preview is feasible — but only after a licence review | High for 3D only | Phase 1 ships `.glb`; STEP graphical preview follows the licence decision, see §6 |
| B2 | Bodies of the `text` tab type are **not** kept alive when a tab is hidden (`keepMounted` unset → dockkit unmounts, `tab-registry.ts:108`), so an ECAD canvas is destroyed and rebuilt on every tab switch | Medium | Accept for the first cut; parsing is local and fast. A `keepMounted` product tab type is explicitly *not* recommended (it would fragment identity) |
| B3 | `@huaqiu/ecad-renderer` ships ~3.2 MB per entry and declares no `license` field | Medium | Lazy `import()` chunk (the established `LazyPdfBody` pattern); add `license` metadata upstream |
| B4 | Host whole-file read cap is 32 MiB (`api/workspace-files/src/index.ts:188`), page cap 2 MiB | Low | ECAD sources are normally far smaller; over-cap files surface the existing `too-large` state |

Nothing in this list requires a shell change.

---

## 3. D2 — DSH MDI source map

### 3.1 Two layers, one identity

```
dsh-resource://file/session/<sessionId>/<path>          ← the address IS the content identity
        │
        ├── sidebarRightTabs.claim(address)             tab-registry.ts:379
        │      → kind 'text' (only claimant for file addresses)
        │      → contentId = address                    tab-registry.ts:142-154
        │
        └── keyed seat sidebar.right.pane.tab['text']  → TextPreview   index.ts:104-119
                 └── matchingDocumentPreviews(defs, path)              registry.ts:41-54
                        → selected.id → keyed seat
                          sidebar.right.tab.document[selected.id]      TextPreview.tsx:391-397
```

### 3.2 File-explorer opening path

| Step | Source |
|---|---|
| Row click | `ui-sidebar-files/src/client/FileTree.tsx:215-231` |
| Address built from session + root + entry path | `ui-sidebar-files/src/client/FileNavigator.tsx:121-133`; `util/workspace-path/src/index.ts:92` `fileAddressFor` |
| Open call | `ui-sidebar-files/src/client/FilesBody.tsx:44-47`, `documentpreview/src/client/PreviewFrame.tsx:26-29` (`tab.actions.openResource`) |
| Tab-local action → controller | `ui-sidebar-right/src/client/tab-domain.ts:198-202` → `service.ts:403-406` `openResourceIn` |
| Claim (type choice) | `service.ts:452` → `tab-registry.ts:379-395` `claim` |
| Create/select/reuse | `stores.ts:367-436` `openContent`; reuse test `ui-dockkit/src/engine/planner.ts:71-77` `findPaneContentTab` |

### 3.3 Agent-response opening path

| Step | Source |
|---|---|
| Inline code mention | `ui-primitives/src/markdown/render.tsx:343-372` (`context.fileMentions?.resolve` → `mention.open`) |
| Markdown file link | `ui-primitives/src/markdown/render.tsx:617-660` (`MarkdownFileLink`, `openFile(path, {line})`) |
| Mention provider | `ui-deliverables/src/client/turn-deliverables.ts:281-301`; registered `ui-deliverables/src/client/index.ts:106-117` |
| Chat opener | `ui-chat/src/client/chat/ChatView.tsx:246-251`, `:254` |
| Final hop | `ui-chat/src/client/apply.ts:272-279` → `ctx.sidebarRight.openResource(url, {params:{line}})` |
| Tool-row file paths | `ui-tool/src/client/tool/components/ToolRow.tsx:235`, `:281-286` |

**The two paths converge.** Both terminate in `SidebarRightController.placeResource` (`service.ts:443-455`) and then the same store action `openContent` (`stores.ts:367`). `openFile` in `apply.ts` is the single chat-side funnel; the explorer funnels through `tab.actions.openResource`. There is no second document-opening service.

### 3.4 Document identity and tab semantics

| Question | Answer | Evidence |
|---|---|---|
| Identity | The full `dsh-resource://file/session/<sessionId>/<path>` address; session-scoped, so one path under two sessions is two documents | `tab-registry.ts:142-154`, `:388`, `:394` |
| Tab record | `{ id: TabId, kind, contentId, title }`; `TabId` minted per surface | `stores.ts:76-79`, `:156-166` |
| Dedupe / reuse | `findPaneContentTab(layout, contentId, kind)` then reveal; `revealIfOpened: false` opts out and allows a second tab of the same file | `ui-dockkit/.../planner.ts:71-92`, `stores.ts:388-392`, `service.ts:466-470` |
| Concurrent documents | Yes, one record per tab; preview view state is keyed by **tab id**, not path, so two tabs of one file scroll independently | `documentpreview/src/client/store.ts:6-14`, `:66-69` |
| Titles | `definition.title(address)` = decoded basename at claim time; the chip is a keyed slot (`sidebar.right.pane.tab.title`) with the record title as fallback | `definition.ts:21-39`, `:53`; `SidebarRight.tsx:249-251`, `:221` |
| Switching | Hidden bodies unmount unless `keepMounted`; the docked host slides off-edge instead of unmounting when the panel collapses | `ui-dockkit/src/components/TabLayout.tsx:103`, `SidebarRight.module.css:55`, `:62-64` |
| Refresh | Manual reload via the tab command `refresh`; automatic on watch-driven version change while `autoRefresh` is on | `TextPreview.tsx:188-201`, `:192-198` |
| File modification | `file` provider streams `stat` frames; preview compares `observedVersion` and restarts the read generation | `api/workspace-files/src/client/provider.ts:85-106`, `TextPreview.tsx:188-201` |
| Deleted / inaccessible | `useResource` status `none` → unavailable state; read failure → typed recourse row | `TextPreview.tsx:75-76`, `:248-250`, `:418-435` |
| Workspace change | Explorer re-roots at the session `cwd`; addresses are session-scope and workspace-relative, re-resolved host-side | `FileNavigator.tsx:78`, `:102`; `provider.ts:119-128` |
| Open without an agent turn | `ctx.sidebarRight.openResource(address, options)` (public `ISidebarRight`), or `openResourceIn(sessionId, …)` from a tab body | `service.ts:243`, `:403`; tab face `contract/slots.ts:170-173` |

### 3.5 Renderer dispatch

Dispatch is **extension-based, registry-driven, and dynamic**:

1. `DocumentPreviewRegistry` holds `DocumentPreviewDefinition` records keyed by `id` (`document/registry.ts:71-133`).
2. Ranking (`registry.ts:41-54`): priority band first (`extension` = 1 beats `builtin` = 0), then longest matching suffix, then registration order.
3. `TextPreview` builds the candidate list for the current file, appends the plain-text fallback (id `…/text`, `extensions: []` so it never matches by suffix) unless a declared binary suffix matched, and selects `state.rendererId` or `candidates[0]` (`TextPreview.tsx:81-88`; `text/index.ts:15-17`).
4. The selected `id` keys the `sidebar.right.tab.document` slot, whose owner props carry `content`, `resourceAddress`, `wrap`, `scrollportRef`, `addResource`, `setResources` (`document/contract.ts:33-46`, `:51-61`).
5. The same candidate list drives the toolbar renderer menu, so every matching implementation stays user-selectable (`TextPreview.tsx:300-316`).
6. Rename/collision: two definitions with the same `id` throw; a definition may declare `binaryExtensions` only inside its own `extensions` (`registry.ts:99-108`).

### 3.6 Lifecycle contract for a renderer body

| Concern | Mechanism |
|---|---|
| Content delivery | `loading: 'bytes-complete'` → `{kind:'bytes', data: Uint8Array}`; `'text-pages'` → paged text; `'renderer'` → body loads its own content and reports through `revision`/`loaded`/`failed`/`reload` (`contract.ts:17-30`) |
| Stale async results | In renderer mode the store ignores `rendered`/`rendererFailed` whose `revision` is no longer current (`store.ts:157-166`) |
| Cancellation | `tab.navigation.signal` (AbortSignal) is available to the body; abort on unmount is the body's responsibility |
| Mount container | The body renders into the pane's content row and owns its inset; an inner scrollport may be registered through `scrollportRef` (`contract.ts:44-45`) |
| Hide/show | Body unmounts on hide (no `keepMounted`), so dispose must be idempotent and remount must be cheap |
| Plugin unload | Every registration is owned by `ctx.effect`, so disposal is automatic (`image/index.ts:43-55`, `index.ts:104-131`) |
| Tab close | `retainDocumentTabs` releases tab-keyed state on the tab's abort signal (`document/tab-lifetime.ts:10-24`) |

### 3.7 What a renderer does *not* get

- No `keepMounted` control: that is a property of the **tab type**, which ECAD does not own.
- No way to add a header control from the renderer definition; header contributions go through the list slots `sidebar.right.tab.document.actions` / `.unpreviewable`, whose owner prop is `absolutePath` (`contract.ts:66-85`).
- No host-side parsing service: parsing happens in the browser unless the plugin adds its own Host route.

---

## 4. D3 — Existing renderer inventory

Dispatch is **not** hardcoded in the MDI component. The registry is created and provided as a service (`ui-sidebar-documentpreview/src/client/index.ts:91-93`), the pane reads its snapshot (`TextPreview.tsx:78`), and the selected id keys the body slot (`TextPreview.tsx:391-397`). Every renderer below — including the builtins — goes through the same two calls a third party would use, which is the strongest available proof that the extension point is real rather than incidental.

| Renderer | Implementation | Dispatch (id / suffixes) | Content loading | Container / layout | MDI integration | Lifecycle | Plugin boundary |
|---|---|---|---|---|---|---|---|
| Plain text (fallback) | `text/TextBody.tsx` | `…/text`, `extensions: []` — matches nothing, appended as the implicit fallback (`text/index.ts:15-17`, `TextPreview.tsx:85-86`) | `text-pages` via `rpc.ts` (2 MiB page cap) | Fills the pane, owns the scrollport | Body of tab type `text` | Store survives tab switches; scroll restored | Public — registered like any other |
| Code | `code/CodeBody.tsx` | `…/code`, `CODE_HIGHLIGHT_EXTENSIONS` (`code/index.ts:15-23`) | `text-pages` | Same body, gutter + lazy grammar | Same tab type | Same | Public |
| Markdown | `markdown/MarkdownBody.tsx` | `…/markdown`, `md markdown mdx` | `text-pages` | Reading column; frontmatter in a lazy chunk | Same | Same + path-image resource group | Public |
| HTML | `html/HtmlBody.tsx` | `…/html`, `html htm` | `bytes-complete` | Sandboxed frame, full pane bleed | Same | Frame torn down on unmount | Public |
| Image | `image/ImageBody.tsx` | `…/image`, `png jpg jpeg gif webp bmp ico svg`, 7 declared binary (`image/index.ts:27-37`) | `bytes-complete` | Centred, pan/zoom store | Same | `retainDocumentTabs` frees tab state on close | Public |
| PDF | `pdf/LazyPdfBody.tsx` → `pdf.tsx` | `…/pdf`, `pdf` binary (`pdf/index.ts:22-23`) | `bytes-complete` | Lazy chunk, pdfjs in a worker, zoom viewport | Same | Worker + document destroyed on unmount | Public |
| Office | `office/OfficeBody.tsx` | `…/office`, Word/PowerPoint suffixes | `bytes-complete` → Host PDF conversion | Reuses the PDF body | Same | Conversion cache bounded by `config.office` | Public |
| Excel | `excel/LazyExcelBody.tsx` | `…/excel`, spreadsheet + `csv tsv` | `bytes-complete`, 16 MiB cap | Lazy chunk, FortuneSheet in a worker | Same | Worker timeout + teardown | Public |

Cross-cutting facts that matter for ECAD:

- **Lazy chunking is the established pattern** for heavy renderers: `React.lazy(() => import('./pdf.tsx'))` behind `Suspense` + `LoadingIndicator` (`pdf/LazyPdfBody.tsx:1-19`, `excel/LazyExcelBody.tsx:16`), emitted as `lib/client.pdf.js` / `client.excel.js`. A 3.2 MB ECAD renderer must follow it.
- **Binary declaration changes behavior**: a suffix in `binaryExtensions` removes the plain-text option, and when nothing else matches the preview shows the unsupported state from `document/unviewable.ts:10-28` instead of issuing a read.
- `.kicad_sch`, `.kicad_pcb`, `.step`, `.stp` appear **nowhere** in the preview package or its unviewable list — they currently open in the plain-text reader. That is exactly the behavior a new registration replaces, and it means no existing renderer is shadowed.

## 5. D4 — ECAD rendering feasibility

### 5.1 Package facts

| Fact | Value | Evidence |
|---|---|---|
| Parser version | `0.1.3` | `@huaqiu/kicad-sexpr-parser/package.json` (pnpm store) |
| Parser license | MIT | same file |
| Parser bundle | `dist/index.mjs` 100 KB, ESM + CJS, zero runtime deps, no Node builtins (`grep` for `require(`/`node:`/`process.` → none) | dist inspection |
| Renderer version | `0.2.6` | `@huaqiu/ecad-renderer/package.json` |
| Renderer license | **absent** from `package.json`; upstream `ecad-viewer/LICENSE.md` is MIT-style (© 2024 深圳华秋电子有限公司) | package + license file |
| Renderer size | `index.js` 3.47 MB, `schematic.js` 3.21 MB, `pcb.js` 3.30 MB, `project.js` 213 KB (each entry inlines the shared viewer) | `du`/`ls` |
| Renderer deps | `@huaqiu/kicad-sexpr-parser`, `immutable`, `jszip` — all inlined; bundle contains no remote URL or CDN fetch | dist inspection |
| Rendering stack | Canvas + WebGL viewers (`SchematicViewer`, `BoardViewer`) | `dist/index.js` (`renderSchematic` body) |
| CJK glyphs | Bundled stroke-glyph table in JS: "rendering has no font CDN or network dependency" | renderer `README.md` |
| Project / IPC / kipy | not referenced anywhere in either package | package + bundle inspection |

### 5.2 Exact APIs

```ts
// @huaqiu/kicad-sexpr-parser
class SchematicParser {
  parse(text: string): schematicProto.I_KicadSch
  parseLibSymbols(text: string): schematicProto.I_LibSymbol[]
  save(schematic: schematicProto.I_KicadSch): string
}
class BoardParser { parse(text: string): boardProto.I_KicadPCB }
export { parseLibSymbol }

// @huaqiu/ecad-renderer
interface RenderOptions { canvas?: HTMLCanvasElement; container?: HTMLElement; interactive?: boolean }
interface RenderResult<TViewer = unknown> { canvas: HTMLCanvasElement; viewer: TViewer; dispose(): void }
function renderSchematic(s: I_KicadSch, o?: RenderOptions): Promise<RenderResult>
function renderPcb(p: I_KicadPCB, o?: RenderOptions): Promise<RenderResult>
function renderProjectFromZip(src, o?: RenderProjectOptions): Promise<RenderResult>
function loadProjectZip(src): Promise<{ files, rootSchematic }>
```

Both render functions are `async`, accept a `container` (the renderer appends its own canvas), take `interactive` (default `false`, enables viewer interaction), and return a `dispose()` that tears the viewer down. Standalone renders deliberately omit the KiCad drawing sheet and zoom-fit the geometry (`README.md`).

**The documented options are the whole surface.** There is no `theme`, `scale`, `font`, `width` or `height` parameter; the README's `{ width: 320, height: 240 }` example (`ecad-renderer/README.md:12`) is not part of `RenderOptions` and is silently ignored (`dist/index.js:106551-106562`). Theme is hard-coded (`themes_default.default.schematic` / `.board`), sizing is CSS-only, and the PCB viewer additionally forces its own grey background (`dist/index.js:38472`). Any DSH-theme adaptation must therefore be a wrapper/frame treatment, not a renderer option — a real limitation, see R3.

### 5.3 Mounting and disposal constraints (measured in the shipped bundle)

These are not stylistic details; each one changes the adapter:

| Constraint | Evidence | Adapter consequence |
|---|---|---|
| `target()` creates a canvas and, if no `container` is passed, **appends it to `document.body`** | `dist/index.js:106537-106543` | Always pass the real container ref; never omit it |
| Generated canvas has **no CSS sizing** (300×150 default); the backing store follows `getBoundingClientRect()` × DPR | `dist/index.js:29540-29552`, `:38631-38640` | The body must set `width/height:100%` on the canvas |
| The viewer only becomes `ready` when `clientWidth>0 && clientHeight>0`; `load()` awaits `ready` | `dist/index.js:30666-30671`, `:32530-32536` | A zero-size or detached host makes the promise **never settle** — no timeout, no rejection. Guard with a size check plus a watchdog |
| `dispose()` disposes the viewer but **does not remove the canvas** | `dist/index.js:106549` | The adapter removes the canvas element itself (the existing product code already does: `dsh-hardware-ui/src/client/ecad.ts:95-98`) |
| Schematic renders on **Canvas2D** (`Canvas2DRenderer`, `getContext("2d")`); PCB uses **WebGL2** (`WebGL2Renderer`, `getContext("webgl2")`) | `dist/index.js:38559`, `:38601`; `:29488`, `:29511` | PCB body needs an explicit unavailable state when WebGL2 is absent, not a crash |
| `interactive: true` adds a non-passive wheel handler with `preventDefault()` | `dist/index.js:30469-30473`, `:30552` | The wheel zooms the drawing instead of scrolling the pane — acceptable for a canvas-only tab, must be documented |
| Known leaks: an unregistered `document` click listener, a never-removed `window` mouseup listener, and no `WEBGL_lose_context` on dispose | `dist/index.js:30778`, `:30418-30442` | Repeated remounts (every tab switch) accumulate listeners and GL contexts. Constrain churn: one canvas per body instance, nothing else; add a remount-cycle test |
| A drawing call can land after dispose and throw `TypeError` | `dist/index.js:30812-30814`, `:38632-38634` | Dispose in a `try` and swallow late-frame errors at the boundary |
| A referenced symbol whose library definition is absent is dereferenced **unguarded** during the draw pass | `dist/index.js:39921` (`si.lib_symbol`), `:39936-39938` (DNP marks) → `:5269-5274` (`this.lib_symbol.bbox`); first frame awaited at `:32530` | The throw may surface as a rejection *or* as a promise that never settles; the body must own a timeout rather than rely on rejection |

### 5.4 Smallest adapter shape

```tsx
// body: loading 'bytes-complete'
const text = new TextDecoder().decode(content.data)          // content.kind === 'bytes'
const pod  = new SchematicParser().parse(text)               // or new BoardParser()
const mounted = await renderSchematic(pod, { container, interactive: true })
return () => mounted.dispose()
```

Notes that make this correct inside the MDI:

- Because the body unmounts on hide, the effect must guard against resolving after unmount (dispose immediately if the effect was cleaned up) — the same shape `glb.ts:33-48` already uses with an AbortSignal.
- `container` must have non-zero size at mount: the pane content row gives full pane width, but a hidden/`inert` host does not. Mounting happens only when visible (`TabLayout.tsx:103`), so this holds.
- No theme coupling exists in the API: the viewer takes its own built-in theme (`themes_default.default.schematic` / `.board` in the bundle). Matching the DSH dark/light theme therefore needs either a renderer option (absent in 0.2.6) or a CSS-level fallback; see risk R3.

### 5.5 Hierarchical schematic behavior (source-proven limitations)

| Concern | Actual behavior | Evidence |
|---|---|---|
| Root file | `SchematicParser.parse` returns the POD for exactly the parsed text; the renderer wraps it as `new KicadSch("schematic.kicad_sch", pod)` | `dist/index.js:3461458` |
| Child sheet references | `sheet` records are parsed with their `Sheetfile` property but the file is never opened; the sheet is drawn as a box | parser `dist/schematic_parser.d.ts`; no file access in either package |
| Sheet instances / project metadata | `(instances (project … (path … (reference …))))` is parsed and retained, but no renderer path consumes it | parser POD only |
| Symbol instances vs lib symbols | Symbols are resolved against the file's own embedded `lib_symbols`. A missing library symbol is dereferenced without a guard, so drawing that symbol throws instead of degrading to a placeholder | `dist/index.js:39921`, `:5269-5274` |
| Reference/value text | Falls back to `?` for a missing reference and to an empty string for a missing value — text-level fallbacks only, not geometry | `dist/index.js:5286`, `:5292-5294` |
| Multi-unit symbols | Only the units placed in this sheet are drawn | POD-driven |
| External symbol libraries | Never read; no path, no network | no `fs`/`fetch` in either bundle |

The practical reading: a standalone `.kicad_sch` renders faithfully as long as KiCad embedded its library symbols — the normal save case. When it did not, the failure is a draw-pass exception rather than a degraded drawing, which is precisely why the adapter needs its own timeout and a failure state (§5.3). What matters architecturally is the negative guarantee: the preview never substitutes another file or silently loads a project.

This matches the specification's priority: independent file preview first, whole-hierarchy reconstruction explicitly out of scope. The preview must therefore show *the selected file*, and the empty-state/error copy must not imply a project was loaded.

### 5.6 PCB-specific findings

| Question (from §7.1 of the specification) | Answer |
|---|---|
| `BoardParser.parse(text)` | `new BoardParser().parse(text)` → `boardProto.I_KicadPCB`; pure S-expression parse, no project, no netlist, no schematic |
| `renderPcb` options | `{ canvas?, container?, interactive? }` only — **no layer visibility, no side flip, no net highlighting, no theme**. The internal layer list is not exported |
| Canvas mounting | Identical to schematic (`WebGL2Renderer` instead of `Canvas2DRenderer`) |
| Resource lifecycle | `dispose()` disposes the WebGL viewer; the canvas stays and must be removed by the host |
| Bundling | `@huaqiu/ecad-renderer/pcb` = 3.30 MB entry, dependency-free, no CDN |
| Rendering compatibility | Requires WebGL2 (`:29488`, `:29511`); a hidden or zero-size host never becomes ready (`:30666`) |
| Independent preview | Works from a saved `.kicad_pcb` alone — proven by the API surface, which reads nothing but the bytes it is given |

**Consequence for the first cut:** the PCB preview is a faithful, non-interactive-by-default raster of the whole board. Layer toggles, board-side flipping and net highlighting are *not* available through the current renderer API and must not be promised in the UI. Adding them requires an upstream renderer capability, not application code.

### 5.7 D4 result summary

| Item | Value |
|---|---|
| Reusable APIs | `SchematicParser.parse`, `BoardParser.parse`, `renderSchematic`, `renderPcb`, each returning `{ canvas, viewer, dispose() }` |
| Exact dependency versions | `@huaqiu/kicad-sexpr-parser` `0.1.3`; `@huaqiu/ecad-renderer` `0.2.6` |
| Required bundled dependencies | Parser (100 KB), renderer entry (3.2–3.5 MB), `immutable`, `jszip` — all inlined, no runtime resolution |
| Smallest MDI adapter | `mountEcadDocument` (§10.4): bytes → POD → renderer → dispose, with a size gate and a timeout |
| Lifecycle requirements | Size gate before render; abort after each await; remove the canvas; swallow late-frame errors; one canvas per body instance |
| Limitations | No theme option, no layer/side/net controls, no hierarchy traversal, draw-pass throw on missing library symbols, PCB needs WebGL2 |
| Test requirements | T4–T7 and T15 in §11 |

---

## 6. D5 — STEP/STP feasibility

### 6.1 What actually exists locally

| Capability | Status | Evidence |
|---|---|---|
| STEP/STP parser or converter in the product repos | **None** | Case-insensitive search for `step`, `stp`, `iso-10303`, `occt`, `opencascade`, `assimp`, `trimesh`, `freecad` across `dsh-pcb-eda/packages/*` and `deepseek-harness/packages/*` returns only unrelated UI strings |
| Converter installed as an npm dependency | **None** | `node_modules/.pnpm` has no `occt*`, `opencascade*`, `assimp*`, `step*`, `cad*`; the only 3D package is `three@0.185.1` |
| FreeCAD / OCCT Python | not installed (`which freecad` → not found; `import OCC` → ImportError) | shell check |
| `kicad-cli` STEP support | **Export only** — `pcb export step`, `stpz`, `brep`, `glb`, `stl`, `3dpdf`; no import or mesh conversion | `kicad-cli pcb export --help` (KiCad 10) |
| **STEP → mesh converter present on this machine** | **Yes, vendored**: `occt-import-js` `0.0.21` with a 7.4 MB `occt-import-js.wasm`, 1.4 MB JS wrapper and its LGPL-2.1 text, at `/Users/admin/code/web-vue/static/libs/loaders/` | file listing of that directory; the same asset family appears under `/Users/admin/code/ecad-viewer-ref/` |
| That converter is actually wired | **Yes**, twice: `ReadStepFile(new Uint8Array(bytes))` then a three.js mesh — `web-vue/src/components/wirebond/fileUpload.vue:2156` and `ecad-viewer-ref/.../fileUpload.vue:2251` | source read |
| Result construction | The existing wiring builds one `BufferGeometry` from `result.meshes[0]` only, labelling it `step-model` | `fileUpload.vue` STEP branch |
| GLB rendering (proven, in-product) | `mountGlb(url, container, {signal})` with fitted camera, drag-orbit, wheel zoom, GPU disposal | `dsh-hardware-ui/src/client/glb.ts:33-110` |
| GLB production (proven, host-side) | `POST /glb` → `kicad-cli pcb export glb --output <tmp> <board>.kicad_pcb`, cached by `path:revision`, timeout + abort | `hardware-artifacts/src/service.ts:1056-1102`; `routes.ts:319-358` |
| three.js loaders offline | `GLTFLoader.js` present in `three@0.185.1/examples/jsm/loaders/` | disk check |
| ECAD Viewer 3D | three.js `GLTFLoader` on a **pre-generated** `glb_url`; no STEP parsing | `ecad-viewer/packages/ecad-viewer-app/src/3d-viewer/viewer.ts:31`, `:260` |

### 6.2 The asymmetry that decides the recommendation

`kicad-cli pcb export glb` embeds the board's 3D **models** (the STEP files referenced by the `.kicad_pcb`) into the board mesh. Board-level 3D of a STEP-referencing design therefore already works — through the **PCB** document, not through the STEP document. What is missing is standalone preview of a `.step`/`.stp` file, and in the current product there is no route that would serve one: the artifact service reads **text source documents only** (`hardware-artifacts/src/types.ts:84-85`), and its only mesh export is `.kicad_pcb`-scoped (`service.ts:1057-1060`).

The document MDI removes that obstacle for free: a `bytes-complete` renderer already receives the file's bytes (`document/contract.ts:17-19`), up to the host's 32 MiB whole-file cap (`api/workspace-files/src/index.ts:188`). **Standalone STEP preview therefore needs no host route and no project** — only a client-side converter and a viewer.

### 6.3 Ranked recommendation

**1. Best reusable solution already present in the local ecosystem — `occt-import-js` `0.0.21` + the existing three.js viewer.**

The converter is not hypothetical: it is a vendored wasm build of OpenCascade that two local projects already call to turn STEP bytes into three.js meshes, entirely in the browser, offline, with no daemon, no native install and no CadQuery. Wire it as:

```
content.kind === 'bytes'
  → occt.ReadStepFile(new Uint8Array(content.data), null)   // wasm, in a Worker
  → merge EVERY result.meshes[i] into BufferGeometry        // the old wiring keeps only [0]
  → scene/camera/lights/dispose from glb.ts
```

Costs and conditions:

- **Assets**: 7.4 MB wasm + 1.4 MB JS must be vendored into the plugin and served as static chunks (they cannot be inlined into a client bundle sensibly). That is the single largest footprint in this proposal.
- **License**: the vendored `LICENSE` is LGPL-2.1 (OpenCascade). Redistribution inside a shipped desktop app is permitted but needs the standard LGPL obligations (notice, licence text, relinking/WASM-source availability) — a legal read, not an engineering one. This is the one item that can invalidate the recommendation.
- **Correctness fixes** over the old wiring: merge all meshes (multi-part assemblies), keep per-mesh colour if present, load in a Worker so a 30 MB STEP cannot freeze the UI, and honour a bounded timeout.
- **No new host route is required**, which is exactly why the document-first architecture is cheaper than the earlier artifact-service design.

**2. Minimal viable alternative — `.glb` only, zero new dependencies.** Register `glb` on `mountGlb` (already in-tree, disposal-correct), leave `.step`/`.stp` unregistered, and let the guidance text tell the user to ask the agent for a `.glb` or to open the board's 3D view. This is a legitimate first ship: it delivers real 3D for the format the pipeline already produces.

**3. Fallback if the LGPL review fails — no graphical STEP.** `.step`/`.stp` stay in the plain-text reader (ISO-10303 is ASCII, so the document remains legible and searchable) with an explicit limitation note. Nothing claims a capability that does not exist.

**Explicitly rejected**

| Option | Why rejected |
|---|---|
| Host-side FreeCAD conversion | Adds a native dependency and an installation step; contradicts §16 |
| `kicad-cli` for STEP | Export-only; cannot read STEP |
| Writing a new STEP parser/convertor | Prohibited by §16 and unjustified — a working wasm converter exists |
| Inline base64 STEP into a sandboxed HTML frame | The frame cannot read workspace files; inlining a 7 MB model per view is worse than the wasm route |
| Static screenshot / thumbnail | Violates "graphical preview must be the actual file" and cannot orbit |

### 6.4 Requirement checklist (STEP)

| Requirement | `occt-import-js` wasm (recommended) | `mountGlb` only (alternative) |
|---|---|---|
| Offline | yes | yes |
| Client vs host | client | client |
| Native runtime | no | no |
| Cacheable conversion | per-tab memo; IndexedDB optional | n/a (source is already mesh) |
| Large-file safe | yes with a Worker + byte cap; wasm heap is the limit | yes |
| Cancellable | terminate Worker | abort signal |
| Bounded timeout | Worker timer (required — no built-in timeout) | `loadAsync` + abort |
| Windows x64 | yes (wasm) | yes |
| Separate daemon | no | no |
| Packageable with DSH | yes, as static chunks (8.8 MB total) | yes (already bundled) |
| License | LGPL-2.1 — review required | in-tree MIT |

## 7. D6 — Workspace and document model

### 7.1 Which project assumptions exist today, and why

| Assumption | Where it lives | Need for preview? | Need for fabrication? |
|---|---|---|---|
| A canonical Hardware Engineering project | `hardware-artifacts/src/service.ts` discovery (`walkFiles`, `MAX_DEPTH = 5` at `:287`), `GET /projects` (`routes.ts:120`) | **No** | Yes for BOM/Gerber/order derivation |
| A `.kicad_pro` | same discovery; root sheet resolution | **No** | Only as KiCad's own project marker |
| Selected board / selected root schematic | `dsh-hardware-ui/src/client/store.ts:41-53` (`adoptProject` resets `schematicPath`, `pcbPath`, `bomPath`) | **No** | Yes for "the board being ordered" |
| Selected mechanical model | not a store field: mechanical artifacts are discovered by extension in `hardware-artifacts/src/service.ts:282` (`MECHANICAL_EXTENSIONS`) | **No** | No |
| Product-specific project store | `dsh-hardware-ui/src/client/store.ts:91` (`activeDestination`, `projectPath`) | **No** | No |
| A fixed engineering destination | `model.ts:5` `HardwareDestination`, `:16` `DESTINATIONS` | **No** | No |
| A Hardware Engineering manifest | `hardware-engineering/src/index.ts` plugin list + `cordis.patch.yml` | No (it is the bundle wiring, not a document concept) | No |

The decisive observation: **the entire ECAD rendering path in this proposal never touches `hardware-artifacts`.** The MDI hands the renderer the selected file's bytes (`document/contract.ts:17-19`) and the renderer parses those bytes. No route, no discovery, no project, no board selection. §4.2 of the specification is satisfied with zero product-owned state.

### 7.2 Desired document model (and how it is already satisfied)

| Requirement | Mechanism | Status |
|---|---|---|
| User selects a file; MDI opens the exact file | address = session + path; `tabs.claim` returns `contentId = address` | Already true (`tab-registry.ts:388-394`) |
| Renderer operates on that file | `content` bytes/text keyed to the tab, never to a project | Already true (`contract.ts:33-46`) |
| No project selected unless genuinely required | Nothing in the preview path reads a project store | Already true |
| Agent creates a file; it opens immediately | Agent link → `openFile` → `openResource` | Already true (`ui-chat/src/client/apply.ts:272-279`) |
| Preview does not require a complete project | Parser works on a single file's text | Proven (§5.5) |
| Many unrelated designs, many open artifacts | Many tabs, one identity per address | Already true |
| Document selection must not switch a project context | No preview code dispatches to a project store | Already true |

The revised architecture therefore **removes** state rather than adding it. That is the main reason it is smaller than the POC.

### 7.3 What project discovery remains for

Keep discovery, ranking and the artifact identity service, but only as inputs to operations that genuinely need a board/project:

- BOM extraction (schematic-derived, `POST /bom`, `routes.ts:298`).
- Gerber/drill/position generation (`POST /fabrication`, `routes.ts:179`).
- Order placement, which the EDA host performs from the open board (`place_pcb_order`, see §8).
- PCB 3D GLB export (`POST /glb`, `.kicad_pcb`-only).
- Native "open in KiCad" (`POST /open`, `routes.ts:372`).

None of these should gate document preview. Conversely, preview must not be presented as sufficient for them.

---

## 8. D7 — Order workflow boundary

### 8.1 Actual inputs, per operation (source-proven)

| Operation | Tool | Required inputs | Derived from | Backend |
|---|---|---|---|---|
| PCB fabrication quote | `quote_pcb` (`dsh-tool-quote/src/tools.ts:99`) | optional `region`, `bcount`, `blayer`, `blength`, `bwidth`, … | board size / layer count / thickness / min trace / min hole are **always derived from the open board** when an EDA editor has one open; otherwise reference defaults + explicit args (`tools.ts:76-95`) | `POST /api/v1/quote/pcb` (`src/index.ts:6`) |
| SMT quote | `quote_smt` (`tools.ts:205`) | same PCB inputs + assembly options | embeds the PCB order parameters | `POST /api/v1/quote/smt` (`index.ts:7`) |
| PCB order | `place_pcb_order` (`tools.ts:292`) | `region?` only | **precondition: a PCB editor with a board open in the EDA host**; the host generates gerber/drill/BOM/zip from that board and opens its own order dialog (`tools.ts:294-303`) | EDA host (`ACTIONS::placeOrderForPCB`) |
| SMT order | `place_smt_order` (`tools.ts:324`) | `region?` only | same precondition; artifacts = board zip + BOM + positions (`tools.ts:326-331`) | EDA host (`ACTIONS::placeOrderForSMT`) |

### 8.2 Answers the specification asks for

- **Does ordering accept a standalone file?** No. Order placement is an EDA-host action performed on the *currently open board* — it produces Gerber/drill/BOM/positions itself. A standalone `.kicad_pcb` in the workspace is not an ordering input.
- **Does quoting accept a standalone file?** It does not read files at all: it is a backend query whose geometry either comes from the live editor board or from explicit parameters/defaults. So a standalone PCB is *not* automatically priced, but quoting also does not require a project.
- **Does anything require gerbers first?** No — the host generates them at order time.
- **Is backend availability an activation requirement?** No. Without a quote service the tools still register and report `FAILED_PRECONDITION` per call (`dsh-tool-quote/src/index.ts:112-117`). This already satisfies §10.3.
- **BOM source** for PCBA: derived from the schematic by `hardware-artifacts` (`POST /bom`), not from a BOM file.

### 8.3 Consequence for the UI

A dedicated Order destination is unnecessary. The honest boundary is:

- Document preview answers "what is in this file".
- Quoting/ordering answers "what does this design cost / how do I buy it", which needs the EDA host and (for quoting fidelity) an open board.
- The smallest useful entry point is a header action on a `.kicad_pcb` document that asks the agent to quote it (the `sidebar.right.tab.document.actions` slot with `absolutePath`), or simply the agent's own tool call. **Defer** any such button until the renderer ships; no product tab.

---

## 9. D8 — POC code delta

Classification against the document-centric target:

| Capability | Package / evidence | Classification | Rationale |
|---|---|---|---|
| Fixed five-destination model (`schematic pcb bom 3d order`) | `dsh-hardware-ui/src/client/model.ts:5`, `:16`, `:28` | **Remove** | The MDI replaces destinations with documents; keeping the enum keeps dead navigation |
| Engineering navigation component | already deleted in the product (no `EngineeringNav` in `src`) | **Remove (done)** | Nothing to reuse |
| Product-owned project/board selection | `store.ts:41-51` `adoptProject`, `:83-84`, `:98` | **Remove** | Preview must not carry a selection |
| Artifact selection store (`activeDestination`, paths, revision) | `store.ts:91` | **Remove** (preview) / **Defer** (fab) | Fab operations still need "the board"; revisit when they get a UI |
| Product-specific viewer tab (`kind: 'hardware-engineering'`, `default: true`) | `client/index.ts:147-157` | **Remove** | This is the second tab system the spec forbids |
| Right-panel viewer body registration | `client/index.ts:160-165` | **Remove** | Replaced by document bodies |
| `conversation.header.leading` usage | not present in current `src` | **Remove (done)** | — |
| Hardware Engineering manifest / bundle wiring | `hardware-engineering/src/index.ts:93`, `cordis.patch.yml:102-103` | **Reuse** | Still the product's composition root; entry for `dsh-hardware-ui` stays |
| Project discovery + ranking | `hardware-artifacts/src/service.ts` (discovery), `routes.ts:120` `/projects` | **Reuse** (fab only) | Needed by BOM/Gerber/order; must stop being a preview prerequisite |
| Canonical artifact identity (project+board+kind) | `hardware-artifacts/src/service.ts` (`artifact(...)`, `SOURCE_EXTENSIONS:283`) | **Adapt** | Keep for fab; preview identity is the file address |
| Raw-content route `GET /source` | `routes.ts:153` | **Remove** (preview) / **Defer** | The MDI delivers bytes; the route exists only for the old viewer |
| GLB routes `POST /glb`, `GET /glb-file` | `routes.ts:319`, `:349`; `service.ts:1056` | **Reuse** | Still the only board-3D producer; also the fallback for STEP users |
| Schematic rendering adapter | `dsh-hardware-ui/src/client/ecad.ts` (`mountEcad`) | **Adapt** | Its mount/dispose/canvas-removal logic is exactly what the body needs; re-shape to take bytes instead of a URL |
| PCB rendering adapter | same file, `kind: 'pcb'` branch | **Adapt** | Same |
| GLB viewer | `client/glb.ts:33-110` `mountGlb` | **Reuse** | Already disposal-correct and offline |
| BOM table | `client/preview.tsx` (BOM destination) | **Defer** | A BOM is a document/table concern; no MDI renderer planned in this scope |
| Native-open action ("Open in KiCad") | `client/index.ts:138-145` `openNative`, `model.ts:37` `applicationFor` | **Adapt** | Becomes a `sidebar.right.tab.document.actions` contribution using `absolutePath` |
| CAD installation settings | `client/index.ts:167-174` `settings.section`; `HARDWARE_SETTINGS_ID` | **Reuse** | Still required for native open and GLB export |
| Agent environment context | `hardware-artifacts/src/index.ts:42` `inject: ['webServer','systemPrompt']` | **Reuse** | Independent of the viewer |
| Quote/order entry points | `dsh-tool-quote` tools | **Reuse** unchanged | No backend change; no document coupling |

Net effect: `dsh-hardware-ui` loses its tab type, its destination model, its selection store and its viewer body, and gains three document-body registrations. `hardware-artifacts` loses nothing it still needs — only its role as a preview prerequisite.

---

## 10. D9 — Minimal implementation specification

### 10.1 Ownership decision

**Implement inside `@huaqiu/dsh-hardware-ui`; do not add a package.**

| Option | Verdict |
|---|---|
| Extend `dsh-hardware-ui` | **Chosen.** It already bundles `@huaqiu/ecad-renderer` 0.2.6, `@huaqiu/kicad-sexpr-parser` 0.1.3 and `three` through `alwaysBundle` (`tsdown.config.ts:24-31`), already owns the CAD settings and the native-open action, and is already in the product bundle. Adding the renderers here costs **one** copy of the 3.2 MB renderer |
| New `@huaqiu/dsh-ecad-preview` package | Rejected for this scope: a second package would ship a second inlined copy of the renderer (≈3.2 MB duplicated) and require a new `cordis.patch.yml` entry and a new bundle role |
| A DSH core change | Rejected: no change is needed |

### 10.2 Files to add

```
packages/dsh-hardware-ui/src/client/document/
  index.ts        apply(): register definitions, titles, bodies
  schematic.tsx   .kicad_sch body
  pcb.tsx         .kicad_pcb body
  glb.tsx         .glb body (reuses ../glb.ts mountGlb)
  mount.ts        shared adapter `mountEcadDocument`: bytes → POD → renderer → dispose
  copy.ts         localized titles and failure text (8 locales)
```

### 10.3 Registration (exact shape)

```ts
// document/index.ts
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'

export const SCHEMATIC_BODY_ID = '@huaqiu/dsh-hardware-ui/document/schematic'
export const PCB_BODY_ID       = '@huaqiu/dsh-hardware-ui/document/pcb'
export const GLB_BODY_ID       = '@huaqiu/dsh-hardware-ui/document/glb'
const NS = 'huaqiuHardwareDocument'

export function applyDocumentRenderers(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'hardware-ui: document copy')
  const t = ctx.locale.bind(NS)

  const defs = [
    { id: SCHEMATIC_BODY_ID, extensions: ['kicad_sch'], title: () => t('viewer.schematic') },
    { id: PCB_BODY_ID,       extensions: ['kicad_pcb'], title: () => t('viewer.pcb') },
    { id: GLB_BODY_ID,       extensions: ['glb'], binaryExtensions: ['glb'], title: () => t('viewer.glb') },
  ] as const

  for (const def of defs) {
    ctx.effect(() => ctx.documentPreviews.register({
      ...def,
      priority: 'extension',      // explicit: outranks the builtin text renderer for the same suffix
      loading: 'bytes-complete',  // whole file, ≤ host 32 MiB cap
      wrap: false,
    }), `hardware-ui: ${def.id} metadata`)
  }

  const bodies = [[SCHEMATIC_BODY_ID, SchematicBody], [PCB_BODY_ID, PcbBody], [GLB_BODY_ID, GlbBody]] as const
  for (const [key, Body] of bodies) {
    ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
      { name: 'sidebar.right.tab.document', key, locale: NS }, Body,
    )), `hardware-ui: ${key} body`)
  }
}
```

`inject` on the plugin gains `'documentPreviews'`; `apply` drops the tab-type registration and calls `applyDocumentRenderers(ctx)`.

### 10.4 Shared adapter (`mount.ts`)

```ts
export interface EcadMount { dispose(): void }

export async function mountEcadDocument(
  kind: 'schematic' | 'pcb',
  bytes: Uint8Array,
  container: HTMLElement,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<EcadMount> {
  await nonZeroSize(container, signal, timeoutMs)     // renderers never settle on a 0-size host
  const text = new TextDecoder().decode(bytes)        // both formats are UTF-8 S-expressions
  const [parser, renderer] = await Promise.all([
    import('@huaqiu/kicad-sexpr-parser'),
    kind === 'schematic' ? import('@huaqiu/ecad-renderer/schematic') : import('@huaqiu/ecad-renderer/pcb'),
  ])
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  const pod = kind === 'schematic'
    ? new parser.SchematicParser().parse(text)
    : new parser.BoardParser().parse(text)
  const mounted = await withTimeout(
    kind === 'schematic'
      ? renderer.renderSchematic(pod as never, { container, interactive: true })
      : renderer.renderPcb(pod as never, { container, interactive: true }),
    timeoutMs,
  )
  if (signal.aborted) { mounted.dispose(); mounted.canvas.remove(); throw new DOMException('aborted', 'AbortError') }
  return {
    dispose(): void {
      try { mounted.dispose() } catch { /* late-frame draw after dispose */ }
      mounted.canvas.remove()                       // dispose() does not remove it
    },
  }
}
```

Non-negotiable details, each traced to the bundle findings in §5.3:

1. **Size gate before render** — a zero-size host makes the promise never settle.
2. **Timeout** — also covers the missing-lib-symbol dereference that hangs instead of throwing.
3. **Canvas removal** — `dispose()` leaves the canvas in the container.
4. **Abort after each await** — a tab switch during parse/render must not mount into a dead container.
5. **Dynamic `import()`** — keeps 3.2 MB out of the initial client chunk (the `LazyPdfBody` pattern).
6. **One mount per body instance** — remounts are frequent (no `keepMounted`), so no caches keyed on DOM nodes.

### 10.5 Body contract (identical for schematic and PCB)

```tsx
export function SchematicBody({ content, t }: DocumentPreviewProps & LocaleProps): ReactNode {
  const host = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<'waiting' | 'ready' | 'failed'>('waiting')
  const [detail, setDetail] = useState<string>()
  useEffect(() => {
    if (content.kind !== 'bytes' || host.current === null) return
    const abort = new AbortController()
    let mount: EcadMount | undefined
    void mountEcadDocument('schematic', content.data, host.current, abort.signal)
      .then(m => { if (abort.signal.aborted) m.dispose(); else { mount = m; setState('ready') } })
      .catch((error: unknown) => { if (!abort.signal.aborted) { setState('failed'); setDetail(String(error)) } })
    return () => { abort.abort(); mount?.dispose() }
  }, [content])
  // waiting → LoadingIndicator; failed → message + "ask the agent to regenerate"; ready → canvas host
}
```

Failure copy must state the file and the limitation ("this schematic references a child sheet that is not part of this file") and never imply a project was loaded.

### 10.6 Removals in the same change

| Remove | File |
|---|---|
| `ctx.sidebarRightTabs.register({ kind: 'hardware-engineering', default: true, keepMounted: true })` | `src/client/index.ts:147-157` |
| `sidebar.right.pane.tab` body registration (`HardwareViewerBody`) | `src/client/index.ts:160-165` |
| `openDestination`, `viewerStore`, `DESTINATIONS`, `HardwareDestination`, `adoptProject` | `store.ts`, `model.ts`, `components.tsx`, `preview.tsx` |
| `viewer` copy keys that described destinations | `copy.ts` |
| `HARDWARE_TAB_ID` / `HARDWARE_TAB_KIND` exports and their tests | `index.ts:33-34`, `test/client.test.ts` |

Keep: `settings.section`, `openNative`, `glb.ts`, `ecad.ts` (re-shaped), `transport.ts` (GLB/native only), `order.tsx` (Defer).

### 10.7 STEP (contingent)

If the LGPL review passes, add `document/step.tsx` with `extensions: ['step','stp']`, `loading: 'bytes-complete'`, and a body that runs `occt-import-js` **in a Worker** over `content.data`, merges every mesh into one `BufferGeometry`, then hands the geometry to a scene built from `glb.ts`. If the review fails, register nothing for these suffixes and add the guidance text instead.

### 10.8 Acceptance criteria for the implementation

1. `.kicad_sch` opened from the explorer renders graphically with no project and no KiCad installation.
2. `.kicad_pcb` opened the same way renders graphically; on a WebGL2-less host it shows an unavailable state, not a crash.
3. The same document opened from an agent response lands in the **same** tab (reuse), not a second one.
4. Two files with the same basename in different directories are two tabs, each showing its own file.
5. Markdown, code, image, PDF, HTML and Excel previews are byte-for-byte behaviorally unchanged; the renderer dropdown still offers plain text for KiCad files.
6. Panel collapse/expand and rapid tab switching leak no canvas and no GL context (measured over ≥20 cycles).
7. No network request occurs while rendering (offline check).
8. The product bundle contains no product tab type and no five-destination navigation.

---

## 11. D10 — Test and acceptance plan

| # | Level | Test | Asserts |
|---|---|---|---|
| T1 | Unit | definition table | three ids; `extensions`; `glb` declares `binaryExtensions`; `priority: 'extension'`; `loading: 'bytes-complete'` |
| T2 | Unit | `matchingDocumentPreviews([...defs, text], 'a.kicad_sch')` | ECAD definition first, plain text last |
| T3 | Unit | dispatch keeps a user choice | unknown `rendererId` falls back to `candidates[0]` |
| T4 | Unit | `mountEcadDocument` success | parser called with decoded text; renderer called with the container; `dispose` removes the canvas |
| T5 | Unit | `mountEcadDocument` zero-size | rejects within `timeoutMs` instead of hanging |
| T6 | Unit | `mountEcadDocument` abort mid-render | `dispose()` called, no canvas left, `AbortError` |
| T7 | Unit | missing lib symbol fixture | failure state rendered, no unhandled rejection |
| T8 | Component | body with `content.kind !== 'bytes'` | shows the loading state and never mounts |
| T9 | Component | unmount during load | no state update after unmount |
| T10 | Registration | modeled on `ui-sidebar-documentpreview/tests/image-registration.client.spec.ts` | definitions registered on apply, disposed on unload |
| T11 | Regression | `pnpm --filter @deepseek-ai/dsh-client-ui-sidebar-documentpreview test` | the package's 18 registration/dispatch tests stay green |
| T12 | Regression | `pnpm --filter @huaqiu/dsh-hardware-ui test` | settings/native-open tests still pass after the tab removal |
| T13 | E2E (manual, CDP) | explorer click on `.kicad_sch` | canvas appears, geometry non-blank, path header correct |
| T14 | E2E | agent-response link to the same file | existing tab revealed, not duplicated |
| T15 | E2E | collapse/expand ×20, tab-switch ×20 | canvas count returns to 0 when hidden; no context loss error |
| T16 | E2E | 0-byte and invalid `.kicad_sch` | failure copy, no hang, panel still usable |
| T17 | E2E | 40 MiB `.kicad_pcb` | existing `too-large` state; no crash |
| T18 | Offline | devtools offline during render | render still completes |
| T19 | Bundle | inspect `lib/client.js` + emitted chunks | ECAD code is a separate chunk; no `node:` imports; size budget recorded |
| T20 | STEP (contingent) | 7 MB `.step` | wasm loads locally, worker terminates on unmount, timeout enforced |

Acceptance = T1–T19 green, T20 only if §10.7 proceeds.

---

## 12. Source evidence matrix

| Claim | Repository | Source path | Symbol / line | Evidence | Confidence |
|---|---|---|---|---|---|
| Document renderers are a public registry | DSH | `packages/client/ui-sidebar-documentpreview/src/client/document/registry.ts` | `DocumentPreviewRegistry.register` | `:99-118` plus `README.md:37` | High |
| Dispatch is extension-based with priority bands | DSH | same | `matchingDocumentPreviews` | `:41-54`; `priority: 'builtin' ? 0 : 1` at `:48` | High |
| Plain text is an implicit fallback | DSH | `.../src/client/text/index.ts` | `textBodyDefinition` | `:15-17` (`extensions: []`); appended at `TextPreview.tsx:85-86` | High |
| Body receives file bytes | DSH | `.../src/client/document/contract.ts` | `DocumentContent`, `DocumentBodyOwner` | `:17-30`, `:33-46` | High |
| Renderer-owned loading rejects stale results | DSH | `.../src/client/store.ts` | `rendered`, `rendererFailed` | `:157-166` | High |
| One tab type claims all file addresses | DSH | `.../src/client/definition.ts` | `textDefinition` | `:45-54` (`patterns`, `priority: 'fallback'`) | High |
| Explorer opens through `openResource` | DSH | `packages/client/ui-sidebar-files/src/client/FilesBody.tsx` | `open` | `:44-47` | High |
| Agent links open through the same service | DSH | `packages/client/ui-chat/src/client/apply.ts` | `openFile` | `:272-279` | High |
| Both converge on `placeResource` | DSH | `packages/client/ui-sidebar-right/src/client/service.ts` | `openResource` → `placeResource` | `:380-382`, `:443-455` | High |
| Identity is the whole address | DSH | `.../ui-sidebar-right/src/client/tab-registry.ts` | `claim` | `:379-395` (`contentId: address`) | High |
| Tab reuse by contentId | DSH | `packages/client/ui-dockkit/src/engine/planner.ts` | `findPaneContentTab` | `:71-92` | High |
| Hidden bodies unmount (no keepMounted) | DSH | `.../ui-sidebar-right/src/client/tab-registry.ts`, `.../shell/SidebarRight.tsx` | `keepMounted` | `tab-registry.ts:108`, `SidebarRight.tsx:208`, `:365` | High |
| Whole-file read cap 32 MiB | DSH | `packages/api/workspace-files/src/index.ts` | `WorkspaceFiles.Config` | `:188` (`maxFileBytes` default 32 MiB) | High |
| Binary suffixes suppress the text fallback | DSH | `.../document/unviewable.ts`, `TextPreview.tsx` | `unviewableBinaryPath` | `unviewable.ts:35-37`; `TextPreview.tsx:80` | High |
| Parser API | Product | `@huaqiu/kicad-sexpr-parser@0.1.3/dist/schematic_parser.d.ts` | `SchematicParser.parse` | lines 9-13 of that file | High |
| Board parser API | Product | `.../dist/board_parser.d.ts` | `BoardParser.parse` | lines 3-5 | High |
| Renderer API and disposal | Product | `@huaqiu/ecad-renderer@0.2.6/dist/index.d.ts` | `renderSchematic`, `renderPcb`, `RenderResult.dispose` | lines 8-12 | High |
| Renderer takes a POD, not text | Product | `dist/index.js` | `renderSchematic` | `:106551-106562` | High |
| No width/height options | Product | `dist/index.js`, `README.md` | `RenderOptions` | `index.d.ts:9`; README example contradicts it | High |
| Zero-size host never settles | Product | `dist/index.js` | `viewer_ready` / `load()` | `:30666-30671`, `:32530-32536` | High |
| `dispose()` leaves the canvas | Product | `dist/index.js` | `RenderResult` | `:106549` | High |
| PCB needs WebGL2 | Product | `dist/index.js` | `WebGL2Renderer` | `:29488`, `:29511` | High |
| Missing lib symbol is dereferenced unguarded | Product | `dist/index.js` | `si.lib_symbol`, `lib_symbol.bbox` | `:39921`, `:5269-5274` | High |
| CJK glyphs bundled, no CDN | Product | `ecad-renderer/README.md` | — | README paragraph 2 | High |
| Schematic is Canvas2D | Product | `dist/index.js` | `Canvas2DRenderer` | `:38559`, `:38601` | High |
| Bundle is dependency-free | Product | `dist/index.js`, parser `dist/index.mjs` | — | no `require(`/`node:`/`fetch(` in either | High |
| Existing mount/dispose adapter | Product | `packages/dsh-hardware-ui/src/client/ecad.ts` | `mountEcad` | disposal + canvas removal branch | High |
| GLB viewer | Product | `packages/dsh-hardware-ui/src/client/glb.ts` | `mountGlb` | `:33-110` | High |
| GLB export is `.kicad_pcb`-only, host-side | Product | `packages/hardware-artifacts/src/service.ts` | `exportGlb` | `:1056-1102` (extension check `:1058`, `kicad-cli` `:1090`) | High |
| No STEP converter in product | Product | repo-wide search | — | no `occt`/`step` parse path; `MECHANICAL_EXTENSIONS` only lists files (`service.ts:282`) | High |
| Vendored STEP→mesh converter exists | Adjacent local tree | `/Users/admin/code/web-vue/static/libs/loaders/` | `occt-import-js` 0.0.21 | 7.4 MB wasm + LGPL file; used at `web-vue/src/components/wirebond/fileUpload.vue:2156` | Medium-High (asset, not a dependency) |
| Quote tools read no files | Product | `packages/dsh-tool-quote/src/tools.ts` | `quote_pcb` | `:99-204` (payload = region + form + eda flags) | High |
| Order requires an open board in the EDA host | Product | same | `place_pcb_order` | `:292-303` | High |
| Quote backend is not an activation gate | Product | `packages/dsh-tool-quote/src/index.ts` | `apply` | `:112-117` | High |
| Product viewer tab exists and must go | Product | `packages/dsh-hardware-ui/src/client/index.ts` | `sidebarRightTabs.register` | `:147-157` | High |
| Bundle composition | Product | `packages/hardware-engineering/src/index.ts`, `cordis.patch.yml` | plugin list | `index.ts:93`; `cordis.patch.yml:102-103` | High |

---

## 13. Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | `occt-import-js` LGPL-2.1 obligations for a shipped desktop app | Blocks STEP only | Legal review before §10.7; ship `.glb` meanwhile |
| R2 | Renderer leaks (window listener, document listener, no `lose_context`) multiplied by remount-per-tab-switch | GL context exhaustion after heavy use | One canvas per body, hard dispose, T15 cycle test before release |
| R3 | Renderer theme is hard-coded; DSH dark/light ignored | Visual mismatch | Frame the canvas with the panel surface colour; document as a known limitation; request a theme option upstream |
| R4 | Zero-size host → promise never settles | Frozen "loading" state | Size gate + timeout (§10.4) |
| R5 | Missing lib symbol → dereference before resolve | Frozen "loading" state | Same timeout; failure copy |
| R6 | 32 MiB whole-file cap | Very large boards/STEP cannot preview | Existing `too-large` state, no custom path |
| R7 | No `keepMounted` for this tab type | Re-parse on every reveal | Accept in v1; measure with T15; do not add a product tab type |
| R8 | Parser may resolve twice (0.1.3 direct + 0.1.2 nested under the renderer) | Bundle bloat | Bundler dedupe check in T19 |
| R9 | Renderer ships no `license` field | Packaging compliance | Fix upstream; not a blocker for local product use |
| R10 | Removing the product tab may strand users who relied on it as the default panel page | UX regression if the removal is not accompanied by the renderers | Ship renderers and removal in one change; the panel's normal empty state becomes the default |


# Hardware Engineering — M1–M3 implementation report (document rendering)

**Task:** `docs/tasks/hardware-engineering-full-impl-code-spec.md`
**Scope delivered:** §3 Phase A (DSH document MDI integration), §4 Phase B
(schematic), §5 Phase C (PCB), §6 Phase D (STEP/STP), §7 Phase E as it applies
to reading those documents.
**Not delivered:** Phase G/J orchestration work (M4, M5, M6). Status and blockers
in §7 below — they are listed rather than half-built.
**Repositories touched:** `dsh-pcb-eda` only. `deepseek-harness` was inspected and
**not modified**.

---

## 1. The finding that shaped the implementation

DSH already exposes a plugin extension point for document rendering, and it is
sufficient as published. Nothing in the harness had to change:

| Claim | Evidence |
|---|---|
| A plugin can add a renderer for a file suffix, ranked above the built-in text preview | `packages/client/ui-sidebar-documentpreview/src/client/document/registry.ts:41-54` (external band = 1, builtin = 0) |
| Suffix matching is case-insensitive | `…/document/suffix.ts:11-36` (`normalizeSuffix`, lowercased filename) |
| A renderer body receives the file's bytes, the path's resource address, and the tab lifetime | `…/document/contract.ts:17-46`, `…/TextPreview.tsx:381-386` |
| The built-in text type claims every workspace file, so no new tab type is needed | `…/definition.ts` (`kind: 'text'`, `priority: 'fallback'`) |
| Reload/revision is owner-driven and reaches the renderer as new content | `…/face.ts:167-193`, `…/TextPreview.tsx:210-218` |

Verified at runtime against the real registry, not a copy of the rule
(`node --import tsx` against the harness source, definitions shaped exactly as
this package registers them):

```
a/main.kicad_sch   -> schematic(bytes-complete) | text(text-pages)
a/MAIN.KICAD_SCH   -> schematic(bytes-complete) | text(text-pages)
a/board.kicad_pcb  -> pcb(bytes-complete)       | text(text-pages)
a/enclosure.step   -> step(bytes-complete)      | text(text-pages)
a/enclosure.STP    -> step(bytes-complete)      | text(text-pages)
a/notes.md         -> text(text-pages)
```

The text view stays in the candidate list on purpose: the document toolbar shows
a viewer menu when more than one implementation matches, so "look at the raw
S-expression" remains one click away. Nothing about the MDI shell, the explorer,
the right panel layout or the other renderers changed — the four registrations
are additive entries in a registry that already dispatches per suffix.

**Deliverable required by §16 ("for each DSH modification, explain why the
plugin mechanism was insufficient"):** there is no DSH modification. The
mechanism was sufficient; the smallest reusable change was none.

---

## 2. What was added

All of it inside `@huaqiu/dsh-hardware-ui`, which the bundle already ships, so no
new plugin row, no new bundle entry and no new dependency graph edge:

```
packages/dsh-hardware-ui/
├── src/index.ts                       # node half: serves the STEP reader wasm
├── src/shared/occt-asset.ts           # the one route/file name both halves agree on
└── src/client/
    ├── index.ts                       # installs the document renderers (existing entry)
    └── document/
        ├── contract.ts                # structural view of DSH's document seats
        ├── paths.ts                   # dsh-resource address → path; child-sheet resolution
        ├── sheets.ts                  # declared child sheets, never siblings
        ├── mount.ts                   # schematic/PCB mount lifecycle
        ├── step.ts                    # STEP/STP tessellation + 3D scene
        ├── EcadBody.tsx               # schematic + PCB document body
        ├── StepBody.tsx               # STEP/STP document body
        ├── copy.ts                    # zh_CN strings for these surfaces
        ├── occt.d.ts                  # ambient types for occt-import-js
        └── index.ts                   # definitions + body registration
```

| File | Responsibility | Why it exists separately |
|---|---|---|
| `document/contract.ts` | Types for the document seat | DSH's client packages are not installed in this repo; the sibling plugins declare the same seams structurally. Every field cites its harness source, so drift is a compile error here. |
| `document/paths.ts` | Address parsing, `..` collapse | Pure string arithmetic; testable without a browser, and the only place that knows the address grammar. |
| `document/sheets.ts` | Child-sheet discovery | Encodes the one rule that matters: declared, not adjacent. |
| `document/mount.ts` | Abort/deadline/dispose for 2D | Kept separate from `../ecad.ts` (the artifact viewer's adapter) as §5.3 requires; they differ in content source and in lifecycle guarantees, not in parser or renderer. |
| `document/step.ts` | STEP → triangles → Three.js | New capability, no prior art in this repo. |
| `EcadBody.tsx` / `StepBody.tsx` | State, error rendering, sheet disclosure | One component for sch+pcb (they differ in three strings), one for 3D (a different lifecycle). |

### 2.1 Registration shape (the whole integration, in six lines)

```ts
ctx.effect(() => ctx.documentPreviews.register({
  id: '@huaqiu/dsh-hardware-ui/document/schematic',
  extensions: ['kicad_sch'],
  priority: 'extension',      // ahead of the built-in text view
  title: () => COPY.viewer.schematic,
  loading: 'bytes-complete',  // the parser needs the whole file; the owner reads it
  wrap: false,
}), 'hardware-ui: document …')

ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
  name: 'sidebar.right.tab.document', key: '<same id>', inject: () => ({ kind: 'schematic' }),
}, EcadBody)), 'hardware-ui: document body …')
```

Installed through a nested `ctx.inject(['documentPreviews'], …)`, so a Host
without the document service loses the ECAD previews and keeps the product
panel, instead of the whole plugin parking (`src/client/index.ts`).

### 2.2 STEP: the strategy chosen, and why

**Direct browser parsing with `occt-import-js@0.0.23` (OpenCascade→WebAssembly).
No host-side conversion, no cache.**

- The `.step`/`.stp` file stays the only authoritative artefact; nothing is
  derived, so §6.3's cache-invalidation requirements (revision keying, partial
  output, cleanup, cancellation) have no subject.
- Offline by construction: the 7.6 MB `.wasm` is a build artefact of a declared
  dependency and is served by this plugin's own node half from
  `/hardware-ui/assets/occt-import-js.wasm`. No CDN, no download at runtime
  beyond that one same-origin request.
- Consistent with §12.2 ("use the existing Three.js dependency"): the reader
  produces triangles, Three.js draws them.

Rejected alternatives and their reason: `kicad-cli pcb export glb` is
`.kicad_pcb`-only (export-only for STEP, never an import); GLTFLoader cannot read
STEP; a host-side converter would need a native OpenCascade binary, i.e. exactly
the daemon dependency §12.3 forbids.

**Costs, stated rather than hidden** (§16 asks for version, footprint, offline
behaviour, Windows compatibility):

| | |
|---|---|
| Version | `occt-import-js@0.0.23`, pinned exactly |
| Runtime footprint | 96,871 B glue (bundled into `lib/client.js`) + 7,604,031 B `.wasm` (served, cached `private, max-age=86400`) |
| Offline | Yes. Both files ship in the package; the wasm is read from the installed dependency at boot, not fetched from a network. |
| Windows x64 | Pure WebAssembly + JS, no native module, no path assumptions; the wasm is served over the existing loopback HTTP server. |
| Licence | LGPL-2.1 (OpenCascade). `§17` states licence compatibility is not an implementation gate; the licence texts remain in the dependency. |
| Known limitation | `ReadStepFile` is a **synchronous** wasm call: a pathological model blocks the main thread while it tessellates. Bounded by a 32 MB size gate; there is no mid-parse cancellation to implement because the call cannot be interrupted. |

---

## 3. Lifecycle: how each requirement is met

| Requirement (§3.4, §3.5) | Implementation |
|---|---|
| Same document twice → no duplicate tab | Untouched: DSH's own `contentId = address` identity and `findPaneContentTab` reuse. |
| Different files independently addressable | One body instance per tab; state is per component, never keyed by path. |
| Tab switch never shows stale content | Bodies unmount on tab switch (the text type is not `keepMounted`), so each mount is fresh; `EcadBody` rebuilds when `content.data` changes identity. |
| Externally changed file refreshable | Owner-driven: the text type's metadata watch flips a "changed" banner and reloads on request or automatically; the new bytes arrive as a new content object. |
| Resources disposed on close/replace | `dispose()` on the effect cleanup, plus abort of the mount's `AbortController`; the renderer's own `dispose()` does not remove the canvas, so `mount.ts` removes it explicitly. |
| Old revision never overwrites a newer one | Every step after an `await` re-checks the signal; a render that settles after the deadline or after abort is **disposed**, never attached (`mount.ts` `withinDeadline`). |
| Renderer errors stay in the document | Both bodies render `role="alert"` inside the tab; nothing is thrown to the shell. |
| Cancellation / timeout | 30 s default deadline per mount, abort on tab close, and no timer-based failure for layout (a collapsed panel waits instead of erroring). |

A zero-sized host was the one real trap: the ECAD renderer fits the view during
`load()` against the canvas it is given, so mounting into an unlaid-out box fits
to nothing. `waitForLayout` holds the mount until the box is measurable and ends
only on abort — a tab restored into a collapsed panel shows the loading line
until it is expanded, which is the truth, rather than an error the user has to
dismiss.

---

## 4. Phase B specifics: child sheets

The renderer takes one schematic document (§4.2). KiCad's hierarchy is expressed
as `sheet` nodes whose `Sheet file` property names the child, so discovery reads
exactly that and nothing else:

- **Declared, never adjacent.** A directory of unrelated `.kicad_sch` files
  yields zero children (`sheets.ts`, tested).
- **Resolved against the owning document**, with `..` collapsed and drive/absolute
  references preserved (`paths.ts`, tested).
- **Existence is the Host's answer**, probed with a one-byte workspace read per
  reference — the preview does not stat or list a directory to decide what the
  workspace contains.
- **Nothing is merged.** The child sheets are listed under the drawing with a
  readable/missing marker. Merging would require translating child coordinates
  through sheet transforms (rotation included) and is explicitly not a
  prerequisite; the disclosure is the honest minimum.

`EcadBody` discloses the list only after the picture is up, so a slow probe never
delays the render the user asked for.

---

## 5. Phase E specifics: file identity and access

- The client never constructs a filesystem read from a path it invented as a
  *substitute* for identity: the document arrives through DSH's own
  `dsh-resource://file/…` address, resolved and authorized by the Host.
- The only extra reads are child-sheet probes, issued through the session's own
  `workspaceFiles.readBytes` (the same endpoint the text preview uses), one byte
  each, abortable — no new HTTP surface, no artifact registry, no
  `.hardware-engineering.json`.
- The one route this package adds serves a **build artefact**, not workspace
  content: no request parameter reaches a path, GET/HEAD only, `application/wasm`,
  immutable bytes.

---

## 6. Verification performed

| Check | Result |
|---|---|
| `pnpm --filter @huaqiu/dsh-hardware-ui typecheck` | clean |
| `pnpm --filter @huaqiu/dsh-hardware-ui build` | 2 bundles, client 5.39 MB (was 5.26 MB) + occt glue |
| Package unit/integration tests | **92 passed** (9 files): 42 existing, 50 new (`document-*`) |
| Dispatch against the real harness registry | four extensions resolve to the new renderers, uppercase included, text retained as alternative |
| Live web profile (`pnpm launch-dsh:standalone`) | boots with **no** activation warning; plugin row active |
| `GET /hardware-ui/assets/occt-import-js.wasm` on the live server | `200`, `application/wasm`, `7,604,031` bytes, valid `\0asm` header |
| Served client bundle contains the four registrations | yes (`document/schematic`, `document/pcb`, `document/step`, and the wasm route) |
| Existing product behaviour | untouched tests (42) still pass; product tab, settings and artifact viewer code unchanged |

Workspace-wide state, for honesty about what "green" means here: `pnpm -r typecheck`
and `pnpm -r test` already fail on `master` for five packages this change does not
touch — `dsh-ui-theme-huaqiu` (its `@deepseek-ai/cordis` `.d.ts` chain imports
`.ts` specifiers), `dsh-analytics`, `dsh-kicad`, `dsh-pcb-initial-placement`,
`dsh-plugin-log`, `dsh-tool-symbol-footprint`, and `dsh-huaqiu-about` (a `test`
script with no test files). None of them depends on `@huaqiu/dsh-hardware-ui`, and
none of their sources or dependencies were modified.

New tests, by file:

| File | Claims |
|---|---|
| `test/document-paths.test.ts` (13) | address grammar, percent decoding, `..` collapse, drive paths, traversal kept visible |
| `test/document-sheets.test.ts` (7) | declared-only discovery, dedupe, old `Sheetfile` spelling, malformed input tolerated |
| `test/document-registry.test.ts` (9) | three definitions and three bodies under matching ids, injected kind, effect labels, no-op without the seats, full unregistration |
| `test/document-mount.test.ts` (6) | canvas attach/removal, double dispose, parse failure typed, pre-aborted mount paints nothing, late render disposed after timeout |
| `test/document-step.test.ts` (8) | canvas attach/removal, empty/oversized/no-geometry rejection, wasm failure surfaced and cache cleared, single reader instance |
| `test/document-body.test.tsx` (7) | loading → rendered, in-document `role="alert"` on a bad file, sheet disclosure, no hierarchy claimed for a flat sheet, BOM-aware UTF-8 decode |

**What was not verified, and cannot be claimed:** a headless walk of the real UI
(opening a file from the explorer and screenshotting the drawing). No browser
fixture is provisioned in this environment; the dispatch proof above substitutes
for it at the registry level, and the live server proves the host/client halves
load. §15's UI-level cases remain open until that walk is run.

---

## 7. Phases not implemented (M4, M5, M6) — status and blockers

These are reported rather than partially built, because each one is a decision
this repo cannot make alone.

### M4 — agent-driven fabrication preparation

**Blocker: the existing order contract cannot express a file-based package.**
`place_pcb_order` / `place_smt_order` (`packages/dsh-tool-quote/src/tools.ts:295-348`)
do not take paths at all: they ask the EDA host to prepare artefacts from the
board currently open in KiCad and to open its own order dialog. That path
requires the HQ Edge runtime and an open editor — both of which §2.1 and §12.3
forbid. A kicad-cli export pipeline therefore needs a **new** order-capable
backend call that accepts a prepared package; the quote backend contract
(`hq.fab.v1.QuoteService`) has no such method to reuse, and inventing one is out
of scope for an implementation task.

Also unresolved by evidence: this machine has no `kicad-cli` (KiCad is installed
as an app bundle without a CLI on `PATH`), so export behaviour, exit codes and
file names could not be observed. Writing an export tool against assumed argv
would violate §9.4's "use the installed KiCad CLI version and supported export
options rather than hardcoding assumptions".

### M5 — Huaqiu ordering page in the MDI

**The MDI already has the capability; wiring it is blocked behind M4.**
`@deepseek-ai/dsh-client-ui-sidebar-browser` registers a `browser` tab kind whose
params accept a URL (`packages/client/ui-sidebar-browser/src/client/index.ts:32-37`,
`definition.tsx:16-27`), and `ctx.sidebarRight.openTab('browser', { params: { url } })`
opens it as a normal MDI tab. So §9.9 needs **no new web-document renderer**.

What is missing is a URL worth opening: the only current producer is the legacy
`place_*_order` hand-off, which returns a URL *after* the KiCad dialog flow. Wiring
the automatic tab-open to that tool would connect the new architecture to the
runtime §12.3 removes. The correct order is M4 → then the tab-open, as one small
client contribution.

### M6 — bundle and installer

Not attempted: it is the release step (desktop branch build, Windows x64 install,
upgrade and offline verification) and depends on M4/M5 being complete. The local
`link:` overrides are unchanged by this work.

---

## 8. Known limitations

1. **No cross-sheet rendering.** Child sheets are listed, not drawn. A schematic
   whose entire content lives in children shows an empty root page plus the list.
2. **STEP parsing blocks the main thread** for the duration of the wasm call
   (bounded to 32 MB input). A worker would remove this, and is a contained
   follow-up: `step.ts` already isolates the reader behind one function.
3. **STEP requires the Host's HTTP server.** On an Electron `file://` build the
   route is absent and the body reports the reader as unavailable; a
   `dsh-resource://`-based asset provider would be the fix if that build matters.
4. **No live ECAD editing or IPC** (per §4.3/§5.3, by design).
5. **Renderer theme is the renderer's own.** The 2D canvas draws its own palette
   on a themed backdrop; no attempt was made to re-skin a shared package.
6. **The wasm is fetched per page load**, not per document, and cached by the
   browser for a day.
7. **`client.js` grew to 5.39 MB** (from 5.26 MB) because the reader's JS glue is
   bundled; the 7.6 MB wasm is not in the bundle.

---

## 9. Files changed

```
packages/dsh-hardware-ui/package.json            + occt-import-js 0.0.23 (dependencies)
packages/dsh-hardware-ui/tsdown.config.ts        + bundle the reader glue
packages/dsh-hardware-ui/src/index.ts            node half: wasm route (was a no-op)
packages/dsh-hardware-ui/src/shared/occt-asset.ts          new
packages/dsh-hardware-ui/src/client/index.ts     install the document renderers
packages/dsh-hardware-ui/src/client/document/*             new (10 files)
packages/dsh-hardware-ui/test/document-*.test.*             new (6 files)
pnpm-lock.yaml                                   dependency edge
```

Nothing outside `dsh-pcb-eda` was touched. `git status` in `deepseek-harness` is
clean.

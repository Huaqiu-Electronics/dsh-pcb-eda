# Backplane local source study — Hardware Engineering Artifact Viewer POC

**Date:** 2026-11-23  
**Status:** Completed read-only source audit; no Backplane source was modified  
**Spec:** `docs/tasks/hardware-engineering-artifact-viewer-poc.md` §2 and §10  
**Companion reports:** `docs/research/hardware-engineering-ux-source-audit.md`, `docs/m1/hardware-engineering-artifact-viewer-poc-report.md`

## 1. Provenance and scope

| Item | Observed value |
|---|---|
| Local repository | `/Users/admin/code/Backplane` |
| Local HEAD | `4e101f36a71462ebce8054897937987ded342981` |
| HEAD date | 2026-11-19 20:10:54 -05:00 |
| Working tree at audit time | clean |
| Spec reference commit | `e76a59bc2243befa5795a95a83ec1962b7574d34` |
| Is the reference commit present locally? | **No** (`git cat-file -t` fails; it is not an ancestor of HEAD) |

This is a study of the **actual checkout**, not a claim that it is byte-identical to the commit named in the task. Where the checkout has moved materially beyond the spec's description, that drift is called out explicitly.

The audit covers the spec's Backplane topics: viewer architecture, schematic/PCB/3D paths, BOM, artifact selection, native launch, IPC, CAD settings, agent context, order integration, and useful fixtures. It then translates the evidence into DSH package responsibilities, blockers, an implementation sequence, and a POC test matrix.

## 2. Executive conclusion

The core architectural lesson of the local Backplane checkout still matches the task:

> Keep artifact discovery, compact rendering data, viewer state, and native-editor launch separate. Native files remain authoritative; the viewer is a read-only projection.

The local checkout has, however, moved beyond the spec in one important way: it now supports **embedded KiCad/FreeCAD editors** in a GPUI pane (`docs/embedded-editors.md`, `native/gpui/src/viewers/kicad_pane.rs`). That is explicitly a non-goal of this DSH POC. DSH should borrow the deterministic discovery, viewer-key, detached-launch, BOM, settings, and agent-environment patterns, **not** the embed architecture.

The most valuable details for DSH are:

1. a viewer key names the exact displayed artifact (`<kind>|<root>|<file>`), and Open in KiCad consumes that key — not a fresh default lookup;
2. project resolution is explicit (`.backplane.json`), then root `.kicad_pro`, then shallow discovery with copy-folder penalties;
3. boards are filtered by project ownership before being offered, and the default board is placed first;
4. schematic sheets are resolved from the root file's sheet references, not inferred from every `.kicad_sch` in the folder;
5. BOM is derived from parsed schematic symbols and hierarchy, with DNP/`in_bom` from the source fields;
6. STEP/GLB use a staged, cached conversion pipeline; the `solidread` PCB-GLB path uses the selected `kicad-cli`, while a separate native `pcb3d` mesher exists but is not the DSH POC path;
7. the selected CAD runtime is exposed to agents through prompt context, a scoped environment variable, and PATH shims;
8. IPC is deliberately stronger than this POC needs and must not be copied wholesale;
9. one free-form `kicad.path` setting accepts either a CLI file or an installation folder, and discovery expands the folder into the known CLI layouts;
10. the current artifact is not exported as an agent environment variable — it lives in the viewer key and prompt text, while the scoped environment names only the selected runtime;
11. local BOM grouping is **narrower** than the task prose claims: only value, footprint, MPN and DNP are grouping keys, not manufacturer or arbitrary custom fields.

## 3. Viewer architecture and rail

### 3.1 Local evidence

`docs/viewer-rail-map.md:5-23` inventories a GPUI right rail with Board, Schematic, 3D, Gerbers, Simulation, Split, Mech, Files, Diff, Review, Browser, Terminal and Commands. Each design viewer has its own header controls and explicit loading/empty/error states.

`native/gpui/src/screens/viewer.rs` is largely a pure interpreter of hub-provided view JSON:

- `view_kind`, `close`, `rail_command` (lines 23-33) map rail presses to idempotent `view` actions.
- `kicad_open(viewer)` and `shown_key(viewer)` (lines 55-63) send the key of the artifact currently drawn; a split uses the first non-empty pane key.
- `kicad_open_label` (lines 64-72) changes the label when the design lives on another machine.
- `kicad_offer` (lines 73-81) chooses between an in-pane editor and a detached editor.
- `edit_design` (lines 92-98) restricts KiCad editing to Board, Schematic and 3D pages and only while that page has its own document.
- `solid_ready` (lines 133-135) refuses to show a model unless the model key equals the requested key — an explicit stale-content guard.
- `shown(kind, path)` (lines 140-147) maps `viewer_show` paths to page kinds, including `.step/.stp/.glb` → `mech`.

`native/host/src/present/viewer.rs:97-100` constructs the source key:

- `0|<root>|` = board;
- `1|<root>|` = schematic;
- `2|<root>|` = 3D;
- `split|<root>|` = split.

`native/host/src/kicad/watch.rs:73-76` uses the same `kind|root|path` form and adds kinds `3` (bare 3D) and `4` (full outer-copper 3D). This key format is a code contract; it is not stated in `docs/`. `native/host/src/kicad/plot.rs:89-104` wraps the compact chunks in a CBOR frame keyed by that string and supports chunk reuse/deltas at lines 66-75.

`page(...)` at lines 476-485 appends the selected sheet or explicitly opened file to that key. `boards_menu`/`view-board` at lines 315-350 and `sheet_action` at lines 443-454 keep board and sheet selections in session drafts.

### 3.2 Drift and DSH decision

The rail map itself records inconsistencies: `Open in KiCad` leaked onto Files/Review/Mech/Browser (line 48), stale errors persisted after refused views (line 49), and a board-only project could trigger a "create board?" modal (line 51). Later code (`edit_design`, `page_document`) tightens the rule to design pages with an existing document.

**DSH decision:** use the stricter rule from the start. Show **Open in KiCad** only on Schematic, PCB and PCB 3D, and **Open in SolidCraft** only on Mechanical 3D. Keep the key in the DSH store/tab params and pass the exact artifact to the host. Do not port Gerbers, Simulation, Split, Diff, Review or embedded editors in this POC.

## 4. Project, board and sheet discovery

### 4.1 Local evidence

`native/host/src/kicad/project.rs`:

- `Files` holds canonical `pro`, `pcb`, `sch` and all discovered projects (line 7).
- `copies` (lines 10-12) penalizes folders beginning with `archive`/`build`/`output`/`export`, containing `backup`, or named `old`, `out`, `tmp`, `temp`, `staging`, `scratch`, `renders`.
- `found` (lines 14-28) walks up to four folders deep, skips hidden folders, `node_modules`, `*-backups`, sorts by copy flag then depth then path, and truncates at 50.
- `read` (lines 85-105) gives `.backplane.json` keys `project`, `pcb`, `schematic` precedence; otherwise a root `.kicad_pro`; otherwise the shallowest discovered project. A sibling file with the project stem wins for board/schematic over an arbitrary extension match.
- Tests at lines 113-141 pin all of these behaviors, including Windows path joining.

`native/host/src/kicad/boards.rs`:

- `own` (lines 21-23) counts a board as project-owned only when a `.kicad_pro` sits beside it and it is outside copy folders.
- `pick` (lines 25-33) presents owned boards first, puts the default board first, then non-copy boards, then every board; the list is capped at 24.
- `find` (lines 35-49) walks five levels, prunes hidden/`node_modules`/`extra`/`mfg`, excludes `_autosave-*` and `*backup*`, sorts, and caps at 2,000.
- The test at lines 57-68 explicitly asserts that a repository containing only board fixtures has no project-owned boards.

`native/host/src/kicad/plotread.rs:116-139, 199-241` resolves schematic sheets from the root file's `sheet` forms, builds a pre-order sheet tree, caps it at 4,096 rows and 64 files, and marks loops without expanding them.

`docs/mechanical-model.md:1-41` adds an optional `mech` key in `.backplane.json` to pick the default mechanical model; it prefers assembly-named models, then the sorted first model, and an explicit user selection wins. The local code confirms the split: `native/host/src/files/scripts/mech_list.sh` enumerates `mech/` to depth 4 for `*.step/*.stp/*.glb/*.png` with `cksum`, while `native/host/src/files/misc.rs:160-162` reads the `mech` config key as the primary part. `native/host/src/kicad/canonical.rs:87-99` defines which extensions count as design files and which scratch names are excluded.

### 4.2 DSH decision and gap

The implemented DSH service already uses `.hardware-engineering.json` with `project`, `schematic`, `boards[]`, `mechanical[]` (`packages/hardware-artifacts/src/service.ts:93-95, 307-349`) and returns `selection-required` rather than picking the first ambiguous project (`service.ts:332-347`). It excludes common build/archive directories (`service.ts:98-101, 114-138`).

Two Backplane behaviors are not yet matched:

- `projectFrom` treats every `.kicad_sch` beside the project as a sheet (`service.ts:367-371`); it does not follow the root's sheet references. A flat design with unrelated sheets can therefore be conflated.
- Boards are not ranked by project ownership; only the manifest order or sorted walk order is used (`service.ts:360-362`).

**Required next change:** add a root-sheet hierarchy resolver and an "owned board first, default board first" rank to `hardware-artifacts`. This is a small, local addition; do not import Backplane's Rust modules.

## 5. Schematic rendering

### 5.1 Local evidence

`native/host/src/kicad/schematic.rs:1-3` describes the parser: every `.kicad_sch` form becomes the same `Item`/`Prim` shape used by the board parser, with KiCad UUIDs as keys and connected groups tagged on each sheet.

Layer indices (lines 11-14) cover page, sheet/body fills, body, pin, pin name/number, fields, bus, wire, no-connect, junction, local/global/hierarchical labels, sheet name/file/pin and DNP. `look` (lines 16-24) supplies per-layer colors and opacity.

The parser handles:

- symbol libraries from the file's own `lib_symbols` and multi-unit parts (`lines 153-178`);
- text/fields with stroke-font geometry and justification (`lines 43-67`);
- shapes including polyline, rectangle, circle, arc, bezier and text (`lines 111-129`);
- tinted fills (`lines 131-151`);
- connectivity tags and hierarchical sheet pins (`plotread.rs:116-171`).

`native/host/src/kicad/plotgen.rs:1-4` converts items into integer-micrometre pieces, sorts by `(layer, mode, width, bucket, key hash)`, and emits delta-coded varint chunks. `rank_of` and `piece` are at lines 45-70; stable parallel sorting and chunk hashing are at lines 124-187. This is a compact wire format for a client renderer, not an SVG screenshot.

### 5.2 DSH decision

Do not port this renderer. The spec already decided to use KiCad CLI/SVG or the existing schematic-generation infrastructure for the POC. Use Backplane only as evidence that:

- stable UUID-derived identity matters;
- sheet selection must alter the artifact key;
- layer visibility and explicit loading/error states are part of the viewer contract;
- a future interactive renderer can consume a compact drawing model rather than a page image.

`@huaqiu/ecad-renderer` and `@huaqiu/kicad-sexpr-parser` remain the DSH foundation (spec UPDATES).

## 6. PCB rendering

### 6.1 Local evidence

`native/host/src/kicad/board.rs:8-20` defines `Pt`, `Prim` (`Seg`, `Line`, `Circ`, `Poly`, `Tint`) and `Item { key, sig, layer, prim, info }`.

Supported forms include:

- 25 layer indices including copper, mask, paste, silk, courtyard, fab, user drawings, Edge.Cuts, via and hole (`lines 66-69`);
- stable key from `uuid`, then `tstamp`, then fallback (`lines 73-78`);
- tracks, arcs, graphic shapes, zones with filled polygons (`lines 94-113, 167-176`);
- pads, including custom pad primitives, drill holes and footprint transforms (`lines 121-165`);
- compact `info` strings carrying net, layer, width, reference, value and footprint (`lines 83-92`).

`plotgen.rs:200-219` builds a board plot; `plotgen.rs:17-43` supplies board, schematic and Gerber looks.

### 6.2 DSH decision

Keep `@huaqiu/dsh-tool-pcb-viewer` as the DSH PCB renderer; do not reimplement this parser. Backplane confirms that layer-aware primitives, stable item keys and compact chunks are the right model, but the DSH browser/Three.js implementation already provides the required 2D/3D behavior.

## 7. 3D paths

### 7.1 PCB 3D

`native/host/src/kicad/solidread.rs`:

- `is_step` accepts `.step/.stp` with either case (line 14).
- `revision` builds a cache name from device, inode, length, mtime/ctime and nanoseconds (lines 15-19).
- `cached` names board vs STEP vs full-board models by recipe and revision (lines 22-28).
- `glb_at` (lines 31-45) adds STEP caching by SHA-256 content, so equal parts in different worktrees reuse one mesh.
- `flags` (lines 71-78) shows the exact CLI arguments: `pcb export glb`, `--subst-models` or `--no-components`, plus pads, soldermask, silkscreen, and optionally tracks, zones and via cuts.
- `export` (lines 92-114) stages the output in a private directory and promotes it to the cache only on success.
- `read_streaming` (lines 148-160) refuses to show stale or oversized models and converts GLB bytes to compact triangle plots.

`native/host/src/kicad/pcb3d/` is a **separate** in-repo native mesher: it parses the board without `kicad-cli`, meshes layers on separate cores, and writes per-layer GLB (`mod.rs:1-8, 135-159`, `glbw.rs`, `parse.rs`). The `solidread` path above depends on the external KiCad installation's CLI. DSH should use the CLI path for this POC and not confuse the two implementations.

### 7.2 Mechanical 3D

`native/step2glb/step2glb.cpp` and `native/host/src/kicad/stepglb.rs` replace FreeCAD as the first choice with a native OpenCascade helper:

- `BACKPLANE_STEP2GLB=<path>`, `off`, or automatic beside-hub → FreeCAD fallback (`stepglb.rs:1-11, 87-95`);
- conversions run as direct child processes, never through a shell (`lines 158-165`);
- `NORMAL`/`FINE` meshing detail and staged atomic cache publication are at lines 55-84 and 38-53;
- FreeCAD discovery, including Windows install roots and macOS app bundles, is at lines 105-147.

### 7.3 DSH decision

For this POC:

- PCB 3D should call the configured `kicad-cli pcb export glb` with explicit arguments, stage output, and reuse the existing Three.js viewer.
- GLB mechanical files can be shown directly.
- STEP/STP requires a verified converter. Backplane's native helper is **not** portable into the DSH plugin; FreeCAD assumptions must not be silently mapped to SolidCraft.
- Cache by canonical path plus file revision, and guard against displaying the previous model after a source switch.

## 8. BOM

### 8.1 Local evidence

`native/host/src/kicad/bom.rs`:

- `Part` carries reference, value, footprint, MPN, manufacturer, custom fields, DNP, `in_bom`, library, sheet and unit (lines 6-10).
- MPN and manufacturer field aliases are explicit (`lines 58-60`); supplier fields include LCSC, Mouser and DigiKey.
- `insts` prefers project-specific `instances` and falls back to all (`lines 63-69`).
- `sym` reads properties, sets `dnp` and `inbom`, skips power symbols and `#' refs, and emits one part per reference/unit (`lines 70-80`).
- `parts` folds multi-unit parts and filters `in_bom` (`lines 147-152`).
- `group` groups by value, footprint, MPN and DNP (`cmp_key`, line 155), then orders lines by first reference (`lines 159-171`). Different MPNs therefore do **not** merge, but manufacturer and other custom fields are **not** grouping keys. This is narrower than task §2.5's claim that "the grouping identity includes component properties and custom fields".
- `places` records KIID and sheet path for findings (`lines 127-146`).

`native/host/src/kicad/bompanel.rs:1-11` adds the presentation path:

- live GUI KiCad reads through the embedded KiCad API (`GetOpenDocuments` with `DOCTYPE_SCHEMATIC`, then `GetItems` with `KOT_SCH_SYMBOL`) once per second, including unsaved edits (`lines 96-138`); this is not a separate IPC-polling module;
- otherwise saved root and hierarchical sheets are polled twice per second while a client has shown the project in the last 30 minutes;
- published lines include `refs`, `qty`, `value`, `footprint`, `mpn`, `mfr`, `fab` (LCSC), `dnp`, stock and cost.

### 8.2 DSH decision

Use the saved schematic as the only BOM source in this POC; no unsaved-editor synchronization. The DSH BOM table must include reference, quantity, value, footprint, manufacturer, MPN, custom fields, DNP and exclude-from-BOM. Use the existing `analyze_kicad_module` analysis where sufficient; if a second parser is needed, justify it against the field aliases and grouping rules above.

The Backplane live-IPC path is explicitly out of scope.

## 9. Open in KiCad and process launch

### 9.1 Local evidence

`native/host/src/kicad/open.rs`:

- `pick` chooses project manager for `.kicad_pro`, then PCB editor for `.kicad_pcb`, then schematic editor for `.kicad_sch` (`lines 12-16`). `open_in` still uses that fallback when no viewer key exists (`lines 76-80`).
- `program(cli, tool)` resolves `kicad`, `pcbnew` or `eeschema` beside the selected `kicad-cli`, with `.exe` on Windows (`lines 17-21`).
- `launch` uses explicit argv, artifact-parent cwd, null stdio, a new process group, and adopts/reaps out of the hub's threads (`lines 22-31`).
- `shown(key)` parses `<kind>|<root>|<file>` and opens the exact `.kicad_pcb` or `.kicad_sch` the viewer names; a 3D/mechanical model produces an explicit error rather than a fallback (`lines 86-103`).
- Tests at lines 186-199 prove exact-artifact behavior, including a board from another project and a STEP file rejection.
- `open(...)` uses the client's key or last viewer-state report, logs the outcome into the thread, and handles Altium separately (`lines 118-146`).

`docs/viewer-rail-map.md:11-13` shows the header controls: Board and Schematic carry `[Open in KiCad]`; 3D carries it as a floating top-right action. `docs/embedded-editors.md:11-29` describes the newer local behavior where a local window can embed the editor; a remote window still uses the detached `kicad-open` path and starts KiCad on the hub's machine.

### 9.2 DSH decision

Preserve the POC non-goal: separate native windows, no embedding. The DSH host must:

- accept an explicit `{application, artifactPath, projectPath?, kind}` request;
- validate the exact path exists and is workspace-authorized;
- resolve the executable from the configured installation, not from PATH by default;
- use explicit argv, artifact-parent cwd, `shell: false`, null/detached stdio;
- return an explicit error when the application is unconfigured, missing, or cannot open that artifact type.

The callers confirm this is a machine-side handoff: `native/host/src/present/screen.rs:584-586` turns the `kicad-open` UI action into `kicad.open {thread, key}`, and `native/host/src/kicad/watch.rs:770` invokes `open::open(...)`. The embedded path reuses the same executable resolver in `native/host/src/kicad/embed.rs:1409-1413`. No flag passes a `.kicad_pro` path or an IPC socket. The detached process has no API server, so `open.rs:33-47` records it per project and warns that an agent edit through the headless server will not appear in that window and could be overwritten by a later save.

The Backplane detached-launch code is a good behavioral reference; its embedded-editor machinery is not.

## 10. KiCad IPC

### 10.1 Local evidence

`docs/kicad-ipc.md:54-78` states:

- agents do not start their own KiCad;
- the hub runs one headless `kicad-cli api-server` per project;
- transport is NNG plus protobuf;
- `kserve.rs` owns per-project socket paths, argv, readiness, retry and eviction;
- `ipc.rs` is the actor;
- `kipc.rs`, `nng.rs` and `proto.rs` implement transport in-process, with no helper process.

Lines 89-104 give the compatibility gates, GUI/headless routing, and fork capability checks. `docs/embedded-editors.md:26-28` adds that when a GUI KiCad is up, IPC is routed to it and the headless server is shut down for that project. The transport is pure Rust: `kipy` is not used anywhere in the Rust hub, and no helper process is spawned. The minimum fork for IPC is `10.99.0-bp.4` / API 2, while the installed pin is newer (`bp.13` at this HEAD), so "minimum supported" and "installed by Backplane" are separate facts.

`native/host/src/kicad/ipc.rs:315-319` marks whether the selected CLI came from the setting, the environment, a managed install or PATH; `kserve.rs` caps the live server count and evicts the least recently used project. None of that machinery belongs in the DSH viewer POC.

### 10.2 DSH decision

No IPC server, `kipy`, Python environment, or managed KiCad fork is needed for this POC. The DSH viewer reads saved files and calls `kicad-cli` for exports. If live IPC is revisited, evaluate the existing Huaqiu KiCad fork's IPC implementation first, as the spec requires.

## 11. CAD settings and agent environment

### 11.1 Local evidence

`native/host/src/present/settings.rs:651-686` shows the CAD page:

- `kicad.path` is one free-form setting. The UI hint says "Path to KiCad's command line", but resolution accepts a CLI file **or an installation folder**: `native/host/src/kicad/ipc.rs:357-378` expands a directory into `kicad-cli`, `bin/kicad-cli` and macOS bundle candidates before testing the first existing file. The detected `kicad.status`, `kicad.version`, `kicad.cli`, library and install notes are displayed above the field, and `kicad-path` persists it (`settings.rs:668-671, 893`).
- An invalid configured path is passed over and the UI says which runtime is actually used (`lines 665-667`).
- Persistence is a `SettingSet` event in `events.jsonl`; detected paths, versions, status and IPC server state are runtime info, never a second settings file.
- `freecad.path` is the console executable (`freecadcmd`) path (`lines 669-673, 912`).
- `kicad.ipc` is an on/off setting (`line 676`).
- `viewer.board3d` chooses native vs `kicad-cli` board-model generation (`line 678`).
- The page also has managed install/update actions for KiCad and FreeCAD (`lines 569-641`).

`native/host/src/agents/kicadsel.rs` is the strongest pattern for the spec's agent-environment requirement:

- prompt, `BACKPLANE_KICAD_CLI`, and PATH shims are all derived from the same selected runtime (`lines 1-6`);
- version is read from the fork manifest or `--version`, with `ok`/`stock`/`old`/`broken`/`missing` states (`lines 55-78`);
- GUI shims refuse to open windows from agents (`lines 9-16, 111-132`);
- `select` returns prompt facts plus scoped env entries (`lines 137-156`);
- `job_env` prepends the shim directory to a child job's PATH without mutating the hub's global environment (`lines 148-156`).

`native/host/src/agents/prompt_text.rs` generated constants show the resulting agent text:

- `PROMPT_KICAD_BASICS` names the selected CLI and tells the agent to use only it (line 19);
- `PROMPT_KICAD_K`/`PROMPT_KICAD_HEALTH` carry explicit health states (lines 24-28);
- `PROMPT_PROJECT_K`/`PROMPT_PROJECT` name the canonical project files and `.backplane.json` override (lines 30-33);
- mechanical instructions are FreeCAD-specific (lines 14-18).
- the prompt names the canonical project files (`PROMPT_PROJECT_K`) but exports no variable for the currently viewed artifact; current selection lives in the viewer key and session drafts.

### 11.2 DSH decision

DSH should keep its `<hardware_environment>` block and scoped variables (`HUAQIU_KICAD_CLI`, `HUAQIU_KICAD_PCBNEW`, `HUAQIU_KICAD_EESCHEMA`, `HUAQIU_SOLIDCRAFT`) with no global `process.env` mutation. The useful additions from Backplane are:

- explicit health states per application, including "configured but invalid";
- deriving settings, launch paths, and agent context from one resolver;
- never allowing an unconfigured or invalid path to silently fall back to PATH.

Do not copy FreeCAD discovery or agent instructions: SolidCraft was not found in this checkout (`grep -i solidcraft` over `/Users/admin/code/Backplane` returned no files), and its invocation must be verified locally before any native handoff is claimed.

## 12. Order integration

`docs/order.md:3-5` says ordering is opt-out via Settings → Ordering and maps the legacy names to current modules under `native/host/src/settings/order.rs`, `order_view.rs`, `fab.rs` and `present/ready.rs`.

Key behaviors relevant to DSH:

- project intent lives in `.backplane/intent.md`; each orderable item has a measured `*.fab.json` (`docs/order.md:10-20`);
- `Buy it` appears in the thread header when there is something orderable (`lines 25-37`);
- a buy thread owns quote/status/ask tools, review gate, export approval and payment (`lines 44-67`);
- the quote is never charged until the person approves; the agent does not pay or provide payment details.

There is no dedicated SMT quote/place panel to imitate. `order/fabsrv/pricing.py:38-43` and `189-200` treat assembly as a property of a PCB fab line: `assembled`, `paste_top`, `paste_bottom`, `placed_top` and `placed_bottom` feed the manufacturing line and component pricing. Quote and Buy now are owned by the buy thread, not by a separate SMT surface.

**DSH decision:** keep the existing Huaqiu `quote_pcb`, `quote_smt`, `place_pcb_order` and `place_smt_order` tools as the backend. The Order destination only surfaces entry points and carries the selected board/BOM context. Do not build another pricing, quote, upload or payment flow, and do not expect a Backplane SMT UI to copy.

## 13. Useful local fixtures

The checkout has **no production-quality demo project**. There is only one `.kicad_pro`, and its own README says it is deliberately broken: `test/files/fixtures/broken-toplevel/README.md` documents a root-sheet UUID mismatch that made the embedded editor hang, and says "Do not save over this copy". It is useful as a negative fixture only. There is no `.backplane.json`, `.fab.json`, `intent.md`, or `mech/` directory in the fixture folders, and its root schematic's `Sheet File` fields are empty, so it cannot demonstrate hierarchy selection.

Usable pieces for a synthetic DSH workspace:

| Path | Useful for |
|---|---|
| `test/files/fixtures/broken-toplevel/complex_hierarchy.kicad_pro` / `.kicad_pcb` / `.kicad_sch` | negative fixture: deliberately mismatched root-sheet UUID; never save over it |
| `test/files/fixtures/broken-toplevel/ampli_ht.kicad_sch` | independent schematic for ambiguity testing |
| `test/files/fixtures/broken-toplevel/complex_hierarchy.kicad_sym` and `complex_hierarchy.pretty/` | symbol/footprint libraries for the same demo |
| `test/files/fixtures/plot/ecc83-pp.kicad_pcb` / `.kicad_sch` | matched board/schematic pair |
| `test/files/fixtures/plot/microwave.kicad_pcb` | second board for board-picker testing |
| `test/files/fixtures/mesh/bracket.step`, `cylinder_r3.step` | mechanical STEP sources |
| `test/files/fixtures/mesh/glass.glb`, `nodes.glb`, `thin.glb`, `wrap.glb` | direct GLB viewer sources |

For the task's §11 demonstration, copy selected fixtures into a temporary workspace, add a real hierarchical schematic from a KiCad demo (with non-empty `Sheet File` fields), add a `mech/` folder and a `docs/tasks`-specified `.hardware-engineering.json`, and add `.fab.json` only if the order entry points are exercised. Do not use the broken fixture as the canonical project and do not modify the Backplane checkout.

## 14. Package-level change plan for DSH

| Owning package | Change | Extension point / contract |
|---|---|---|
| `@huaqiu/hardware-artifacts` | Add root-sheet hierarchy resolution and project-owned board ranking. Keep explicit manifest/selection behavior. | Host service `hardwareArtifacts`; discovery result `selection-required`. |
| `@huaqiu/hardware-artifacts` | Add staged PCB GLB export using the configured `kicad-cli`; serve GLB bytes through a loopback-guarded route. | `ctx.subprocess`, `ctx.fs`, `ctx.webServer`. |
| `@huaqiu/hardware-artifacts` | Add explicit `application`, `artifactPath`, `kind` launch validation; keep shell-free spawn. | Existing `/api/v1/hardware/open`. |
| `@huaqiu/dsh-hardware-ui` | Replace the tab's path-only body with artifact-aware selectors; show loading, empty, unsupported and failed states; keep exact artifact identity in store/tab params. | Declared store; `sidebar.right.pane.tab` with `keepMounted: true`. |
| `@huaqiu/dsh-hardware-ui` | Re-host the existing PCB viewer and a schematic preview; add a BOM table from saved analysis. | Existing DSH slots/store; no new viewer framework. |
| `@huaqiu/dsh-hardware-ui` | Add native actions only on relevant destinations; disabled state when app is unconfigured. | `conversation.session.header.corner` / viewer toolbar action. |
| `@huaqiu/dsh-tool-kicad-schematic-gen` | Supply BOM fields and hierarchy from saved schematics; prove or extend `analyze_kicad_module`. | Existing analysis capability, `view: "bom"`. |
| `@huaqiu/hardware-engineering` | Keep the bundle as the only distribution entry point when new package versions are released. | `cordis.patch.yml`, exact-version dependencies. |

Do not add HQ Edge, a daemon, a Python runtime, a new project database, embedded native windows, or a second PCB renderer.

## 15. Implementation sequence

1. **Discovery hardening:** root-sheet traversal and owned-board ranking in `hardware-artifacts`; add regression fixtures from §13.
2. **Exact-identity viewer state:** carry `{projectPath, artifactPath, sourcePath, kind}` through store and tab params; add stale-content guards modeled on Backplane's `solid_ready`.
3. **PCB 3D and GLB:** staged `kicad-cli pcb export glb`; direct GLB route; explicit failure when no converter is available.
4. **Schematic and BOM:** CLI/SVG preview with sheet selection; BOM table from saved schematic analysis.
5. **Native handoff:** interactive verification of exact board/sheet opening; SolidCraft verification only on a machine where it exists.
6. **Order context:** pass selected board/BOM to existing quote/order entry points; preserve quote-versus-submit separation.

## 16. Blocker and risk register

| ID | Risk | Evidence | Mitigation |
|---|---|---|---|
| B1 | Spec reference commit absent locally | `git cat-file` on `e76a59b` fails | Report is explicitly based on `4e101f3`; do not claim reference parity. |
| B2 | Local checkout now embeds editors | `docs/embedded-editors.md:1-29` | Treat embedding as out of scope; use detached launch semantics only. |
| B3 | Sheet conflation in current DSH discovery | `hardware-artifacts/src/service.ts:367-371` | Follow root sheet references as in `plotread.rs`. |
| B4 | Board ranking weaker than Backplane | `service.ts:360-362` vs `boards.rs:21-33` | Prefer project-owned and default board first. |
| B5 | STEP conversion unresolved | `stepglb.rs` uses a native helper/FreeCAD, neither portable to DSH POC | GLB first; gate STEP until a verified converter exists. |
| B6 | SolidCraft assumptions unsafe | no `solidcraft` references in Backplane checkout | Verify actual executable and arguments locally; otherwise keep action disabled. |
| B7 | Live BOM IPC out of scope | `bompanel.rs:4-7` | Saved schematic only; explicit refresh. |
| B8 | Fixture set is not a product demo | Only one `.kicad_pro`, deliberately broken with mismatched root UUID; no manifest, fab file, `mech/` or usable hierarchy (§13) | Copy selected fixtures into a temp workspace; add a real hierarchical schematic, mechanical model and explicit manifest; never save over the broken fixture. |
| B9 | BOM grouping claim is broader than local code | Task §2.5 says custom properties are grouping keys; `bom.rs:155` uses only value, footprint, MPN and DNP | Follow local code for the POC; document any product decision to group more narrowly or more broadly. |
| B10 | Two PCB-3D implementations exist locally | `solidread.rs` calls `kicad-cli`; `kicad/pcb3d/` is a separate native mesher | Use the CLI path only in this POC; do not merge the two or claim the native mesher was reused. |

## 17. POC test matrix (Backplane-derived additions)

| # | Case | Expected result |
|---|---|---|
| T1 | One canonical project with matching board/schematic | Discovery resolves without a manifest. |
| T2 | Two projects, including `ampli_ht.kicad_sch` as an independent sheet | `selection-required`; no silent first match. |
| T3 | Two boards, one project-owned and one fixture/export | Owned board first; explicit board selector; exact path shown. |
| T4 | Root schematic with a referenced sub-sheet | Sheet selector follows the real hierarchy, not folder proximity. |
| T5 | Switch board or sheet, then Open in KiCad | Native editor receives the exact displayed path. |
| T6 | 3D page showing a mechanical STEP | Open in KiCad is unavailable; Open in SolidCraft follows the exact model. |
| T7 | PCB GLB export | Staged output is published only on success; source revision recorded. |
| T8 | Switch 3D source while a previous model is cached | UI shows no stale model; loading/failed state is explicit. |
| T9 | BOM with two parts sharing value/footprint but different MPN | Two grouped lines. |
| T10 | BOM with DNP and `in_bom: no` | DNP shown; excluded part absent from ordered BOM. |
| T11 | Configured but non-runnable KiCad path | Clear error; no PATH fallback; agent context says invalid. |
| T12 | Offline DSH boot with the bundle | No HQ Edge, no daemon, no Python dependency. |
| T13 | BOM lines with identical value/footprint/MPN but different manufacturer or custom field | One grouped line under the local Backplane rule; any product override must be explicit and tested. |

T12 is already covered by the activation evidence in `docs/m1/hardware-engineering-artifact-viewer-poc-report.md`. T1–T11 and T13 are the concrete next-phase acceptance tests derived from this Backplane study.

## 18. Final assessment

Backplane is a useful reference for **semantics**, not for code reuse. Its most transferable ideas are exact viewer identity, explicit artifact selection, saved-file BOM derivation, staged/cached model generation, and one selected CAD runtime shared by UI, launch and agent context. The local checkout's embedded-editor and rich-rail work should be deliberately excluded from this POC. Adopting the limited set above closes the remaining discovery and rendering gaps without violating the task's implementation boundaries.

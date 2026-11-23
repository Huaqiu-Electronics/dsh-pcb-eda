# Hardware Engineering artifact viewer POC — implementation report

Target: `docs/tasks/hardware-engineering-artifact-viewer-poc-impl-spec.md`
Repository: `C:\code\dsh-pcb-eda` (base commit `23fe1cc`, version `0.7.12`)
Date: 2026-11-23

## Result

P0–P7 are implemented and verified with unit tests plus one real-CLI run against the
locally installed KiCad 10.0.7. P8 is **partial**: packages build and their suites pass,
but no Desktop installer was rebuilt and no live Desktop/browser smoke was run, so the
distribution leg is unverified.

| Phase | Status | Evidence |
|---|---|---|
| P0 UI correction | done | `apply()` now registers 3 seats; no `conversation.session.header.corner`, no DFM, no mechanical destination |
| P1 discovery / identity | done | hierarchy from `Sheetfile` refs with cycle guard; owned-board ranking; 31 host tests incl. 6 discovery cases |
| P2 authorized source | done | `/source` route + boundary/realpath/type/size/revision checks; 6 read tests |
| P3 schematic + PCB render | implemented, browser-unverified | `ecad.ts` adapter on `renderSchematic`/`renderPcb`; bundle inlines renderer (client 5.08 MB) |
| P4 GLB export + 3D view | done (host), viewer browser-unverified | real `kicad-cli pcb export glb`: 951,344 bytes from `simple_led.kicad_pcb` |
| P5 BOM | done (host), populated-design unverified | KiCad-owned BOM projection, deterministic grouping, DNP/MPN separation, revision cache |
| P6 native handoff + settings | implemented, Desktop-unverified | viewer-scoped `Open in KiCad`; `settings.section` + config form |
| P7 Order Placing | done (entry points only, by design) | panel exposes existing tool calls, never constructs a URL or order |
| P8 packaging / report | partial | builds + tests green; installer rebuild and browser smoke NOT run |

## Per-phase notes

### P0 — product UI correction

- `model.ts`: `DESTINATIONS = ['schematic','pcb','bom','3d','order']`. `applicationFor`
  returns `kicad` for schematic/PCB/BOM/3D and `undefined` for order. `NativeApplication`
  is now `'kicad'` only.
- `components.tsx`: navigation renders five destinations; no mechanical selector; the
  3D destination selects a **board**, not a STEP model; `Open in KiCad` moved into the
  viewer header with the resolved artifact and the destination-specific kind
  (`pcb-3d` for 3D, `bom` for BOM).
- `index.ts`: registers `conversation.header.leading`, `sidebar.right.pane.tab`,
  `settings.section`. `conversation.session.header.corner` is gone — confirmed by
  `client.test.ts` asserting the exact seat list.
- The sidebar expand button was not touched; nothing in this package overrides slot
  chrome, so DSH's wrapper behaviour is unchanged.

### P1 — discovery, hierarchy, identity

- Root schematic is authoritative: manifest entry → `<project>.kicad_sch` → the only
  candidate. Unrelated sibling `.kicad_sch` files are never promoted to sheets.
- Child hierarchy comes only from `(property "Sheetfile" …)` references, resolved
  recursively with a visited-set cycle guard. Test data includes a cycle
  (`main → a → main`, `b`) and asserts a finite `[a, b]` result.
- Boards rank by ownership: manifest order → project-named file → shallower path →
  lexical. Multiple unowned boards produce `selection-required` and **no** default
  board (the old "take boards[0]" fallback is gone).
- Artifacts carry `id`, canonical `path`, `title`, `format`, `sourcePath`; `readSource`
  adds the content `revision` (sha256 of the saved bytes).

### P2 — authorized source read

`GET /api/v1/hardware/source?path=&revision=&cwd=` → `{ ok, path, kind, revision, bytes,
mtimeMs, text }`.

Validation order: absolute → extension (`.kicad_sch`/`.kicad_pcb`) → authorized root
boundary (lexical, before existence, so the route cannot probe paths) → existence →
`realpath` boundary re-check (symlink escape) → regular file → size cap (32 MiB) →
optional expected-revision match. Errors are structured:
`invalid-identity 400`, `unauthorized 403`, `missing-artifact 404`, `too-large 413`,
`unsupported-artifact 415`, `stale-revision 409`.

Known scope limit: a path is accepted when it is inside an authorized root and has an
allowed extension — it is not required to be in the discovered inventory. Tightening that
would break sheet selection right after a hierarchy change; the boundary is the security
property that matters here.

### P3 — schematic and PCB rendering

`ecad.ts` uses the documented main-thread API (`renderSchematic`/`renderPcb` with
`container` + `interactive`), not the renderer worker (the published worker protocol is
parser-only/stubbed). Abort is checked after fetch, after parse and after render; a late
result is disposed instead of attached.

Build config: those packages are `devDependencies` inlined via
`deps.alwaysBundle` (`@huaqiu/ecad-renderer`, `@huaqiu/ecad-viewer-app`,
`@huaqiu/kicad-sexpr-parser`, `immutable`, `jszip`, `three`, `three/*`). Without this the
ModuleLoader bundle left bare `require('three')` calls that the DSH client cannot resolve
(43 kB → 5.08 MB bundle, only `react` still external).

### P4 — GLB export and 3D viewer

- `POST /api/v1/hardware/glb` exports via explicit argv
  `[pcb, export, glb, --output, <tmp>, <board>]`, `shell:false`, 120 s default timeout.
- Output is validated (non-zero size + `glTF` magic) and renamed into the cache directory;
  the temp directory is removed in `finally`, so a timeout or abort leaves nothing behind.
- Cache key is `path:contentSha256`, so mtime-preserving edits still invalidate. Concurrent
  callers for the same revision share one `kicad-cli` run (`glbPending`).
- `GET /api/v1/hardware/glb-file?path=&revision=` serves the bytes with
  `model/gltf-binary` and `x-huaqiu-source-revision`; an unknown revision is `409`.
- Viewer (`glb.ts`): Three.js + `GLTFLoader`, bounds-fitted camera, drag-rotate/wheel-zoom,
  ResizeObserver, full disposal (listeners, RAF, geometries/materials, renderer).

Real-CLI evidence (KiCad 10.0.7, `C:\Users\yihuo\AppData\Local\Programs\KiCad\10.0\bin`):

```
glb: bytes=951344 revision=277f962230408ad0 cached=false
file: %TEMP%\hq-real-mO5WOp\.cache\glb\db1bdc67580e2dab\board-277f962230408ad0.glb
sha256: 51042D077C589C61DD8A22103AB0F2C539E0FC815601D8A7EF6C0D945AF4656C
```

### P5 — BOM

Evaluation of the spec's preferred path: `analyze_kicad_module` with `view: 'bom'` is
Cordis-context-bound and its BOM helpers are not exported from
`@huaqiu/dsh-tool-kicad-schematic-gen`, so a Host route cannot call it without reaching
into another plugin's internals or duplicating its analyzer. The implemented route reuses
**KiCad's own extraction instead** — `kicad-cli sch export bom` — which is the same
authoritative source that analyzer consumes, and performs only a projection:

- grouping identity = every column except `Reference`/`Quantity`, so different MPNs and
  DNP never merge (tested with two 10k resistors sharing an MPN vs a third with a
  different MPN, plus a DNP regulator);
- `references`, `quantity`, `value`, `footprint`, `dnp`, and remaining `fields`;
- cached by schematic content revision; `source: 'kicad-cli-bom'` is exposed so the UI can
  state where the table came from.

Unverified: a **populated** design. The real run used the KiCad 10 hierarchy template,
which contains no symbols, so the CSV parsed to 0 rows (correct for an empty schematic).
Grouping itself is covered by unit tests with a KiCad-shaped CSV.

### P6 — native handoff and settings

- Handoff is `spawn(command, [path], { shell:false, detached:true, stdio:'ignore' })` with
  the exact artifact: `.kicad_sch → eeschema`, `.kicad_pcb → pcbnew`,
  `.kicad_pro → kicad`. Missing artifact `404`, unsupported extension `415`, unconfigured
  editor `412`. SolidCraft has no native action.
- Settings section keeps the two installation roots and validates/saves through
  `ctx.configForms.get('hardware-artifacts')`; failures surface as text, not silence.
- Agent context: `<hardware_environment>` block lists only validated paths and the current
  project; `childEnvironment()` passes `HUAQIU_KICAD_*` to agent children and never
  mutates `process.env`. `configured` is false when the version probe fails, so the UI
  never claims an executable that does not answer.

### P7 — Order Placing

Entry points only: the panel shows the selected board, the BOM line count, and the exact
existing calls (`quote_pcb`, `place_pcb_order`, `quote_smt`, `place_smt_order`) with
`pcbPath`. No URL is constructed, no backend added, and no order is placed — confirmation
stays inside those tools.

## Verification matrix

| Check | Command | Result |
|---|---|---|
| Host unit/integration | `pnpm --dir packages/hardware-artifacts test` | 31 passed |
| Client units | `pnpm --dir packages/dsh-hardware-ui test` | 8 passed |
| Bundle integrity | `pnpm --dir packages/hardware-engineering test` | 16 passed |
| Types (host) | `pnpm --dir packages/hardware-artifacts typecheck` | clean |
| Types (client) | `pnpm --dir packages/dsh-hardware-ui typecheck` | clean |
| Client build | `pnpm --dir packages/dsh-hardware-ui build` | 5.08 MB bundle, only `react` external |
| Bundle build | `pnpm --dir packages/hardware-engineering build` | 8.86 kB |
| Real kicad-cli | ad-hoc script against KiCad 10.0.7 | install/version/GLB/hierarchy ok |

Not run: Desktop installer build, Electron/browser smoke, published-package install,
`verify-product-use` (pre-existing failures in this repo).

## Deviations and open items

1. **BOM source** — KiCad CLI projection instead of `analyze_kicad_module` (rationale above);
   populated-design output still to be eyeballed.
2. **Renderer worker** — main-thread API only; the worker protocol remains unusable
   upstream, as the renderer README states.
3. **3D** — GLB from the saved `.kicad_pcb`; `mechanical[]` stays agent context only.
4. **Source authorization** — boundary + type, not inventory membership.
5. **Distribution** — `dsh-hardware-ui` and `hardware-artifacts` changed but stay at
   `0.7.12`; publishing new versions and bumping the Desktop pins is a separate release
   step. Building the installer now would ship stale npm artifacts.
6. **Settings in Desktop** — the config-form path is unchanged from the previous POC and
   was not re-verified in a live Desktop.
7. **License notice** — the renderer's MIT notice is inlined into the client bundle via
   its module; a third-party notices pass was not re-run.

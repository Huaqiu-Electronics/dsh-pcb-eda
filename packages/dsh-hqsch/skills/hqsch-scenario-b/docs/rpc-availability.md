# RPC availability (scenario-b engine build)

Use this table instead of trial-and-error. **Do not build flows on unimplemented
or hollow APIs.** Comprehension toolbox = `kernel.GetSnapshot` + `netList.*`.

## Client / build alignment

Scenario-b scripts assume a **current** `@huaqiu/huaqiu-client` (Connect-ES) build
generated from the same proto set as this skill’s RPC docs (e.g. `PlacePinStubWireAndNetAlias`,
`PlaceTextRequest`, `SetPageSize`). If TypeScript reports **`… is not a function`**
on `client.objPlace.placePinStubWireAndNetAlias` (or similar), **upgrade the client /
regenerate TS from proto** — do not treat it as “engine unimplemented”. Optional
manual check from `template/`: `npx tsx scripts/probe-rpc.ts`.

**Newest RPCs — client may lag the engine.** `@huaqiu/huaqiu-client@0.1.9`
(→ `@hqedge/connect@0.2.8`) does **not** yet contain these two; the engine does:

| RPC | Missing-client symptom | Behaviour in this template |
| --- | --- | --- |
| `export.ExportSchematicPdf` | `exportSchematicPdf is not a function` | `export-layout-pdf.ts` detects it and exits with an upgrade hint — do P4b with `layout-audit.ts` numbers only, and tell the user PDF needs a client upgrade |
| `canvasOps.ListPageDecorations` | method absent | `deleteAllPageDecorations` falls back to the ledger, then to `selectAll` + `getSelectedObjectsJson` (see `decoration-objects.md`) — frames/titles are still deletable |

Do **not** hand-write a Connect service descriptor to reach an RPC the installed
package lacks; upgrade the package instead.

Measured against a live HQ EDA build used with this skill. Status can change
across builds; when in doubt, prefer the ban list below over optimistic use.
You do **not** need to call `GetCapabilities` on every task — keep this table
as the default map.

## Decorations (module rect / free text)

| Path | Status | Agent use |
| --- | --- | --- |
| **A — `objectId` ledger at place time** | **Now** | After `placeRect` / `placeText`, call `recordDecoration` (`modular-lib.ts`) or keep ids in script; delete via `deleteObjectsByIds` |
| **E — `listPageDecorations`** | **Works (engine)** — absent in client ≤ 0.1.9 | Active-page rects + free text (excludes NetAlias); ext box Y down; use when ledger lost or user drew manually. Call through `deleteAllPageDecorations` so the ledger / `selectAll` fallbacks apply |
| `GetSnapshot.labels[]` | Misleading | NetAlias only — **not** module `PlaceText` |
| `getPageOccupancy` | No | Parts/symbols (+ optional wires) — **no** rect/text |

See `decoration-objects.md`.

## Performance baselines (order-of-magnitude, not SLA)

| Operation | Typical range |
| --- | --- |
| `kernel.GetSnapshot` (whole project) | ~1.6–3.2 s |
| `netList.GetProjectNetList` | ~2.3–3.1 s (page netlist often ~20–30 ms) |
| Single `applyCircuitPattern` / host placement script | ~15–20 s (jitter OK; do not treat as a bug) |

Do not reverse-engineer “performance regression” from a single hang: some
unimplemented RPCs historically blocked for minutes before returning a clean
`unimplemented` in ~2 ms. Prefer this table over timeout guessing.

## Works — OK for flows

| Service | Method | Role |
| --- | --- | --- |
| `kernel` | `GetSnapshot` | **Primary** read-circuit / verify source (project-wide) |
| `netList` | `GetProjectNetList` / `GetActivePageNetList` / `GetSelectionNetList` | Netlist semantics; accessor is **`netList`** (capital L) |
| `canvasOps` / pattern host | `GetPageOccupancy` | Object registration poll after place |
| `canvasOps` | `ListWireSegments` | Wire stats — field is **`wires`**, not `wireSegments` |
| `canvasOps` | `GetObjectsJsonByIds` / `GetObjectJsonById` | Optional deep object JSON (advanced) |
| `find` | `FindObject` | Optional object query (advanced; not Flow B primary) |
| `project` | `ListOpenProjects` / `GetProject` / `GetActiveProject` | Project identity |
| `capability` | `GetCapabilities` | Optional probe; not required every task |
| placement / pattern / part-search RPCs | (see placement + pattern docs) | Draw path |
| `export` | `ExportSchematicPdf` | Active-page vector PDF after **save**; response `filePath` (see `layout-visual-review.md`). **Needs a client newer than 0.1.9** — see § Client / build alignment |

## Unimplemented — **forbid** as flow dependencies

These return `unimplemented` quickly (~2 ms) in current builds. Skill must not
wait on product to implement them for scenario-b:

| Service | Methods |
| --- | --- |
| `graph` | `GetConnectivity`, `QueryGraph` |
| `kernel` | `GetEntity` |
| `erc` | `RunChecks` |
| `selection` | `GetSelection`, `SetSelection`, `ClearSelection` |
| `export` | `ExportBOM`, `ExportTarget` only (`ExportSchematicPdf` is **Works** above) |
| `runtime` | `Validate` / `ValidateCommands`, `ExecuteCommands` |
| `context` | `GetContext` |
| `transaction` | `Open` (and related) |

Read-circuit pin↔net joins use **snapshot three-table recipe** instead of a
real connectivity graph. That is intentional for this skill.

## Hollow / misleading — worse than unimplemented

| Service | Method | Behavior | What to do |
| --- | --- | --- | --- |
| `project` | `ListProjectTree` | Empty tree / `error:3` | Do not use for navigation |
| `find` | `FindNet` | Often **`success: false` with no error** | **Never** treat as “net missing”; use snapshot `nets` |

Engine-side improvement (optional, not a skill blocker): make `FindNet` return
explicit `unimplemented` instead of silent false. Until then, agents must
ignore it.

## Out of main path (ignore for scenario-b flows)

| Item | Why ignore |
| --- | --- |
| `import.ImportDesign` as a core step | Interface may respond, but depends on `*.kicad_pro` layout; not draw/read main path |
| Forcing `GetCapabilities` every task | Availability changes slowly; this doc + ban list is enough |
| Implementing selection / export / runtime / true `GetConnectivity` for skill | Product backlog; skill already bans them |
| Treating place-time jitter or `ECONNRESET` as skill defects | Retry; keep 15–20 s placement expectation |

## Naming pitfall

| Correct | Wrong | Effect |
| --- | --- | --- |
| `client.netList` | `client.netlist` | Entire service is `undefined` |

## Skill-side workarounds (until engine P2)

These engine gaps are **not blockers** for Flow B (read) or Flow C (local edit).
The skill documents the workaround; product may implement later.

| Gap | Current behavior | Skill workaround |
| --- | --- | --- |
| No authoritative connectivity graph | `graph.GetConnectivity` unimplemented | Snapshot three-table join + client BFS for series C/R/L/FB ([reading-a-circuit.md](./reading-a-circuit.md) § Series traversal) |
| Coupling vs decoupling cap | No `componentClass` / role | Heuristic: shunt cap with one leg on POWER/GROUND netClass → no series bridge |
| Per-pin wire ids for disconnect | Not exposed | Prefer **`connectPinsPlaceWire`** / `placePinStubWireAndNetAlias`; avoid blind bulk wire delete ([editing-a-circuit.md](./editing-a-circuit.md)) |
| `FindNet` silent false | Misleading empty result | **Never use**; query `snapshot.nets` by name |
| `selection.*` | Unimplemented | Locate by designator / net via snapshot + `FindObjectByProperty` |
| Transaction / undo group | `transaction.Open` unimplemented | Each RPC `commitUndo: true`; accept multi-step undo |

When `GetConnectivity` returns typed edges (`sameNet`, `seriesPassive`, …), replace
the client BFS in `read-circuit.ts` — keep the same CLI flags (`TRACE=1`).

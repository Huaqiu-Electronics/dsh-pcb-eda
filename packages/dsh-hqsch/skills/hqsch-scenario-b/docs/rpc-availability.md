# RPC availability (scenario-b engine build)

Use this table instead of trial-and-error. **Do not build flows on unimplemented
or hollow APIs.** Comprehension toolbox = `kernel.GetSnapshot` + `netList.*`.

Measured against a live HQ EDA build used with this skill. Status can change
across builds; when in doubt, prefer the ban list below over optimistic use.
You do **not** need to call `GetCapabilities` on every task — keep this table
as the default map.

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

## Unimplemented — **forbid** as flow dependencies

These return `unimplemented` quickly (~2 ms) in current builds. Skill must not
wait on product to implement them for scenario-b:

| Service | Methods |
| --- | --- |
| `graph` | `GetConnectivity`, `QueryGraph` |
| `kernel` | `GetEntity` |
| `erc` | `RunChecks` |
| `selection` | `GetSelection`, `SetSelection`, `ClearSelection` |
| `export` | `ExportBOM`, `ExportTarget` |
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
| Per-pin wire ids for disconnect | Not exposed | Prefer `autoConnectObjectsById` or `placePinStubWireAndNetAlias`; avoid blind bulk wire delete ([editing-a-circuit.md](./editing-a-circuit.md)) |
| `FindNet` silent false | Misleading empty result | **Never use**; query `snapshot.nets` by name |
| `selection.*` | Unimplemented | Locate by designator / net via snapshot + `FindObjectByProperty` |
| Transaction / undo group | `transaction.Open` unimplemented | Each RPC `commitUndo: true`; accept multi-step undo |

When `GetConnectivity` returns typed edges (`sameNet`, `seriesPassive`, …), replace
the client BFS in `read-circuit.ts` — keep the same CLI flags (`TRACE=1`).

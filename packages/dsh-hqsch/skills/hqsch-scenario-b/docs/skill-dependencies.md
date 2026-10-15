# Cross-Skill Dependencies

Common prerequisite chains when composing multi-step Agent workflows.

## Obtaining projectId

Required by: `bom-get-bom`, `bom-watch-bom`, `netlist-*`, and most project-scoped operations.

| Step | Skill | Purpose |
| --- | --- | --- |
| 1 | [`project-get-active-project`](rpc/project-get-active-project.md) | Read the currently active project |
| alt | [`project-list-open-projects`](rpc/project-list-open-projects.md) | List all open projects when none is active |

## Building context

Required by: canvas, selection, project save/open, and most editor-mutating RPCs.

| Context type | How to build | Used by |
| --- | --- | --- |
| Editor context | `client.createEditorContext()` after `connect()` | Project listing, discovery |
| Project context | `client.createProjectContext(projectId)` | Canvas ops, selection, placement |

See [quickstart.md](quickstart.md) for the full connect chain.

## Typical workflows

### Read BOM for active project

```
connect → project-get-active-project → bom-get-bom
```

### Place symbol on canvas

```
connect → project-get-active-project → placement-list-symbol-libraries → placement-place-kicad-symbol
```

### Apply a circuit pattern (decoupling / pull / I2C / SPI / crystal)

```
connect → project-get-active-project
  → pattern-layout-list-circuit-patterns
  → pattern-layout-get-page-occupancy
  → placement-place-kicad-symbol (or placement-place-symbol-from-library)
  → pattern-layout-apply-circuit-pattern (plan_only=true)
  → pattern-layout-apply-circuit-pattern (plan_only=false)
  → kernel-get-snapshot / netlist-get-active-page-net-list
```

Guide: [circuit-pattern-layout.md](circuit-pattern-layout.md).

### Connect distant pins via stub + Net Alias

See [placement-conventions.md](placement-conventions.md#stub--net-alias-long-distance--many-crossings).

```
connect → project-get-active-project → kernel-get-snapshot (or canvas-list-wire-segments)
  → obj-place-place-pin-stub-wire-and-net-alias
  → kernel-get-snapshot or netlist-get-active-page-net-list (verify)
```

### Build hierarchical block (parent ↔ child schematic)

Guide: [hierarchical-schematic-playbook.md](hierarchical-schematic-playbook.md).

```
connect → project-get-active-project
  → placement-place-block (parent page)
  → [save block objectId OR canvas-list-page-blocks]
  → placement-place-block-pin (per signal)
  → aliasBlockPins / placeShortStubAlias (parent block pins, same netName; no long wires)
  → project-activate-page-in-project (child occPath + schematicName)
  → placement-list-symbol-libraries → placement-place-symbol-from-library (kind=PORT)
  → obj-place-place-wire (child nets to ports)
  → project-save-project
  → netlist-get-port-pairing (expect BY_HIERARCHY)
```

| Step | Skill | Purpose |
| --- | --- | --- |
| 1 | [`placement-place-block`](rpc/placement-place-block.md) | Child `contentsViewName` + `blockReference` |
| 1b | [`canvas-list-page-blocks`](rpc/canvas-list-page-blocks.md) | Resolve `blockObjectId` when block already exists |
| 2 | [`placement-place-block-pin`](rpc/placement-place-block-pin.md) | Border pins on block |
| 3 | `project-activate-page-in-project` | Open child with correct `occPath` |
| 4 | [`placement-place-symbol-from-library`](rpc/placement-place-symbol-from-library.md) | **PORT** symbols on child |
| 5 | [`netlist-get-port-pairing`](rpc/netlist-get-port-pairing.md) | Verify hierarchy merge |

## Domain index

Browse all domains from the [top-level skill index](../SKILL.md).

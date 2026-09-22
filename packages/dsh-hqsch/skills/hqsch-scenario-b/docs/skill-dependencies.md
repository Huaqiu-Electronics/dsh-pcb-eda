# Cross-Skill Dependencies

Common prerequisite chains when composing multi-step Agent workflows.

## Obtaining projectId

Required by: `bom-get-bom`, `bom-watch-bom`, `netlist-*`, and most project-scoped operations.

| Step | Skill | Purpose |
| --- | --- | --- |
| 1 | [`project-get-active-project`](../project/get-active-project/SKILL.md) | Read the currently active project |
| alt | [`project-list-open-projects`](../project/list-open-projects/SKILL.md) | List all open projects when none is active |

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

### Select object then query property

```
connect → project-get-active-project → selection-set-selection → canvas-get-object-property
```

### Run ERC then show findings

```
connect → project-get-active-project → erc-run-checks → erc-show-findings
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

| Step | Skill | Purpose |
| --- | --- | --- |
| 1 | [`pattern-layout-list-circuit-patterns`](../pattern-layout/list-circuit-patterns/SKILL.md) | Roles, terminals, options, typical_size |
| 2 | [`pattern-layout-get-page-occupancy`](../pattern-layout/get-page-occupancy/SKILL.md) | Floorplan / pick a free `anchor` |
| 3 | [`placement-place-kicad-symbol`](../placement/place-kicad-symbol/SKILL.md) | Place bound parts (position may be rough) |
| 4 | [`pattern-layout-apply-circuit-pattern`](../pattern-layout/apply-circuit-pattern/SKILL.md) | Dry-run then execute; book-keep `occupied_box` |

Guide: [circuit-pattern-layout.md](../../hqeda/guides/circuit-pattern-layout.md).

### Connect distant pins via stub + Net Alias

Use when Manhattan > **400** (cross-part), estimated L-route > **500**, crossings ≥ 3,
or connecting **different parts** on the same net (SPI default). Full heuristics:
[placement-conventions.md](../../hqeda/guides/placement-conventions.md#stub--net-alias-long-distance--many-crossings).

```
connect → project-get-active-project → kernel-get-snapshot (or canvas-list-wire-segments)
  → [agent: distance / crossing check]
  → per pin end (same netName at both ends): place-pin-stub-wire-and-net-alias
  → kernel-get-snapshot or netlist-get-active-page-net-list (verify)
```

| Step | Skill | Purpose |
| --- | --- | --- |
| 1 | [`project-get-active-project`](../project/get-active-project/SKILL.md) | Build `ProjectContext` |
| 2 | [`kernel-get-snapshot`](../kernel/get-snapshot/SKILL.md) or [`canvas-list-wire-segments`](../canvas/list-wire-segments/SKILL.md) | Pin positions, existing wires (crossing check) |
| 3 | [`obj-place-place-pin-stub-wire-and-net-alias`](../obj-place/place-pin-stub-wire-and-net-alias/SKILL.md) | Per pin (`objectId`+`pinNum`): new stub unless wire **endpoint** at that pin; verify via NetAlias/netlist, not `wireSegments.netName` |

## Domain index

Browse all domains from the [top-level skill index](../SKILL.md).

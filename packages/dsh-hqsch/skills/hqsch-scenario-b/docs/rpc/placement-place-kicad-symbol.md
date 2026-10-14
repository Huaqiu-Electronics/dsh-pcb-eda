---
name: placement-place-kicad-symbol
metadata:
  category: placement
  service: ComponentPlaceService
  method: PlaceKicadSymbol
  rpcKind: unary
description: >-
  Place R/C/Q/U from online KiCad symbol URL (SCH_PlaceKicadSymbolFromResource). Invoke after part-search getEdaModels returns symbol.uri; requires active schematic page and project context.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - placement
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: PlaceKicadSymbolRequestSchema
  namespace: HqServicesV1ComponentPlaceService
---

# Place Kicad Symbol

Place R/C/Q/U from online KiCad symbol URL (SCH_PlaceKicadSymbolFromResource). Invoke after part-search getEdaModels returns symbol.uri; requires active schematic page and project context.

## Overview

This skill provides access to the **`ComponentPlaceService.PlaceKicadSymbol`** RPC method on the Huaqiu EDA engine. It is part of the **placement** domain and executes against the `componentPlace` client.

| Property | Value |
| --- | --- |
| Skill ID | `placement-place-kicad-symbol` |
| Service | `ComponentPlaceService` |
| Method | `PlaceKicadSymbol` |
| Transport | Unary (unary) |
| Domain | placement |
| Request type | `PlaceKicadSymbolRequest` |
| Response type | `ObjectPlaceResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `component` | `ComponentResource` | no | no | Online KiCad symbol resource (symbol URI from part-search) |
| `localPos` | `Vector2i64` | no | no | External display coordinates for section 0 when `sectionPlacements` is empty |
| `sectionPlacements` | `SectionPlacement[]` | no | yes | Per-section placement; each entry triggers one PlacePart (same as UI comboSection) |

### SectionPlacement

| Name | Type | Description |
| --- | --- | --- |
| `sectionIndex` | `int32` | 0-based section index (matches `LibraryPartInfo.sectionCount`) |
| `localPos` | `Vector2i64` | External display coordinates for this section |

**Compatibility:** When `sectionPlacements` is empty, places section 0 at `localPos` (legacy single-section behavior).

## Multi-section workflow (Agent)

1. Obtain `section_count` from part-search / `LibraryPartInfo` (homogeneous: PhysicalPart count; heterogeneous: unit count).
2. Compute `(extX, extY)` for each section the design needs (e.g. offset by symbol bbox width + gap).
3. Send one `PlaceKicadSymbol` with `sectionPlacements` sorted by `sectionIndex` ascending.
4. Engine downloads/converts the symbol once, then loops `SCH_Backend_PlacePart` per entry (same Reference, section suffix A/B/…).

Example (dual op-amp, two units):

```json
{
  "context": { "...": "..." },
  "component": { "symbolResource": { "uri": "https://..." } },
  "localPos": { "x": 400, "y": 300 },
  "sectionPlacements": [
    { "sectionIndex": 0, "localPos": { "x": 400, "y": 300 } },
    { "sectionIndex": 1, "localPos": { "x": 800, "y": 300 } }
  ]
}
```

## Response

Returns a `ObjectPlaceResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `success` | `boolean` | no | — |
| `objectId` | `bigint` | no | Canvas object id (objBase::m_nID). For part/symbol placement (PlacePart / PlacePartFromLibrary / PlaceKicadSymbol / PlaceSymbol / PlaceSymbolFromLibrary), this is the schem_part_enc container id — same as kernel snapshot symbol_instances[].canvas_object_id and pin_instances[].canvas_object_id. |
| `objectIds` | `bigint[]` | yes | All placed section object ids (PlaceKicadSymbol multi-section loop). |
| `sectionCount` | `number` | no | Number of sections in the package (GetSectionCount); set by PlaceKicadSymbol when available. |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "success": false,
  "objectId": "123456789",
  "objectIds": [
    "123456789"
  ],
  "sectionCount": 0
}
```

## Prerequisites

- [project-get-active-project](../../project/get-active-project/SKILL.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../../references/skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../../references/quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("placement-place-kicad-symbol");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  component: {},
  localPos: { x: 400n, y: 300n },
  sectionPlacements: [
    { sectionIndex: 0, localPos: { x: 400n, y: 300n } },
    { sectionIndex: 1, localPos: { x: 800n, y: 300n } },
  ],
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **placement** skills: [`placement/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/placement/place-kicad-symbol`


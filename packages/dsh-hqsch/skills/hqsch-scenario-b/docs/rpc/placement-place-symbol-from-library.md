---
name: placement-place-symbol-from-library
metadata:
  category: placement
  service: ComponentPlaceService
  method: PlaceSymbolFromLibrary
  rpcKind: unary
description: >-
  Place GND/VCC/power, port, or off-page symbol from symbol libraries. Invoke for power symbols and connectivity markers — call ListSymbolLibraries first; do NOT use PlaceSymbol.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - placement
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: PlaceSymbolFromLibraryRequestSchema
  namespace: HqServicesV1ComponentPlaceService
---

# Place Symbol From Library

Place GND/VCC/power, port, or off-page symbol from symbol libraries. Invoke for power symbols and connectivity markers — call ListSymbolLibraries first; do NOT use PlaceSymbol.

## Overview

This skill provides access to the **`ComponentPlaceService.PlaceSymbolFromLibrary`** RPC method on the Huaqiu EDA engine. It is part of the **placement** domain and executes against the `componentPlace` client.

| Property | Value |
| --- | --- |
| Skill ID | `placement-place-symbol-from-library` |
| Service | `ComponentPlaceService` |
| Method | `PlaceSymbolFromLibrary` |
| Transport | Unary (unary) |
| Domain | placement |
| Request type | `PlaceSymbolFromLibraryRequest` |
| Response type | `ObjectPlaceResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `localPos` | `Vector2i64` | no | no | — |
| `libraryName` | `string` | yes | no | — |
| `symbolName` | `string` | yes | no | Desired symbol / net name such as "VCC_5V" — matched approximately, but only among the symbols of the library resolved from library_name / library_file_path (never across libraries, so keep calling ListSymbolLibraries first to pick the library); exact, case-insensitive and separator-boundary hits outrank plain substring hits, so "VCC_5V" resolves to the library symbol "VCC" while "GND" never resolves to "VCC_5V". |
| `libraryFilePath` | `string` | yes | no | — |
| `kind` | `LibrarySymbolKind` | yes | no | — |
| `netName` | `string` | yes | no | Written to the "Name" user property of this placed instance only — the shared library / design cache definition keeps its original name; empty means "same as symbol_name", so passing symbol_name = "VCC_5V" alone places the "VCC" symbol labelled "VCC_5V". |

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

const skill = getSkill("placement-place-symbol-from-library");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  localPos: {"x":0,"y":0},
  libraryName: "Device",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **placement** skills: [`placement/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/placement/place-symbol-from-library`


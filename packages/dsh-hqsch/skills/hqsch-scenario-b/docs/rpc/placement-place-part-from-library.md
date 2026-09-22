---
name: placement-place-part-from-library
metadata:
  category: placement
  service: ComponentPlaceService
  method: PlacePartFromLibrary
  rpcKind: unary
description: >-
  Place a part from local/builtin library (discrete, etc.). Invoke when online part-search has no match or user specifies a local libraryName/partName; requires active schematic page.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - placement
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: PlacePartFromLibraryRequestSchema
  namespace: HqServicesV1ComponentPlaceService
---

# Place Part From Library

Place a part from local/builtin library (discrete, etc.). Invoke when online part-search has no match or user specifies a local libraryName/partName; requires active schematic page.

## Overview

This skill provides access to the **`ComponentPlaceService.PlacePartFromLibrary`** RPC method on the Huaqiu EDA engine. It is part of the **placement** domain and executes against the `componentPlace` client.

| Property | Value |
| --- | --- |
| Skill ID | `placement-place-part-from-library` |
| Service | `ComponentPlaceService` |
| Method | `PlacePartFromLibrary` |
| Transport | Unary (unary) |
| Domain | placement |
| Request type | `PlacePartFromLibraryRequest` |
| Response type | `ObjectPlaceResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `localPos` | `Vector2i64` | no | no | — |
| `libraryName` | `string` | yes | no | — |
| `partName` | `string` | yes | no | — |
| `libraryFilePath` | `string` | yes | no | — |

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

const skill = getSkill("placement-place-part-from-library");
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
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/placement/place-part-from-library`


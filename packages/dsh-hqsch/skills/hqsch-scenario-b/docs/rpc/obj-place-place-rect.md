---
name: obj-place-place-rect
metadata:
  category: obj-place
  service: ObjPlaceService
  method: PlaceRect
  rpcKind: unary
description: >-
  rect
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - obj-place
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: BoxPlaceRequestSchema
  namespace: HqServicesV1ObjPlaceService
---

# Place Rect

rect

## Overview

This skill provides access to the **`ObjPlaceService.PlaceRect`** RPC method on the Huaqiu EDA engine. It is part of the **obj-place** domain and executes against the `objPlace` client.

| Property | Value |
| --- | --- |
| Skill ID | `obj-place-place-rect` |
| Service | `ObjPlaceService` |
| Method | `PlaceRect` |
| Transport | Unary (unary) |
| Domain | obj-place |
| Request type | `BoxPlaceRequest` |
| Response type | `ObjectPlaceResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `box` | `Box2i64` | no | no | — |
| `snapToGrid` | `boolean` | yes | no | — |

## Agent notes (decoration ledger — path A)

- **Always persist** response **`objectId`** immediately after a successful call (`recordDecoration` in scenario-b `modular-lib.ts`, or a script-local array).
- **`GetSnapshot` and `getPageOccupancy` do not list** module rects or free `PlaceText` — do not use them to find ids for delete/edit.
- **Fallback (path E):** when implemented, `listPageDecorations` on the active page — **not** a full snapshot. See scenario-b `docs/decoration-objects.md`.

## Response

Returns a `ObjectPlaceResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `success` | `boolean` | no | — |
| `objectId` | `bigint` | no | Canvas object id (objBase::m_nID). |
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

const skill = getSkill("obj-place-place-rect");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  box: {},
  snapToGrid: false,
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **obj-place** skills: [`obj-place/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/obj-place/place-rect`


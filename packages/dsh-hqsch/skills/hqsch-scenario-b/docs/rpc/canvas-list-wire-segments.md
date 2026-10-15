---
name: canvas-list-wire-segments
metadata:
  category: canvas
  service: CanvasOpsService
  method: ListWireSegments
  rpcKind: unary
description: >-
  List Wire Segments via CanvasOpsService.ListWireSegments
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - canvas
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: CanvasContextRequestSchema
  namespace: HqServicesV1CanvasOpsService
---

# List Wire Segments

List Wire Segments via CanvasOpsService.ListWireSegments

## Overview

This skill provides access to the **`CanvasOpsService.ListWireSegments`** RPC method on the Huaqiu EDA engine. It is part of the **canvas** domain and executes against the `canvasOps` client.

| Property | Value |
| --- | --- |
| Skill ID | `canvas-list-wire-segments` |
| Service | `CanvasOpsService` |
| Method | `ListWireSegments` |
| Transport | Unary (unary) |
| Domain | canvas |
| Request type | `CanvasContextRequest` |
| Response type | `ListWireSegmentsResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |

## Agent notes (coordinates and netName)

- **Response field:** wire list is **`wires`** (`listWireSegments().wires`), not `wireSegments`.
- **Coordinates:** segment endpoints use the same **external display** system as `PlaceKicadSymbol` / `placePinStub` when the page is active: **Y increases downward**. Align with snapshot via `PAGE_TOP = page_box.max.y` and `extY = PAGE_TOP - canvasY` (see scenario-b `property-conventions.md`).
- **`netName` on each wire:** engine-resolved net name after refresh (`WireSegmentInfo.netName`), **not** the NetAlias label alone and **not** authoritative for pin ownership. For semantics use `getActivePageNetList` or snapshot `nets[]`; for pin locations use `PortInstScalar` / `pinInstances` — **do not** infer pin attachment from wire endpoints alone.

## Response

Returns a `ListWireSegmentsResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `wires` | `WireSegmentInfo[]` | yes | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "wires": [
    {}
  ]
}
```

## Prerequisites

- [project-get-active-project](project-get-active-project.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("canvas-list-wire-segments");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../serialization.md).

## Related Skills

- Other **canvas** skills: [`canvas/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/canvas/list-wire-segments`


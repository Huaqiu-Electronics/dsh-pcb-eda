---
name: canvas-rotate-objects-by-ids
metadata:
  category: canvas
  service: CanvasOpsService
  method: RotateObjectsByIds
  rpcKind: unary
description: >-
  Rotate Objects By Ids via CanvasOpsService.RotateObjectsByIds
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - canvas
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: ObjectsByIdsRequestSchema
  namespace: HqServicesV1CanvasOpsService
---

# Rotate Objects By Ids

Rotate Objects By Ids via CanvasOpsService.RotateObjectsByIds

## Overview

This skill provides access to the **`CanvasOpsService.RotateObjectsByIds`** RPC method on the Huaqiu EDA engine. It is part of the **canvas** domain and executes against the `canvasOps` client.

| Property | Value |
| --- | --- |
| Skill ID | `canvas-rotate-objects-by-ids` |
| Service | `CanvasOpsService` |
| Method | `RotateObjectsByIds` |
| Transport | Unary (unary) |
| Domain | canvas |
| Request type | `ObjectsByIdsRequest` |
| Response type | `SuccessResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `objectIds` | `bigint[]` | no | yes | — |

## Response

Returns a `SuccessResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `success` | `boolean` | no | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "success": false
}
```

## Prerequisites

- [project-get-active-project](../../project/get-active-project/SKILL.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../../references/skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../../references/quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("canvas-rotate-objects-by-ids");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  objectIds: ["123456789"],
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **canvas** skills: [`canvas/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/canvas/rotate-objects-by-ids`


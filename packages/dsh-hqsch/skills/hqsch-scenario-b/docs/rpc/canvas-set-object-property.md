---
name: canvas-set-object-property
metadata:
  category: canvas
  service: CanvasOpsService
  method: SetObjectProperty
  rpcKind: unary
description: >-
  Set Object Property via CanvasOpsService.SetObjectProperty
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - canvas
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: SetObjectPropertyRequestSchema
  namespace: HqServicesV1CanvasOpsService
---

# Set Object Property

Set Object Property via CanvasOpsService.SetObjectProperty

## Overview

This skill provides access to the **`CanvasOpsService.SetObjectProperty`** RPC method on the Huaqiu EDA engine. It is part of the **canvas** domain and executes against the `canvasOps` client.

| Property | Value |
| --- | --- |
| Skill ID | `canvas-set-object-property` |
| Service | `CanvasOpsService` |
| Method | `SetObjectProperty` |
| Transport | Unary (unary) |
| Domain | canvas |
| Request type | `SetObjectPropertyRequest` |
| Response type | `BoolResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `objectId` | `bigint` | yes | no | — |
| `propKey` | `string` | yes | no | — |
| `propValue` | `string` | yes | no | — |
| `op` | `ObjPropOp` | yes | no | — |
| `commitUndo` | `boolean` | yes | no | — |

## Response

Returns a `BoolResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `value` | `boolean` | no | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "value": false
}
```

## Prerequisites

- [project-get-active-project](../../project/get-active-project/SKILL.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../../references/skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../../references/quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("canvas-set-object-property");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  objectId: "123456789",
  propKey: "example",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **canvas** skills: [`canvas/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/canvas/set-object-property`


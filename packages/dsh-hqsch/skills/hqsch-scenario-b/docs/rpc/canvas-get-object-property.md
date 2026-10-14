---
name: canvas-get-object-property
metadata:
  category: canvas
  service: CanvasOpsService
  method: GetObjectProperty
  rpcKind: unary
description: >-
  Get Object Property via CanvasOpsService.GetObjectProperty
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - canvas
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: GetObjectPropertyRequestSchema
  namespace: HqServicesV1CanvasOpsService
---

# Get Object Property

Get Object Property via CanvasOpsService.GetObjectProperty

## Overview

This skill provides access to the **`CanvasOpsService.GetObjectProperty`** RPC method on the Huaqiu EDA engine. It is part of the **canvas** domain and executes against the `canvasOps` client.

| Property | Value |
| --- | --- |
| Skill ID | `canvas-get-object-property` |
| Service | `CanvasOpsService` |
| Method | `GetObjectProperty` |
| Transport | Unary (unary) |
| Domain | canvas |
| Request type | `GetObjectPropertyRequest` |
| Response type | `GetObjectPropertyResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `objectId` | `bigint` | yes | no | — |
| `propKey` | `string` | yes | no | — |

## Response

Returns a `GetObjectPropertyResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `success` | `boolean` | no | — |
| `propValue` | `string` | no | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "success": false,
  "propValue": "example"
}
```

## Prerequisites

- [project-get-active-project](../../project/get-active-project/SKILL.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../../references/skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../../references/quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("canvas-get-object-property");
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
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/canvas/get-object-property`


---
name: canvas-find-object-by-property
metadata:
  category: canvas
  service: CanvasOpsService
  method: FindObjectByProperty
  rpcKind: unary
description: >-
  object property
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - canvas
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: FindObjectByPropertyRequestSchema
  namespace: HqServicesV1CanvasOpsService
---

# Find Object By Property

object property

## Overview

This skill provides access to the **`CanvasOpsService.FindObjectByProperty`** RPC method on the Huaqiu EDA engine. It is part of the **canvas** domain and executes against the `canvasOps` client.

| Property | Value |
| --- | --- |
| Skill ID | `canvas-find-object-by-property` |
| Service | `CanvasOpsService` |
| Method | `FindObjectByProperty` |
| Transport | Unary (unary) |
| Domain | canvas |
| Request type | `FindObjectByPropertyRequest` |
| Response type | `FindObjectByPropertyResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `objTypeFilter` | `number` | yes | no | — |
| `propKey` | `string` | yes | no | — |
| `propValue` | `string` | yes | no | — |

## Response

Returns a `FindObjectByPropertyResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `success` | `boolean` | no | — |
| `objectIds` | `bigint[]` | yes | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "success": false,
  "objectIds": [
    "123456789"
  ]
}
```

## Prerequisites

- [project-get-active-project](../../project/get-active-project/SKILL.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../../references/skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../../references/quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("canvas-find-object-by-property");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  objTypeFilter: 0,
  propKey: "example",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **canvas** skills: [`canvas/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/canvas/find-object-by-property`


---
name: canvas-get-object-json-by-id
metadata:
  category: canvas
  service: CanvasOpsService
  method: GetObjectJsonById
  rpcKind: unary
description: >-
  Get Object Json By Id via CanvasOpsService.GetObjectJsonById
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - canvas
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: SelectObjectByIdRequestSchema
  namespace: HqServicesV1CanvasOpsService
---

# Get Object Json By Id

Get Object Json By Id via CanvasOpsService.GetObjectJsonById

## Overview

This skill provides access to the **`CanvasOpsService.GetObjectJsonById`** RPC method on the Huaqiu EDA engine. It is part of the **canvas** domain and executes against the `canvasOps` client.

| Property | Value |
| --- | --- |
| Skill ID | `canvas-get-object-json-by-id` |
| Service | `CanvasOpsService` |
| Method | `GetObjectJsonById` |
| Transport | Unary (unary) |
| Domain | canvas |
| Request type | `SelectObjectByIdRequest` |
| Response type | `SelectedObjectJsonResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `objectId` | `bigint` | yes | no | — |

## Response

Returns a `SelectedObjectJsonResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `json` | `string` | no | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "json": "example"
}
```

## Prerequisites

- [project-get-active-project](../../project/get-active-project/SKILL.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../../references/skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../../references/quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("canvas-get-object-json-by-id");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  objectId: "123456789",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **canvas** skills: [`canvas/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/canvas/get-object-json-by-id`


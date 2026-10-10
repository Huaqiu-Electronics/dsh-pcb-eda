---
name: canvas-auto-connect-objects-by-id
metadata:
  category: canvas
  service: CanvasOpsService
  method: AutoConnectObjectsById
  rpcKind: unary
description: >-
  Auto Connect Objects By Id via CanvasOpsService.AutoConnectObjectsById
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - canvas
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: AutoConnectObjectsRequestSchema
  namespace: HqServicesV1CanvasOpsService
---

# Auto Connect Objects By Id

Auto Connect Objects By Id via CanvasOpsService.AutoConnectObjectsById

## Overview

This skill provides access to the **`CanvasOpsService.AutoConnectObjectsById`** RPC method on the Huaqiu EDA engine. It is part of the **canvas** domain and executes against the `canvasOps` client.

| Property | Value |
| --- | --- |
| Skill ID | `canvas-auto-connect-objects-by-id` |
| Service | `CanvasOpsService` |
| Method | `AutoConnectObjectsById` |
| Transport | Unary (unary) |
| Domain | canvas |
| Request type | `AutoConnectObjectsRequest` |
| Response type | `BoolResponse` |

**Scenario-B agents:** do **not** use this for hand-wiring leftover nets — the engine picks the route. Use `obj-place-place-wire` with pin ext coords instead ([placement-conventions.md](../../../hqeda/guides/placement-conventions.md)).

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `objectId1` | `bigint` | yes | no | — |
| `pinNum1` | `number[]` | no | yes | — |
| `objectId2` | `bigint` | yes | no | — |
| `pinNum2` | `number[]` | no | yes | — |

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

const skill = getSkill("canvas-auto-connect-objects-by-id");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  objectId1: "123456789",
  pinNum1: [{}],
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **canvas** skills: [`canvas/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/canvas/auto-connect-objects-by-id`


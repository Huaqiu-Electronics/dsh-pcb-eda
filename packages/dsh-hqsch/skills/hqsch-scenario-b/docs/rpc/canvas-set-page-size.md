---
name: canvas-set-page-size
metadata:
  category: canvas
  service: CanvasOpsService
  method: SetPageSize
  rpcKind: unary
description: >-
  page
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - canvas
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: SetPageSizeRequestSchema
  namespace: HqServicesV1CanvasOpsService
---

# Set Page Size

page

## Overview

This skill provides access to the **`CanvasOpsService.SetPageSize`** RPC method on the Huaqiu EDA engine. It is part of the **canvas** domain and executes against the `canvasOps` client.

| Property | Value |
| --- | --- |
| Skill ID | `canvas-set-page-size` |
| Service | `CanvasOpsService` |
| Method | `SetPageSize` |
| Transport | Unary (unary) |
| Domain | canvas |
| Request type | `SetPageSizeRequest` |
| Response type | `SuccessResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `ltX` | `number` | yes | no | — |
| `ltY` | `number` | yes | no | — |
| `rbX` | `number` | yes | no | — |
| `rbY` | `number` | yes | no | — |
| `showBorder` | `boolean` | yes | no | — |
| `pageSizeLabel` | `string` | yes | no | — |

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

Pass a standard `pageSizeLabel` (`A4`/`A3`/`A2`/`A1`/`A0` or inches `A`/`B`/`C`/`D`/`E`).
The host computes the canvas rect like the Page Size dialog (`OnOk`) — **do not invent lt/rb coordinates yourself**.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("canvas-set-page-size");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  ltX: 0,
  ltY: 0,
  rbX: 0,
  rbY: 0,
  showBorder: true,
  pageSizeLabel: "A4",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

For `Custom`: either pass a canvas rect (`ltX/ltY/rbX/rbY`), or pass width/height in mm as `ltX`/`ltY` with `rbX=rbY=0` (e.g. `ltX: 297, ltY: 210`).

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **canvas** skills: [`canvas/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/canvas/set-page-size`


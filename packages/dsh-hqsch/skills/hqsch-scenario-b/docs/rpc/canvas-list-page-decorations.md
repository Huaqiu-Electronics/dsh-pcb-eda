---
name: canvas-list-page-decorations
metadata:
  category: canvas
  service: CanvasOpsService
  method: ListPageDecorations
  rpcKind: unary
description: >-
  List Page Decorations via CanvasOpsService.ListPageDecorations
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

# List Page Decorations

List Page Decorations via CanvasOpsService.ListPageDecorations

## Overview

This skill provides access to the **`CanvasOpsService.ListPageDecorations`** RPC method on the Huaqiu EDA engine. It is part of the **canvas** domain and executes against the `canvasOps` client.

| Property | Value |
| --- | --- |
| Skill ID | `canvas-list-page-decorations` |
| Service | `CanvasOpsService` |
| Method | `ListPageDecorations` |
| Transport | Unary (unary) |
| Domain | canvas |
| Request type | `CanvasContextRequest` |
| Response type | `ListPageDecorationsResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |

## Agent notes

- Lists **module rects** (`STATE_RECT`, not page border) and **free `PlaceText`** on the **active page**; **excludes NetAlias** (still in snapshot `labels[]`).
- **`box.min` / `box.max`:** external display coords, **Y increases downward** (same as `placeRect` / `placeText`).
- **Path E:** use when the decoration ledger (path A) is missing or the user drew/edited manually; then `deleteObjectsByIds`. **Do not** use `GetSnapshot` for this.
- **Path A:** after `placeRect` / `placeText`, still call `recordDecoration` — see scenario-b `docs/decoration-objects.md`.

## Response

Returns a `ListPageDecorationsResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `items` | `PageDecorationInfo[]` | yes | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "items": [
    {}
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

const skill = getSkill("canvas-list-page-decorations");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **canvas** skills: [`canvas/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/canvas/list-page-decorations`


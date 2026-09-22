---
name: pattern-layout-get-page-occupancy
metadata:
  category: pattern-layout
  service: PatternLayoutService
  method: GetPageOccupancy
  rpcKind: unary
description: >-
  Bounding boxes of what is already on the page, for floorplanning / avoidance.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - pattern-layout
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: GetPageOccupancyRequestSchema
  namespace: HqServicesV1PatternLayoutService
---

# Get Page Occupancy

Bounding boxes of what is already on the page, for floorplanning / avoidance.

## Overview

This skill provides access to the **`PatternLayoutService.GetPageOccupancy`** RPC method on the Huaqiu EDA engine. It is part of the **pattern-layout** domain and executes against the `patternLayout` client.

| Property | Value |
| --- | --- |
| Skill ID | `pattern-layout-get-page-occupancy` |
| Service | `PatternLayoutService` |
| Method | `GetPageOccupancy` |
| Transport | Unary (unary) |
| Domain | pattern-layout |
| Request type | `GetPageOccupancyRequest` |
| Response type | `GetPageOccupancyResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `area` | `Box2i64` | no | no | Restrict the scan to this box; empty (all-zero) box = whole page. |
| `includeWires` | `boolean` | yes | no | Include wires / buses / graphics, not just parts and symbols. |

## Response

Returns a `GetPageOccupancyResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `pageBox` | `Box2i64` | no | — |
| `items` | `PageOccupancyItem[]` | yes | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "pageBox": {},
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

const skill = getSkill("pattern-layout-get-page-occupancy");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  area: {},
  includeWires: false,
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **pattern-layout** skills: [`pattern-layout/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/pattern-layout/get-page-occupancy`


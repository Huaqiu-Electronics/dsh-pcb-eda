---
name: pattern-layout-apply-circuit-pattern
metadata:
  category: pattern-layout
  service: PatternLayoutService
  method: ApplyCircuitPattern
  rpcKind: unary
description: >-
  Lay out and wire one circuit pattern. plan_only = true is the dry-run.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - pattern-layout
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: ApplyCircuitPatternRequestSchema
  namespace: HqServicesV1PatternLayoutService
---

# Apply Circuit Pattern

Lay out and wire one circuit pattern. plan_only = true is the dry-run.

## Overview

This skill provides access to the **`PatternLayoutService.ApplyCircuitPattern`** RPC method on the Huaqiu EDA engine. It is part of the **pattern-layout** domain and executes against the `patternLayout` client.

| Property | Value |
| --- | --- |
| Skill ID | `pattern-layout-apply-circuit-pattern` |
| Service | `PatternLayoutService` |
| Method | `ApplyCircuitPattern` |
| Transport | Unary (unary) |
| Domain | pattern-layout |
| Request type | `ApplyCircuitPatternRequest` |
| Response type | `ApplyCircuitPatternResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `pattern` | `CircuitPatternId` | yes | no | — |
| `roles` | `PatternRoleBinding[]` | no | yes | — |
| `anchor` | `Vector2i64` | no | no | External display coordinate; the exact meaning per pattern is documented in
CircuitPatternDescriptor.anchor_semantics. |
| `orientation` | `PatternOrientation` | yes | no | — |
| `routeMode` | `PatternRouteMode` | yes | no | — |
| `powerMode` | `PatternPowerMode` | yes | no | — |
| `options` | `{ [key: string]: string }` | yes | no | Pattern-specific knobs; legal keys come from CircuitPatternDescriptor.options. |
| `planOnly` | `boolean` | yes | no | Dry-run: compute the plan and the conflicts, touch nothing. |
| `ignoreAreaConflict` | `boolean` | yes | no | — |

## Response

Returns a `ApplyCircuitPatternResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `status` | `PatternStatus` | no | — |
| `message` | `string` | no | — |
| `placements` | `PatternObjectPlacement[]` | yes | — |
| `connections` | `PatternConnectionResult[]` | yes | — |
| `createdObjectIds` | `bigint[]` | yes | Newly created wires / power symbols / net aliases. |
| `occupiedBox` | `Box2i64` | no | Final footprint including wires and power symbols (external coordinates).
Callers should book-keep this and avoid the area for later placements. |
| `conflictingObjectIds` | `bigint[]` | yes | Objects intersecting occupied_box; use them to pick another anchor. |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "status": {},
  "message": "example",
  "placements": [
    {}
  ],
  "connections": [
    {}
  ],
  "createdObjectIds": [
    "123456789"
  ],
  "occupiedBox": {},
  "conflictingObjectIds": [
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

const skill = getSkill("pattern-layout-apply-circuit-pattern");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  pattern: {},
  roles: [{}],
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **pattern-layout** skills: [`pattern-layout/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/pattern-layout/apply-circuit-pattern`


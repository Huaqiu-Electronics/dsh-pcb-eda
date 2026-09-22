---
name: pattern-layout-list-circuit-patterns
metadata:
  category: pattern-layout
  service: PatternLayoutService
  method: ListCircuitPatterns
  rpcKind: unary
description: >-
  Self-describing catalog — keeps the skill docs from drifting away from the implementation. Call it before Apply to learn the roles/terminals/options.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - pattern-layout
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: ListCircuitPatternsRequestSchema
  namespace: HqServicesV1PatternLayoutService
---

# List Circuit Patterns

Self-describing catalog — keeps the skill docs from drifting away from the
implementation. Call it before Apply to learn the roles/terminals/options.

## Overview

This skill provides access to the **`PatternLayoutService.ListCircuitPatterns`** RPC method on the Huaqiu EDA engine. It is part of the **pattern-layout** domain and executes against the `patternLayout` client.

| Property | Value |
| --- | --- |
| Skill ID | `pattern-layout-list-circuit-patterns` |
| Service | `PatternLayoutService` |
| Method | `ListCircuitPatterns` |
| Transport | Unary (unary) |
| Domain | pattern-layout |
| Request type | `ListCircuitPatternsRequest` |
| Response type | `ListCircuitPatternsResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `pattern` | `CircuitPatternId` | yes | no | 0 / UNSPECIFIED = every pattern. |

## Response

Returns a `ListCircuitPatternsResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `patterns` | `CircuitPatternDescriptor[]` | yes | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "patterns": [
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

const skill = getSkill("pattern-layout-list-circuit-patterns");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  pattern: {},
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **pattern-layout** skills: [`pattern-layout/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/pattern-layout/list-circuit-patterns`


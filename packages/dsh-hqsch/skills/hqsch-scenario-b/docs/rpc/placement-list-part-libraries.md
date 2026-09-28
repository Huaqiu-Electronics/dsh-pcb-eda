---
name: placement-list-part-libraries
metadata:
  category: placement
  service: ComponentPlaceService
  method: ListPartLibraries
  rpcKind: unary
description: >-
  Fallback listing for local/builtin part libraries — agents prefer online part-search (searchParts → getEdaModels) first
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - placement
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: ListPartLibrariesRequestSchema
  namespace: HqServicesV1ComponentPlaceService
---

# List Part Libraries

Fallback listing for local/builtin part libraries — agents prefer online part-search (searchParts → getEdaModels) first

## Overview

This skill provides access to the **`ComponentPlaceService.ListPartLibraries`** RPC method on the Huaqiu EDA engine. It is part of the **placement** domain and executes against the `componentPlace` client.

| Property | Value |
| --- | --- |
| Skill ID | `placement-list-part-libraries` |
| Service | `ComponentPlaceService` |
| Method | `ListPartLibraries` |
| Transport | Unary (unary) |
| Domain | placement |
| Request type | `ListPartLibrariesRequest` |
| Response type | `ListPartLibrariesResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |

## Response

Returns a `ListPartLibrariesResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `libraries` | `PartLibraryInfo[]` | yes | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "libraries": [
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

const skill = getSkill("placement-list-part-libraries");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **placement** skills: [`placement/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/placement/list-part-libraries`


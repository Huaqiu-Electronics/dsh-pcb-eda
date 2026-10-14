---
name: project-save-project
metadata:
  category: project
  service: ProjectService
  method: SaveProject
  rpcKind: unary
description: >-
  Persists an opened project.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - project
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: SaveProjectRequestSchema
  namespace: HqServicesV1ProjectService
---

# Save Project

Persists an opened project.

## Overview

This skill provides access to the **`ProjectService.SaveProject`** RPC method on the Huaqiu EDA engine. It is part of the **project** domain and executes against the `project` client.

| Property | Value |
| --- | --- |
| Skill ID | `project-save-project` |
| Service | `ProjectService` |
| Method | `SaveProject` |
| Transport | Unary (unary) |
| Domain | project |
| Request type | `SaveProjectRequest` |
| Response type | `SaveProjectResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `destination` | `string` | no | no | Optional alternative save destination.
Empty means "save in place". |

## Response

Returns a `SaveProjectResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `project` | `ProjectMetadata` | no | — |

## Usage Examples

### open a new project and save it

```json
{
  "context": "<ProjectContext via client.createProjectContext('my-project')>"
}
```

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "project": {}
}
```

## Prerequisites

- [project-get-active-project](../get-active-project/SKILL.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../../references/skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../../references/quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("project-save-project");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  destination: "example",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **project** skills: [`project/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/project/save-project`


---
name: project-get-active-project
metadata:
  category: project
  service: ProjectService
  method: GetActiveProject
  rpcKind: unary
description: >-
  Returns the project currently active in the editor UI.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - project
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: GetActiveProjectRequestSchema
  namespace: HqServicesV1ProjectService
---

# Get Active Project

Returns the project currently active in the editor UI.

## Overview

This skill provides access to the **`ProjectService.GetActiveProject`** RPC method on the Huaqiu EDA engine. It is part of the **project** domain and executes against the `project` client.

| Property | Value |
| --- | --- |
| Skill ID | `project-get-active-project` |
| Service | `ProjectService` |
| Method | `GetActiveProject` |
| Transport | Unary (unary) |
| Domain | project |
| Request type | `GetActiveProjectRequest` |
| Response type | `GetActiveProjectResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `EditorContext` | no | no | — |

## Response

Returns a `GetActiveProjectResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `project` | `ProjectMetadata` | no | — |

## Usage Examples

### getActiveProject returns the active project

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

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../../references/quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("project-get-active-project");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **project** skills: [`project/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/project/get-active-project`


---
name: project-list-open-projects
metadata:
  category: project
  service: ProjectService
  method: ListOpenProjects
  rpcKind: unary
description: >-
  Returns all projects currently opened in this HQ EDA process. Use response.projects[].name as project_name in subsequent RPCs.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - project
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: ListOpenProjectsRequestSchema
  namespace: HqServicesV1ProjectService
---

# List Open Projects

Returns all projects currently opened in this HQ EDA process.
Use response.projects[].name as project_name in subsequent RPCs.

## Overview

This skill provides access to the **`ProjectService.ListOpenProjects`** RPC method on the Huaqiu EDA engine. It is part of the **project** domain and executes against the `project` client.

| Property | Value |
| --- | --- |
| Skill ID | `project-list-open-projects` |
| Service | `ProjectService` |
| Method | `ListOpenProjects` |
| Transport | Unary (unary) |
| Domain | project |
| Request type | `ListOpenProjectsRequest` |
| Response type | `ListOpenProjectsResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `EditorContext` | no | no | — |

## Response

Returns a `ListOpenProjectsResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `projects` | `ProjectMetadata[]` | yes | Use ProjectMetadata.name as project_name in AddPageToProject / ActivatePageInProject. |

## Usage Examples

### lists open projects via editor context

```json
{
  "context": "<ProjectContext via client.createProjectContext('my-project')>"
}
```

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "projects": [
    {}
  ]
}
```

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../../references/quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("project-list-open-projects");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **project** skills: [`project/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/project/list-open-projects`


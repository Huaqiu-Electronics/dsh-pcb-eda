---
name: project-list-project-tree
metadata:
  category: project
  service: ProjectService
  method: ListProjectTree
  rpcKind: unary
description: >-
  List schematic/page tree (VxSchematic::m_strName → VxPage::m_strName[]) for an opened project.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - project
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: ListProjectTreeRequestSchema
  namespace: HqServicesV1ProjectService
---

# List Project Tree

List schematic/page tree (VxSchematic::m_strName → VxPage::m_strName[]) for an opened project.

## Overview

This skill provides access to the **`ProjectService.ListProjectTree`** RPC method on the Huaqiu EDA engine. It is part of the **project** domain and executes against the `project` client.

| Property | Value |
| --- | --- |
| Skill ID | `project-list-project-tree` |
| Service | `ProjectService` |
| Method | `ListProjectTree` |
| Transport | Unary (unary) |
| Domain | project |
| Request type | `ListProjectTreeRequest` |
| Response type | `ListProjectTreeResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `EditorContext` | no | no | — |
| `projectName` | `string` | yes | no | Same matching rules as AddPageToProjectRequest.project_name. |

## Response

Returns a `ListProjectTreeResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `error` | `ListProjectTreeError` | no | — |
| `projectName` | `string` | no | Resolved project lookup key (echo / normalization helper for agents). |
| `schematics` | `ProjectSchematicInfo[]` | yes | All schematics and their pages in the opened project. |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "error": {},
  "projectName": "example",
  "schematics": [
    {}
  ]
}
```

## Prerequisites

- [project-get-active-project](project-get-active-project.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("project-list-project-tree");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  projectName: "example",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../serialization.md).

## Related Skills

- Other **project** skills: [`project/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/project/list-project-tree`


---
name: project-add-page-to-project
metadata:
  category: project
  service: ProjectService
  method: AddPageToProject
  rpcKind: unary
description: >-
  Add a VxPage to an existing VxSchematic in an opened project (does not open canvas). See AddPageToProjectRequest field comments for VxDesign name mapping.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - project
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: AddPageToProjectRequestSchema
  namespace: HqServicesV1ProjectService
---

# Add Page To Project

Add a VxPage to an existing VxSchematic in an opened project (does not open canvas).
See AddPageToProjectRequest field comments for VxDesign name mapping.

## Overview

This skill provides access to the **`ProjectService.AddPageToProject`** RPC method on the Huaqiu EDA engine. It is part of the **project** domain and executes against the `project` client.

| Property | Value |
| --- | --- |
| Skill ID | `project-add-page-to-project` |
| Service | `ProjectService` |
| Method | `AddPageToProject` |
| Transport | Unary (unary) |
| Domain | project |
| Request type | `AddPageToProjectRequest` |
| Response type | `AddPageToProjectResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `EditorContext` | no | no | — |
| `projectName` | `string` | yes | no | Opened-project lookup key (see service header "VxDesign naming").
REQUIRED. Obtain from ListOpenProjects().name — not a folder path. |
| `schematicName` | `string` | yes | no | VxSchematic::m_strName (e.g. "SCHEMATIC1"). Schematic must already exist.
Empty → defaults to "SCHEMATIC1". |
| `pageName` | `string` | yes | no | VxPage::m_strName (e.g. "PAGE1"). Empty → auto-generate PAGE1, PAGE2, ... |

## Response

Returns a `AddPageToProjectResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `error` | `AddPageError` | no | — |
| `pageName` | `string` | no | Actual VxPage::m_strName created (useful when page_name was empty). |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "error": {},
  "pageName": "example"
}
```

## Prerequisites

- [project-get-active-project](project-get-active-project.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("project-add-page-to-project");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  projectName: "example",
  schematicName: "example",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../serialization.md).

## Related Skills

- Other **project** skills: [`project/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/project/add-page-to-project`


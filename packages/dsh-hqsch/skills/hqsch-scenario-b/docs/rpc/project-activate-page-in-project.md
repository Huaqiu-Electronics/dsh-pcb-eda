---
name: project-activate-page-in-project
metadata:
  category: project
  service: ProjectService
  method: ActivatePageInProject
  rpcKind: unary
description: >-
  Switch active workspace and open the target page canvas.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - project
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: ActivatePageInProjectRequestSchema
  namespace: HqServicesV1ProjectService
---

# Activate Page In Project

Switch active workspace and open the target page canvas.

## Overview

This skill provides access to the **`ProjectService.ActivatePageInProject`** RPC method on the Huaqiu EDA engine. It is part of the **project** domain and executes against the `project` client.

| Property | Value |
| --- | --- |
| Skill ID | `project-activate-page-in-project` |
| Service | `ProjectService` |
| Method | `ActivatePageInProject` |
| Transport | Unary (unary) |
| Domain | project |
| Request type | `ActivatePageInProjectRequest` |
| Response type | `ActivatePageInProjectResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `EditorContext` | no | no | — |
| `projectName` | `string` | yes | no | Same matching rules as AddPageToProjectRequest.project_name. |
| `pageName` | `string` | yes | no | VxPage::m_strName. REQUIRED. |
| `schematicName` | `string` | yes | no | VxSchematic::m_strName. Empty → defaults to "SCHEMATIC1". |
| `occPath` | `string` | yes | no | Hierarchical occurrence path inside the design (same value project-tree
double-click uses from VxDesign::m_mapOccInfo).
Empty → engine auto-resolves:
- unique occurrence for schematic → that path (root is usually "/")
- no entry → "/"
- multiple occurrences without a root "/" → OCC_PATH_AMBIGUOUS
Explicit value (including "/") → used as-is. |

## Response

Returns a `ActivatePageInProjectResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `error` | `ActivatePageError` | no | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "error": {}
}
```

## Prerequisites

- [project-get-active-project](project-get-active-project.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("project-activate-page-in-project");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  projectName: "example",
  pageName: "example",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../serialization.md).

## Related Skills

- Other **project** skills: [`project/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/project/activate-page-in-project`


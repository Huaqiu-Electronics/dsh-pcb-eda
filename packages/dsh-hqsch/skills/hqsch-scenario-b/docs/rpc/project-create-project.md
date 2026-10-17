---
name: project-create-project
metadata:
  category: project
  service: ProjectService
  method: CreateProject
  rpcKind: unary
description: >-
  Create a new project/design at directory/file_name and open it. A default schematic (typically SCHEMATIC1) is created with the new design.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - project
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: CreateProjectRequestSchema
  namespace: HqServicesV1ProjectService
---

# Create Project

Create a new project/design at directory/file_name and open it.
A default schematic (typically SCHEMATIC1) is created with the new design.

## Overview

This skill provides access to the **`ProjectService.CreateProject`** RPC method on the Huaqiu EDA engine. It is part of the **project** domain and executes against the `project` client.

| Property | Value |
| --- | --- |
| Skill ID | `project-create-project` |
| Service | `ProjectService` |
| Method | `CreateProject` |
| Transport | Unary (unary) |
| Domain | project |
| Request type | `CreateProjectRequest` |
| Response type | `CreateProjectResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `EditorContext` | no | no | — |
| `directory` | `string` | yes | no | Target directory on disk. |
| `fileName` | `string` | yes | no | Project file name. Preferred: "DemoBoard.HQPrj" or bare "DemoBoard".
Engine always normalizes to basename + ".HQPrj" (board project).
".HQSch" / is_design=true are coerced to ".HQPrj" — do NOT create free designs via this RPC. |
| `isDesign` | `boolean` | yes | no | Deprecated for CreateProject: ignored; result is always a project (.HQPrj).
Kept for wire compatibility. |

## Response

Returns a `CreateProjectResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `error` | `CreateProjectError` | no | — |
| `storagePath` | `string` | no | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "error": {},
  "storagePath": "/path/to/project.hqproj"
}
```

## Prerequisites

- [project-get-active-project](project-get-active-project.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("project-create-project");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  directory: "example",
  fileName: "example",
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../serialization.md).

## Related Skills

- Other **project** skills: [`project/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/project/create-project`


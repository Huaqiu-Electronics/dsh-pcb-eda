---
name: project-add-schematic-to-active-project
metadata:
  category: project
  service: ProjectService
  method: AddSchematicToActiveProject
  rpcKind: unary
description: >-
  Create a new VxSchematic folder in the UI-active opened project (no default PAGE1, does not open canvas).
  Aligns with WorkSpaceSession::NewSchem. Follow with AddPageToProject and ActivatePageInProject.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - project
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: AddSchematicToActiveProjectRequestSchema
  namespace: HqServicesV1ProjectService
---

# Add Schematic To Active Project

Create a new **VxSchematic** folder in the **UI-active** opened project.

- Does **not** create `PAGE1` (same as menu **New Schematic** → `NewSchem`).
- Does **not** open a canvas.
- Use **`PlaceBlock.contentsViewName`** (or your child schematic name) as `schematic_name` for hierarchical designs.

## Overview

This skill provides access to the **`ProjectService.AddSchematicToActiveProject`** RPC method on the Huaqiu EDA engine. It is part of the **project** domain and executes against the `project` client.

| Property | Value |
| --- | --- |
| Skill ID | `project-add-schematic-to-active-project` |
| Service | `ProjectService` |
| Method | `AddSchematicToActiveProject` |
| Transport | Unary (unary) |
| Domain | project |
| Request type | `AddSchematicToActiveProjectRequest` |
| Response type | `AddSchematicToActiveProjectResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `EditorContext` | no | no | — |
| `schematicName` | `string` | yes | no | `VxSchematic::m_strName` for the new folder. Must be non-empty after trim. Must not already exist in the active design. |

## Response

Returns a `AddSchematicToActiveProjectResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `error` | `AddSchematicError` | no | — |
| `schematicName` | `string` | no | Actual schematic name created (trimmed). |

### AddSchematicError

| Value | Meaning |
| --- | --- |
| `ADD_SCHEMATIC_ERROR_NONE` | Success |
| `ADD_SCHEMATIC_ERROR_NO_MAIN_WINDOW` | No Jupiter main window |
| `ADD_SCHEMATIC_ERROR_NO_ACTIVE_PROJECT` | No active WorkSpaceSession |
| `ADD_SCHEMATIC_ERROR_NOT_PROJECT_WORKSPACE` | Active session is a library, not a project |
| `ADD_SCHEMATIC_ERROR_INVALID_SCHEMATIC_NAME` | Empty or whitespace-only name |
| `ADD_SCHEMATIC_ERROR_SCHEMATIC_ALREADY_EXISTS` | Duplicate `VxSchematic::m_strName` |

## Prerequisites

- [project-get-active-project](project-get-active-project.md) — Confirm a project is active.
- [project-add-page-to-project](project-add-page-to-project.md), [project-activate-page-in-project](project-activate-page-in-project.md) — After creating the schematic folder.

## Typical workflow (hierarchical child sheet)

1. On **parent** page: `PlaceBlock` with `contentsViewName = "CHILD_PWR"`.
2. If `ListProjectTree` has no such schematic: **`AddSchematicToActiveProject`** with `schematicName: "CHILD_PWR"`.
3. `AddPageToProject` with `projectName` from `GetActiveProject` / `ListOpenProjects`.
4. `ActivatePageInProject` with child `schematicName` and `occPath` = parent occ + `"/" + blockReference`.

## How to Use

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("project-add-schematic-to-active-project");
const result = await skill.execute({ client }, { schematicName: "CHILD_PWR" });
console.log(toJsonString(result, { prettySpaces: 2 }));
```

## Related Skills

- [`project/`](../)
- [All EDA skills](../../SKILL.md)

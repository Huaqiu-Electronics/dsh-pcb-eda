---
name: export-export-schematic-pdf
metadata:
  category: export
  service: ExportService
  method: ExportSchematicPdf
  rpcKind: unary
description: >-
  Export Schematic Pdf via ExportService.ExportSchematicPdf
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - export
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: ExportSchematicPdfRequestSchema
  namespace: HqServicesV1ExportService
---

# Export Schematic Pdf

Export Schematic Pdf via ExportService.ExportSchematicPdf

## Overview

This skill provides access to the **`ExportService.ExportSchematicPdf`** RPC method on the Huaqiu EDA engine. It is part of the **export** domain and executes against the `export` client.

| Property | Value |
| --- | --- |
| Skill ID | `export-export-schematic-pdf` |
| Service | `ExportService` |
| Method | `ExportSchematicPdf` |
| Transport | Unary (unary) |
| Domain | export |
| Request type | `ExportSchematicPdfRequest` |
| Response type | `ExportSchematicPdfResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `outputPath` | `string` | yes | no | Empty → {project_dir}/{project_base}_active.pdf |
| `colorMode` | `SchematicPdfColorMode` | yes | no | — |
| `resolutionDpi` | `number` | yes | no | 0 → 100, same as print dialog default |

## Agent notes

- **Call `project.saveProject` first** — PDF reads persisted `VxPage` from disk, not unsaved live canvas state.
- **Active schematic page only** (v1): same rendering path as the print dialog (`drawPrintPage` + `GetPage`).
- **`outputPath` empty** → `{project_dir}/{project_base}_active.pdf`; relative paths resolve against the project directory.
- Response **`filePath`** is an absolute UTF-8 path; pass to vision-capable models or open locally.
- Do **not** use `export.exportBOM` / `export.exportTarget` in scenario-b (still unimplemented on engine).

## Response

Returns a `ExportSchematicPdfResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `success` | `boolean` | no | — |
| `filePath` | `string` | no | absolute path UTF-8 |
| `message` | `string` | no | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "success": false,
  "filePath": "/path/to/project.hqproj",
  "message": "example"
}
```

## Prerequisites

- [project-get-active-project](../../project/get-active-project/SKILL.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../../references/skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../../references/quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("export-export-schematic-pdf");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  outputPath: "/path/to/project.hqproj",
  colorMode: {},
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **export** skills: [`export/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/export/export-schematic-pdf`


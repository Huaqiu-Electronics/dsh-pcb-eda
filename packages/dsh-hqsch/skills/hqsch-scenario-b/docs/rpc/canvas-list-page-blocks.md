---
name: canvas-list-page-blocks
metadata:
  category: canvas
  service: CanvasOpsService
  method: ListPageBlocks
  rpcKind: unary
description: >-
  List hierarchical schematic blocks on the active page (object id, bbox, block
  reference, child sheet name, border pins). Use before PlaceBlockPin when the
  block already exists.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - canvas
  - hierarchical
entry: "@huaqiu/huaqiu-client"
manifest: "@huaqiu/huaqiu-client/skill.json"
inputSchema:
  name: CanvasContextRequestSchema
  namespace: HqServicesV1CanvasOpsService
---

# List Page Blocks

List **hierarchical blocks** on the active schematic page — outline, child sheet
link, and border pins. Prefer this over guessing `blockObjectId` after
`PlaceBlock` or when editing an existing design.

## Overview

| Property | Value |
| --- | --- |
| Skill ID | `canvas-list-page-blocks` |
| Service | `CanvasOpsService` |
| Method | `ListPageBlocks` |
| Client | `client.canvasOps.listPageBlocks` |
| Request | `CanvasContextRequest` (`context`) |
| Response | `ListPageBlocksResponse` |

## Response fields

`blocks[]` — each `PageBlockInfo`:

| Field | Description |
| --- | --- |
| `objectId` | Block canvas id → `PlaceBlockPin.blockObjectId` |
| `box` | Block outline (`min` / `max`, ext coords, Y down) |
| `blockReference` | Block reference / occ segment |
| `contentsViewName` | Linked child sheet name |
| `blockValue` | Block value string |
| `pins[]` | Existing border pins (`pinName`, position, type, width) |

## Agent notes

- Hierarchical workflow: scenario-b `hierarchical-schematic-playbook.md`.
- If RPC is unavailable on an older client build, fall back to `placeBlock` →
  `objectId`, or `findObjectByProperty(Reference)` — see `rpc-availability.md`.

## Prerequisites

- [project-get-active-project](project-get-active-project.md)

See [skill-dependencies.md](../skill-dependencies.md).

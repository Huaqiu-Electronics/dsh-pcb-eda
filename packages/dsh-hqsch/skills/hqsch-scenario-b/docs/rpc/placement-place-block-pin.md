---
name: placement-place-block-pin
metadata:
  category: placement
  service: ComponentPlaceService
  method: PlaceBlockPin
  rpcKind: unary
description: >-
  Place a hierarchical block border pin on an existing block object. Invoke after
  PlaceBlock when wiring child-sheet ports to the parent block outline; pinName
  should match the child port Name.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - placement
  - hierarchical
entry: "@huaqiu/huaqiu-client"
manifest: "@huaqiu/huaqiu-client/skill.json"
inputSchema:
  name: PlaceBlockPinRequestSchema
  namespace: HqServicesV1ComponentPlaceService
---

# Place Block Pin

Place a border pin on a schematic **block** (hierarchical sheet outline). Use when
building parent/child sheet interfaces — one RPC call per signal on the block edge.

## Overview

| Property | Value |
| --- | --- |
| Skill ID | `placement-place-block-pin` |
| Service | `ComponentPlaceService` |
| Method | `PlaceBlockPin` |
| Client | `client.componentPlace.placeBlockPin` |
| Request type | `PlaceBlockPinRequest` |
| Response type | `ObjectPlaceResponse` |

## Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `context` | `ProjectContext` | yes | Active project context |
| `blockObjectId` | `bigint` | yes | Block canvas object id (from `PlaceBlock` / `listPageBlocks`) |
| `pinName` | `string` | yes | Pin label on the block edge; **match child sheet port Name** |
| `pinType` | `BlockPinElectricalType` | no | Default Passive when unspecified |
| `pinWidth` | `BlockPinWidth` | no | Default Scalar (single wire); use Bus for vector ports |

### BlockPinElectricalType (common)

| Value | Meaning |
| --- | --- |
| `BLOCK_PIN_PASSIVE` / Passive | Default for most signals |
| `BLOCK_PIN_INPUT` | Input |
| `BLOCK_PIN_OUTPUT` | Output |
| `BLOCK_PIN_BIDIRECTIONAL` | Bidirectional |
| `BLOCK_PIN_POWER` | Power |

### BlockPinWidth

| Value | Meaning |
| --- | --- |
| `BLOCK_PIN_WIDTH_SCALAR` | Single wire (default) |
| `BLOCK_PIN_WIDTH_BUS` | Bus / vector |

## Response

Same as other placement RPCs: `success`, `objectId` for the new pin object.

## Prerequisites

- [project-get-active-project](project-get-active-project.md)
- Block already placed: [placement-place-block](placement-place-block.md)
- Hierarchical workflow: see scenario-b `hierarchical-schematic-playbook.md`

See [skill-dependencies.md](../skill-dependencies.md).

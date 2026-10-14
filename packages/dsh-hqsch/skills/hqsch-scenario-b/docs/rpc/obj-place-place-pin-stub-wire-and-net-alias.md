---
name: obj-place-place-pin-stub-wire-and-net-alias
metadata:
  category: obj-place
  service: ObjPlaceService
  method: PlacePinStubWireAndNetAlias
  rpcKind: unary
description: >-
  Pin stub wire + net alias: detect existing wire, extend stub with collision avoidance, place alias; single undo step.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - obj-place
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: PlacePinStubWireAndNetAliasRequestSchema
  namespace: HqServicesV1ObjPlaceService
---

# Place Pin Stub Wire And Net Alias

Places a short stub wire and NetAlias at a **specific part pin**, or adds an alias on a wire **already terminated at that pin**. One undo step.

## Behavior

| Pin state | Engine action | Response |
| --- | --- | --- |
| No wire endpoint at **this** pin's `ex/ey` | New stub (default 30 ext; **+10** if stub **end** touches a **perpendicular** wire body; parallel neighbor stubs ignored; extends until clear) + NetAlias at stub end | `wireObjectId > 0`, `usedExistingWire=false` |
| Wire segment endpoint at **this** pin (±`PIN_CONNECT_OFFSET`) | No new stub; alias **`initialStubLength` ext** (default 30) along that wire from pin | `wireObjectId=0`, `usedExistingWire=true` |

**Strict pin match:** `usedExistingWire` is **not** set when a wire merely belongs to an adjacent pin on the same symbol edge (e.g. MCU PA4–PA7, tight spacing). Each pin must have its **own** endpoint at its connection point.

## Agent notes

- **Same-side multi-pin:** call once per `pinNum`; do not pre-draw a shared bus with `placeWire` before labeling. If stubs collide, increase `initialStubLength` per pin or use `placeNetAliasAt` with explicit `attachObjectId`.
- **Verify success:** check `netAliasObjectId` and netlist membership — **not** `wireSegments[].netName` alone (physical wire name ≠ NetAlias label until refresh).
- **Dual-end nets:** same `netName` at pin A and pin B; do not `autoConnect` between them afterward.

## Overview

This skill provides access to the **`ObjPlaceService.PlacePinStubWireAndNetAlias`** RPC method on the Huaqiu EDA engine. It is part of the **obj-place** domain and executes against the `objPlace` client.

| Property | Value |
| --- | --- |
| Skill ID | `obj-place-place-pin-stub-wire-and-net-alias` |
| Service | `ObjPlaceService` |
| Method | `PlacePinStubWireAndNetAlias` |
| Transport | Unary (unary) |
| Domain | obj-place |
| Request type | `PlacePinStubWireAndNetAliasRequest` |
| Response type | `PlacePinStubWireAndNetAliasResponse` |

## Parameters

| Name | Type | Required | Repeated | Description |
| --- | --- | --- | --- | --- |
| `context` | `ProjectContext` | no | no | — |
| `objectId` | `bigint` | yes | no | part/symbol canvas id |
| `pinNum` | `number` | yes | no | pin_num or pin_name (one required) |
| `pinName` | `string` | yes | no | — |
| `netName` | `string` | yes | no | — |
| `snapToGrid` | `boolean` | yes | no | default true |
| `initialStubLength` | `bigint` | yes | no | default 30 |
| `stubExtendStep` | `bigint` | yes | no | default 10 |
| `maxStubLength` | `bigint` | yes | no | default 300 |

## Response

Returns a `PlacePinStubWireAndNetAliasResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `success` | `boolean` | no | — |
| `message` | `string` | no | — |
| `wireObjectId` | `bigint` | no | 0 = no new stub |
| `netAliasObjectId` | `bigint` | no | — |
| `aliasPos` | `Vector2i64` | no | external display, Y down |
| `stubLengthUsed` | `bigint` | no | actual stub length (ext) |
| `usedExistingWire` | `boolean` | no | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "success": false,
  "message": "example",
  "wireObjectId": "123456789",
  "netAliasObjectId": "123456789",
  "aliasPos": {},
  "stubLengthUsed": "0",
  "usedExistingWire": false
}
```

## Prerequisites

- [project-get-active-project](../../project/get-active-project/SKILL.md) — Discover the active project before building project-scoped context.

See also [skill-dependencies.md](../../references/skill-dependencies.md) for common workflows.

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../../references/quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("obj-place-place-pin-stub-wire-and-net-alias");
const result = await skill.execute({ client }, {
  context: "<ProjectContext via client.createProjectContext('my-project')>",
  objectId: "123456789",
  pinNum: 1,
  pinName: "",
  netName: "VCC",
  snapToGrid: true,
  initialStubLength: 30n,
  stubExtendStep: 10n,
  maxStubLength: 300n,
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **obj-place** skills: [`obj-place/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/obj-place/place-pin-stub-wire-and-net-alias`


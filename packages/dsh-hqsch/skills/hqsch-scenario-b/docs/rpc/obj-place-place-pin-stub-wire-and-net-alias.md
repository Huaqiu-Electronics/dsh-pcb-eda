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

Pin stub wire + net alias: detect existing wire, extend stub with collision avoidance, place alias; single undo step.

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
  pinNum: 0,
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **obj-place** skills: [`obj-place/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/obj-place/place-pin-stub-wire-and-net-alias`


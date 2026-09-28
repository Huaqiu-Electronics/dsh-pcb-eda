---
name: netlist-get-active-page-net-list
metadata:
  category: netlist
  service: NetListService
  method: GetActivePageNetList
  rpcKind: unary
description: >-
  / Gets the netlist for the currently active schematic page (real-time canvas state).
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - netlist
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
inputSchema:
  name: EmptySchema
  namespace: ProtobufWkt
---

# Get Active Page Net List

/ Gets the netlist for the currently active schematic page (real-time canvas state).

## Overview

This skill provides access to the **`NetListService.GetActivePageNetList`** RPC method on the Huaqiu EDA engine. It is part of the **netlist** domain and executes against the `netList` client.

| Property | Value |
| --- | --- |
| Skill ID | `netlist-get-active-page-net-list` |
| Service | `NetListService` |
| Method | `GetActivePageNetList` |
| Transport | Unary (unary) |
| Domain | netlist |
| Request type | `Empty` |
| Response type | `GetNetListResponse` |

## Response

Returns a `GetNetListResponse` message with the following fields:

| Name | Type | Repeated | Description |
| --- | --- | --- | --- |
| `result` | `{
    /**
     * / Schematic netlist data.
     *
     * @generated from field: hq.ir.schematic.v1.SchematicNetlist netlist = 1;
     */
    value: SchematicNetlist;
    case: "netlist";
  }` | no | — |

## Response Example

Representative response structure (field values are placeholders):

```json
{
  "result": {}
}
```

## How to Use

Execute via the HQ EDA skill runtime with a connected `EditorClient`. See [quickstart.md](../../references/quickstart.md) for the full `listEditors` → `connect` → `getSkill` → `execute` chain.

```typescript
import { getSkill, toJsonString } from "@huaqiu/hqeda";

const skill = getSkill("netlist-get-active-page-net-list");
const result = await skill.execute({ client }, {
});
console.log(toJsonString(result, { prettySpaces: 2 }));
```

Serialize responses with `toJsonString()` — see [serialization.md](../../references/serialization.md).

## Related Skills

- Other **netlist** skills: [`netlist/`](../)
- Full index: [All EDA skills](../../SKILL.md)
- Install: `npx skills add Huaqiu-Electronics/skills --path eda/netlist/get-active-page-net-list`


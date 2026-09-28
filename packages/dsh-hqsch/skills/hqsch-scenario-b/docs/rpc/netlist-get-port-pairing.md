---
name: netlist-get-port-pairing
metadata:
  category: netlist
  service: NetListService
  method: GetPortPairing
---

# netList.GetPortPairing

Returns every cross-page / cross-occurrence Port and Off-page pairing that
`VxPstxnetNew::ReadFromDesign` has already merged onto the same design net.

## Why

`GetProjectNetList` only exposes pin↔net. Agents cannot see that `/TYPE-C`
`USB_D+` and `/ESP32-C3FH4` `GPIO18` are the same net without guessing.
This RPC exposes the pairing and the merge rule.

## Call

```typescript
const res = await client.netList.getPortPairing({});
```

## Rules (from net connectivity + ReadFromDesign)

| Rule | Source | When |
| --- | --- | --- |
| `BY_NAME` | MergePageNet | Same Off-page / Port name within schematic folder |
| `BY_HIERARCHY` | ConnectBlockPinAndPort | Parent block pin = `occPath_portName`; parent wires can join different child port names |
| `BY_GLOBAL` | MergeDesignNet | Design-wide Power / Global name intersection |

There is **no byGuid** rule.

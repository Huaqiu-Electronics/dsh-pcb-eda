---
name: eda-obj-place
metadata:
  category: obj-place
description: >-
  Obj Place operations for Huaqiu EDA. Use this skill when you need to work with obj-place-related operations including add bus segment, add ellipse, add ellipse arc.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - obj-place
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
---

# Obj Place Skills

Obj Place operations for Huaqiu EDA. Use this skill when you need to work with obj-place-related operations including add bus segment, add ellipse, add ellipse arc.

## Available Capabilities

Total: **42** skills in the **obj-place** domain.

| Skill | Description | Streaming |
| --- | --- | --- |
| `add-bus-segment` | Add Bus Segment via ObjPlaceService.AddBusSegment | no |
| `add-ellipse` | Add Ellipse via ObjPlaceService.AddEllipse | no |
| `add-ellipse-arc` | Add Ellipse Arc via ObjPlaceService.AddEllipseArc | no |
| `add-free-line-segment` | Add Free Line Segment via ObjPlaceService.AddFreeLineSegment | no |
| `add-line` | Add Line via ObjPlaceService.AddLine | no |
| `add-rect` | Add Rect via ObjPlaceService.AddRect | no |
| `add-wire-segment` | Add Wire Segment via ObjPlaceService.AddWireSegment | no |
| `cancel-bus-draw` | Cancel Bus Draw via ObjPlaceService.CancelBusDraw | no |
| `cancel-ellipse-arc-draw` | Cancel Ellipse Arc Draw via ObjPlaceService.CancelEllipseArcDraw | no |
| `cancel-ellipse-draw` | Cancel Ellipse Draw via ObjPlaceService.CancelEllipseDraw | no |
| `cancel-free-line-draw` | Cancel Free Line Draw via ObjPlaceService.CancelFreeLineDraw | no |
| `cancel-line-draw` | Cancel Line Draw via ObjPlaceService.CancelLineDraw | no |
| `cancel-rect-draw` | Cancel Rect Draw via ObjPlaceService.CancelRectDraw | no |
| `cancel-wire-draw` | Cancel Wire Draw via ObjPlaceService.CancelWireDraw | no |
| `handle-bus-draw-click` | bus | no |
| `handle-ellipse-arc-draw-click` | Handle Ellipse Arc Draw Click via ObjPlaceService.HandleEllipseArcDrawClick | no |
| `handle-ellipse-draw-click` | Handle Ellipse Draw Click via ObjPlaceService.HandleEllipseDrawClick | no |
| `handle-free-line-draw-click` | Handle Free Line Draw Click via ObjPlaceService.HandleFreeLineDrawClick | no |
| `handle-image-draw-click` | Handle Image Draw Click via ObjPlaceService.HandleImageDrawClick | no |
| `handle-line-draw-click` | Handle Line Draw Click via ObjPlaceService.HandleLineDrawClick | no |
| `handle-net-alias-draw-click` | Handle Net Alias Draw Click via ObjPlaceService.HandleNetAliasDrawClick | no |
| `handle-rect-draw-click` | Handle Rect Draw Click via ObjPlaceService.HandleRectDrawClick | no |
| `handle-table-draw-click` | Handle Table Draw Click via ObjPlaceService.HandleTableDrawClick | no |
| `handle-text-draw-click` | Handle Text Draw Click via ObjPlaceService.HandleTextDrawClick | no |
| `handle-wire-draw-click` | wire | no |
| `place-bus` | Place Bus via ObjPlaceService.PlaceBus | no |
| `place-ellipse` | ellipse | no |
| `place-ellipse-arc` | ellipse arc | no |
| `place-ellipse-arc-at` | Place Ellipse Arc At via ObjPlaceService.PlaceEllipseArcAt | no |
| `place-ellipse-arc-from-virtual` | Place Ellipse Arc From Virtual via ObjPlaceService.PlaceEllipseArcFromVirtual | no |
| `place-free-line` | free line | no |
| `place-image` | image | no |
| `place-line` | line | no |
| `place-net-alias` | net alias | no |
| `place-net-alias-at` | Place net label on wire/bus at local_pos. Invoke when naming nets (3V3, GND, PROBE_NET); requires wi | no |
| [`place-pin-stub-wire-and-net-alias`](../rpc/obj-place-place-pin-stub-wire-and-net-alias.md) | Pin stub wire + net alias: detect existing wire, extend stub with collision avoidance, place alias;  | no |
| [`place-rect`](../rpc/obj-place-place-rect.md) | rect | no |
| `place-table` | table | no |
| `place-table-from-virtual` | Place Table From Virtual via ObjPlaceService.PlaceTableFromVirtual | no |
| [`place-text`](../rpc/obj-place-place-text.md) | text | no |
| `place-text-from-virtual` | Place Text From Virtual via ObjPlaceService.PlaceTextFromVirtual | no |
| `place-wire` | Place Wire via ObjPlaceService.PlaceWire | no |

## See Also

- All EDA skills
- [quickstart.md](../quickstart.md)
- [serialization.md](../serialization.md)
- [`@huaqiu/hqeda` npm package](https://www.npmjs.com/package/@huaqiu/hqeda) — shared runtime + capability registry


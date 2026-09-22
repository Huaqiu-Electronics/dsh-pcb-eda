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
| [`add-bus-segment`](add-bus-segment/SKILL.md) | Add Bus Segment via ObjPlaceService.AddBusSegment | no |
| [`add-ellipse`](add-ellipse/SKILL.md) | Add Ellipse via ObjPlaceService.AddEllipse | no |
| [`add-ellipse-arc`](add-ellipse-arc/SKILL.md) | Add Ellipse Arc via ObjPlaceService.AddEllipseArc | no |
| [`add-free-line-segment`](add-free-line-segment/SKILL.md) | Add Free Line Segment via ObjPlaceService.AddFreeLineSegment | no |
| [`add-line`](add-line/SKILL.md) | Add Line via ObjPlaceService.AddLine | no |
| [`add-rect`](add-rect/SKILL.md) | Add Rect via ObjPlaceService.AddRect | no |
| [`add-wire-segment`](add-wire-segment/SKILL.md) | Add Wire Segment via ObjPlaceService.AddWireSegment | no |
| [`cancel-bus-draw`](cancel-bus-draw/SKILL.md) | Cancel Bus Draw via ObjPlaceService.CancelBusDraw | no |
| [`cancel-ellipse-arc-draw`](cancel-ellipse-arc-draw/SKILL.md) | Cancel Ellipse Arc Draw via ObjPlaceService.CancelEllipseArcDraw | no |
| [`cancel-ellipse-draw`](cancel-ellipse-draw/SKILL.md) | Cancel Ellipse Draw via ObjPlaceService.CancelEllipseDraw | no |
| [`cancel-free-line-draw`](cancel-free-line-draw/SKILL.md) | Cancel Free Line Draw via ObjPlaceService.CancelFreeLineDraw | no |
| [`cancel-line-draw`](cancel-line-draw/SKILL.md) | Cancel Line Draw via ObjPlaceService.CancelLineDraw | no |
| [`cancel-rect-draw`](cancel-rect-draw/SKILL.md) | Cancel Rect Draw via ObjPlaceService.CancelRectDraw | no |
| [`cancel-wire-draw`](cancel-wire-draw/SKILL.md) | Cancel Wire Draw via ObjPlaceService.CancelWireDraw | no |
| [`handle-bus-draw-click`](handle-bus-draw-click/SKILL.md) | bus | no |
| [`handle-ellipse-arc-draw-click`](handle-ellipse-arc-draw-click/SKILL.md) | Handle Ellipse Arc Draw Click via ObjPlaceService.HandleEllipseArcDrawClick | no |
| [`handle-ellipse-draw-click`](handle-ellipse-draw-click/SKILL.md) | Handle Ellipse Draw Click via ObjPlaceService.HandleEllipseDrawClick | no |
| [`handle-free-line-draw-click`](handle-free-line-draw-click/SKILL.md) | Handle Free Line Draw Click via ObjPlaceService.HandleFreeLineDrawClick | no |
| [`handle-image-draw-click`](handle-image-draw-click/SKILL.md) | Handle Image Draw Click via ObjPlaceService.HandleImageDrawClick | no |
| [`handle-line-draw-click`](handle-line-draw-click/SKILL.md) | Handle Line Draw Click via ObjPlaceService.HandleLineDrawClick | no |
| [`handle-net-alias-draw-click`](handle-net-alias-draw-click/SKILL.md) | Handle Net Alias Draw Click via ObjPlaceService.HandleNetAliasDrawClick | no |
| [`handle-rect-draw-click`](handle-rect-draw-click/SKILL.md) | Handle Rect Draw Click via ObjPlaceService.HandleRectDrawClick | no |
| [`handle-table-draw-click`](handle-table-draw-click/SKILL.md) | Handle Table Draw Click via ObjPlaceService.HandleTableDrawClick | no |
| [`handle-text-draw-click`](handle-text-draw-click/SKILL.md) | Handle Text Draw Click via ObjPlaceService.HandleTextDrawClick | no |
| [`handle-wire-draw-click`](handle-wire-draw-click/SKILL.md) | wire | no |
| [`place-bus`](place-bus/SKILL.md) | Place Bus via ObjPlaceService.PlaceBus | no |
| [`place-ellipse`](place-ellipse/SKILL.md) | ellipse | no |
| [`place-ellipse-arc`](place-ellipse-arc/SKILL.md) | ellipse arc | no |
| [`place-ellipse-arc-at`](place-ellipse-arc-at/SKILL.md) | Place Ellipse Arc At via ObjPlaceService.PlaceEllipseArcAt | no |
| [`place-ellipse-arc-from-virtual`](place-ellipse-arc-from-virtual/SKILL.md) | Place Ellipse Arc From Virtual via ObjPlaceService.PlaceEllipseArcFromVirtual | no |
| [`place-free-line`](place-free-line/SKILL.md) | free line | no |
| [`place-image`](place-image/SKILL.md) | image | no |
| [`place-line`](place-line/SKILL.md) | line | no |
| [`place-net-alias`](place-net-alias/SKILL.md) | net alias | no |
| [`place-net-alias-at`](place-net-alias-at/SKILL.md) | Place net label on wire/bus at local_pos. Invoke when naming nets (3V3, GND, PROBE_NET); requires wi | no |
| [`place-pin-stub-wire-and-net-alias`](place-pin-stub-wire-and-net-alias/SKILL.md) | Pin stub wire + net alias: detect existing wire, extend stub with collision avoidance, place alias;  | no |
| [`place-rect`](place-rect/SKILL.md) | rect | no |
| [`place-table`](place-table/SKILL.md) | table | no |
| [`place-table-from-virtual`](place-table-from-virtual/SKILL.md) | Place Table From Virtual via ObjPlaceService.PlaceTableFromVirtual | no |
| [`place-text`](place-text/SKILL.md) | text | no |
| [`place-text-from-virtual`](place-text-from-virtual/SKILL.md) | Place Text From Virtual via ObjPlaceService.PlaceTextFromVirtual | no |
| [`place-wire`](place-wire/SKILL.md) | Place Wire via ObjPlaceService.PlaceWire | no |

## See Also

- [All EDA skills](../SKILL.md)
- [quickstart.md](../references/quickstart.md)
- [serialization.md](../references/serialization.md)
- [`@huaqiu/hqeda` npm package](https://www.npmjs.com/package/@huaqiu/hqeda) — shared runtime + capability registry


---
name: eda-canvas
metadata:
  category: canvas
description: >-
  Canvas operations for Huaqiu EDA. Invoke when selecting, moving, wiring, or editing objects on the active schematic page.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - canvas
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
---

# Canvas Skills

Canvas operations for Huaqiu EDA. Invoke when selecting, moving, wiring, or editing objects on the active schematic page.

## Available Capabilities

Total: **48** skills in the **canvas** domain.

| Skill | Description | Streaming |
| --- | --- | --- |
| `align-objects` | transform | no |
| `align-objects-by-ids` | Align Objects By Ids via CanvasOpsService.AlignObjectsByIds | no |
| [`auto-connect-objects-by-id`](../rpc/canvas-auto-connect-objects-by-id.md) | Auto Connect Objects By Id via CanvasOpsService.AutoConnectObjectsById | no |
| `can-paste` | Can Paste via CanvasOpsService.CanPaste | no |
| `clear-all-sel` | selection | no |
| `copy-objects-by-ids` | Copy Objects By Ids via CanvasOpsService.CopyObjectsByIds | no |
| `copy-selected` | Copy Selected via CanvasOpsService.CopySelected | no |
| `delete-object-by-id` | Delete Object By Id via CanvasOpsService.DeleteObjectById | no |
| [`delete-objects-by-ids`](../rpc/canvas-delete-objects-by-ids.md) | Delete Objects By Ids via CanvasOpsService.DeleteObjectsByIds | no |
| `delete-selected` | edit | no |
| `distribute-objects` | Distribute Objects via CanvasOpsService.DistributeObjects | no |
| `distribute-objects-by-ids` | Distribute Objects By Ids via CanvasOpsService.DistributeObjectsByIds | no |
| [`find-object-by-property`](../rpc/canvas-find-object-by-property.md) | object property | no |
| `get-align-type` | Get Align Type via CanvasOpsService.GetAlignType | no |
| [`get-object-json-by-id`](../rpc/canvas-get-object-json-by-id.md) | Get Object Json By Id via CanvasOpsService.GetObjectJsonById | no |
| [`get-object-property`](../rpc/canvas-get-object-property.md) | Get Object Property via CanvasOpsService.GetObjectProperty | no |
| `get-objects-json-by-ids` | Get Objects Json By Ids via CanvasOpsService.GetObjectsJsonByIds | no |
| `get-selected-object-json` | Get Selected Object Json via CanvasOpsService.GetSelectedObjectJson | no |
| `get-selected-objects-json` | Get Selected Objects Json via CanvasOpsService.GetSelectedObjectsJson | no |
| [`list-page-decorations`](../rpc/canvas-list-page-decorations.md) | List Page Decorations via CanvasOpsService.ListPageDecorations | no |
| [`list-wire-segments`](../rpc/canvas-list-wire-segments.md) | List Wire Segments via CanvasOpsService.ListWireSegments | no |
| `mirror-objects` | mode: 1\|2\|3 required; 0=no-op | no |
| [`mirror-objects-by-ids`](../rpc/canvas-mirror-objects-by-ids.md) | mode: 1\|2\|3 required; 0=no-op | no |
| `move-objects-by-ids` | Move Objects By Ids via CanvasOpsService.MoveObjectsByIds | no |
| `move-selected-objs` | Move Selected Objs via CanvasOpsService.MoveSelectedObjs | no |
| `on-canvas-escape` | state | no |
| `pan-canvas` | viewport | no |
| `paste-selected` | Paste Selected via CanvasOpsService.PasteSelected | no |
| `redo` | Redo via CanvasOpsService.Redo | no |
| `rotate-objects` | Rotate Objects via CanvasOpsService.RotateObjects | no |
| [`rotate-objects-by-ids`](../rpc/canvas-rotate-objects-by-ids.md) | Rotate Objects By Ids via CanvasOpsService.RotateObjectsByIds | no |
| `screen-to-canvas-local` | coordinate | no |
| `select-all` | Select All via CanvasOpsService.SelectAll | no |
| `select-object-at` | Select Object At via CanvasOpsService.SelectObjectAt | no |
| `select-object-by-id` | Select Object By Id via CanvasOpsService.SelectObjectById | no |
| `select-objects-by-ids` | Select Objects By Ids via CanvasOpsService.SelectObjectsByIds | no |
| `set-align-type` | grid align | no |
| [`set-object-property`](../rpc/canvas-set-object-property.md) | Set Object Property via CanvasOpsService.SetObjectProperty | no |
| [`set-page-size`](../rpc/canvas-set-page-size.md) | page | no |
| `set-page-size-rect` | Set Page Size Rect via CanvasOpsService.SetPageSizeRect | no |
| `undo` | undo / redo (SCH_Undo / SCH_Redo on active canvas) | no |
| [`zoom-all`](../rpc/canvas-zoom-all.md) | Zoom All via CanvasOpsService.ZoomAll | no |
| `zoom-area-by-double-box` | Zoom Area By Double Box via CanvasOpsService.ZoomAreaByDoubleBox | no |
| `zoom-area-by-int-box` | Zoom Area By Int Box via CanvasOpsService.ZoomAreaByIntBox | no |
| `zoom-area-by-points` | Zoom Area By Points via CanvasOpsService.ZoomAreaByPoints | no |
| `zoom-in` | zoom | no |
| `zoom-out` | Zoom Out via CanvasOpsService.ZoomOut | no |
| `zoom-selected` | Zoom Selected via CanvasOpsService.ZoomSelected | no |

## See Also

- All EDA skills
- [quickstart.md](../quickstart.md)
- [serialization.md](../serialization.md)
- [`@huaqiu/hqeda` npm package](https://www.npmjs.com/package/@huaqiu/hqeda) — shared runtime + capability registry


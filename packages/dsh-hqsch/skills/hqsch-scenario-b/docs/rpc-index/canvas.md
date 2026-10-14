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
| [`align-objects`](align-objects/SKILL.md) | transform | no |
| [`align-objects-by-ids`](align-objects-by-ids/SKILL.md) | Align Objects By Ids via CanvasOpsService.AlignObjectsByIds | no |
| [`auto-connect-objects-by-id`](auto-connect-objects-by-id/SKILL.md) | Auto Connect Objects By Id via CanvasOpsService.AutoConnectObjectsById | no |
| [`can-paste`](can-paste/SKILL.md) | Can Paste via CanvasOpsService.CanPaste | no |
| [`clear-all-sel`](clear-all-sel/SKILL.md) | selection | no |
| [`copy-objects-by-ids`](copy-objects-by-ids/SKILL.md) | Copy Objects By Ids via CanvasOpsService.CopyObjectsByIds | no |
| [`copy-selected`](copy-selected/SKILL.md) | Copy Selected via CanvasOpsService.CopySelected | no |
| [`delete-object-by-id`](delete-object-by-id/SKILL.md) | Delete Object By Id via CanvasOpsService.DeleteObjectById | no |
| [`delete-objects-by-ids`](delete-objects-by-ids/SKILL.md) | Delete Objects By Ids via CanvasOpsService.DeleteObjectsByIds | no |
| [`delete-selected`](delete-selected/SKILL.md) | edit | no |
| [`distribute-objects`](distribute-objects/SKILL.md) | Distribute Objects via CanvasOpsService.DistributeObjects | no |
| [`distribute-objects-by-ids`](distribute-objects-by-ids/SKILL.md) | Distribute Objects By Ids via CanvasOpsService.DistributeObjectsByIds | no |
| [`find-object-by-property`](find-object-by-property/SKILL.md) | object property | no |
| [`get-align-type`](get-align-type/SKILL.md) | Get Align Type via CanvasOpsService.GetAlignType | no |
| [`get-object-json-by-id`](get-object-json-by-id/SKILL.md) | Get Object Json By Id via CanvasOpsService.GetObjectJsonById | no |
| [`get-object-property`](get-object-property/SKILL.md) | Get Object Property via CanvasOpsService.GetObjectProperty | no |
| [`get-objects-json-by-ids`](get-objects-json-by-ids/SKILL.md) | Get Objects Json By Ids via CanvasOpsService.GetObjectsJsonByIds | no |
| [`get-selected-object-json`](get-selected-object-json/SKILL.md) | Get Selected Object Json via CanvasOpsService.GetSelectedObjectJson | no |
| [`get-selected-objects-json`](get-selected-objects-json/SKILL.md) | Get Selected Objects Json via CanvasOpsService.GetSelectedObjectsJson | no |
| [`list-page-decorations`](list-page-decorations/SKILL.md) | List Page Decorations via CanvasOpsService.ListPageDecorations | no |
| [`list-wire-segments`](list-wire-segments/SKILL.md) | List Wire Segments via CanvasOpsService.ListWireSegments | no |
| [`mirror-objects`](mirror-objects/SKILL.md) | mode: 1\|2\|3 required; 0=no-op | no |
| [`mirror-objects-by-ids`](mirror-objects-by-ids/SKILL.md) | mode: 1\|2\|3 required; 0=no-op | no |
| [`move-objects-by-ids`](move-objects-by-ids/SKILL.md) | Move Objects By Ids via CanvasOpsService.MoveObjectsByIds | no |
| [`move-selected-objs`](move-selected-objs/SKILL.md) | Move Selected Objs via CanvasOpsService.MoveSelectedObjs | no |
| [`on-canvas-escape`](on-canvas-escape/SKILL.md) | state | no |
| [`pan-canvas`](pan-canvas/SKILL.md) | viewport | no |
| [`paste-selected`](paste-selected/SKILL.md) | Paste Selected via CanvasOpsService.PasteSelected | no |
| [`redo`](redo/SKILL.md) | Redo via CanvasOpsService.Redo | no |
| [`rotate-objects`](rotate-objects/SKILL.md) | Rotate Objects via CanvasOpsService.RotateObjects | no |
| [`rotate-objects-by-ids`](rotate-objects-by-ids/SKILL.md) | Rotate Objects By Ids via CanvasOpsService.RotateObjectsByIds | no |
| [`screen-to-canvas-local`](screen-to-canvas-local/SKILL.md) | coordinate | no |
| [`select-all`](select-all/SKILL.md) | Select All via CanvasOpsService.SelectAll | no |
| [`select-object-at`](select-object-at/SKILL.md) | Select Object At via CanvasOpsService.SelectObjectAt | no |
| [`select-object-by-id`](select-object-by-id/SKILL.md) | Select Object By Id via CanvasOpsService.SelectObjectById | no |
| [`select-objects-by-ids`](select-objects-by-ids/SKILL.md) | Select Objects By Ids via CanvasOpsService.SelectObjectsByIds | no |
| [`set-align-type`](set-align-type/SKILL.md) | grid align | no |
| [`set-object-property`](set-object-property/SKILL.md) | Set Object Property via CanvasOpsService.SetObjectProperty | no |
| [`set-page-size`](set-page-size/SKILL.md) | page | no |
| [`set-page-size-rect`](set-page-size-rect/SKILL.md) | Set Page Size Rect via CanvasOpsService.SetPageSizeRect | no |
| [`undo`](undo/SKILL.md) | undo / redo (SCH_Undo / SCH_Redo on active canvas) | no |
| [`zoom-all`](zoom-all/SKILL.md) | Zoom All via CanvasOpsService.ZoomAll | no |
| [`zoom-area-by-double-box`](zoom-area-by-double-box/SKILL.md) | Zoom Area By Double Box via CanvasOpsService.ZoomAreaByDoubleBox | no |
| [`zoom-area-by-int-box`](zoom-area-by-int-box/SKILL.md) | Zoom Area By Int Box via CanvasOpsService.ZoomAreaByIntBox | no |
| [`zoom-area-by-points`](zoom-area-by-points/SKILL.md) | Zoom Area By Points via CanvasOpsService.ZoomAreaByPoints | no |
| [`zoom-in`](zoom-in/SKILL.md) | zoom | no |
| [`zoom-out`](zoom-out/SKILL.md) | Zoom Out via CanvasOpsService.ZoomOut | no |
| [`zoom-selected`](zoom-selected/SKILL.md) | Zoom Selected via CanvasOpsService.ZoomSelected | no |

## See Also

- [All EDA skills](../SKILL.md)
- [quickstart.md](../references/quickstart.md)
- [serialization.md](../references/serialization.md)
- [`@huaqiu/hqeda` npm package](https://www.npmjs.com/package/@huaqiu/hqeda) — shared runtime + capability registry


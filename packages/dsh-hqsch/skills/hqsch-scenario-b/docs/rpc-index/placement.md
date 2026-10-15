---
name: eda-placement
metadata:
  category: placement
description: >-
  Placement operations for Huaqiu EDA. Invoke when placing parts, symbols, or blocks on a schematic — R/C/Q/U via PlaceKicadSymbol (online), GND/VCC/port via PlaceSymbolFromLibrary, local fallback via PlacePartFromLibrary.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - placement
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
---

# Placement Skills

Placement operations for Huaqiu EDA. Invoke when placing parts, symbols, or blocks on a schematic — R/C/Q/U via PlaceKicadSymbol (online), GND/VCC/port via PlaceSymbolFromLibrary, local fallback via PlacePartFromLibrary.

## Available Capabilities

Total: **14** skills in the **placement** domain.

| Skill | Description | Streaming |
| --- | --- | --- |
| `cancel-block-draw` | Cancel Block Draw via ComponentPlaceService.CancelBlockDraw | no |
| `clear-net-alias-attach-obj` | Clear Net Alias Attach Obj via ComponentPlaceService.ClearNetAliasAttachObj | no |
| `handle-block-draw-click` | Handle Block Draw Click via ComponentPlaceService.HandleBlockDrawClick | no |
| `handle-part-draw-click` | Handle Part Draw Click via ComponentPlaceService.HandlePartDrawClick | no |
| `handle-symbol-draw-click` | Handle Symbol Draw Click via ComponentPlaceService.HandleSymbolDrawClick | no |
| [`list-part-libraries`](../rpc/placement-list-part-libraries.md) | Fallback listing for local/builtin part libraries — agents prefer online part-search (searchParts →  | no |
| [`list-symbol-libraries`](../rpc/placement-list-symbol-libraries.md) | Agent path: list global/power/gnd, port, off-page symbols — call before PlaceSymbolFromLibrary | no |
| [`place-block`](../rpc/placement-place-block.md) | block | no |
| [`place-kicad-symbol`](../rpc/placement-place-kicad-symbol.md) | Place R/C/Q/U from online KiCad symbol URL (SCH_PlaceKicadSymbolFromResource). Invoke after part-sea | no |
| `place-part` | INTERNAL: low-level part placement — requires engine-native JSON; agents use PlaceKicadSymbol (onlin | no |
| [`place-part-from-library`](../rpc/placement-place-part-from-library.md) | Place a part from local/builtin library (discrete, etc.). Invoke when online part-search has no matc | no |
| `place-symbol` | INTERNAL: low-level symbol placement — requires engine-native JSON; agents use PlaceSymbolFromLibrar | no |
| [`place-symbol-from-library`](../rpc/placement-place-symbol-from-library.md) | Place GND/VCC/power, port, or off-page symbol from symbol libraries. Invoke for power symbols and co | no |
| `set-net-alias-attach-obj` | net alias attach | no |

## See Also

- All EDA skills
- [quickstart.md](../quickstart.md)
- [serialization.md](../serialization.md)
- [`@huaqiu/hqeda` npm package](https://www.npmjs.com/package/@huaqiu/hqeda) — shared runtime + capability registry


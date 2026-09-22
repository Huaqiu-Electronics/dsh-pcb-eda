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
| [`cancel-block-draw`](cancel-block-draw/SKILL.md) | Cancel Block Draw via ComponentPlaceService.CancelBlockDraw | no |
| [`clear-net-alias-attach-obj`](clear-net-alias-attach-obj/SKILL.md) | Clear Net Alias Attach Obj via ComponentPlaceService.ClearNetAliasAttachObj | no |
| [`handle-block-draw-click`](handle-block-draw-click/SKILL.md) | Handle Block Draw Click via ComponentPlaceService.HandleBlockDrawClick | no |
| [`handle-part-draw-click`](handle-part-draw-click/SKILL.md) | Handle Part Draw Click via ComponentPlaceService.HandlePartDrawClick | no |
| [`handle-symbol-draw-click`](handle-symbol-draw-click/SKILL.md) | Handle Symbol Draw Click via ComponentPlaceService.HandleSymbolDrawClick | no |
| [`list-part-libraries`](list-part-libraries/SKILL.md) | Fallback listing for local/builtin part libraries — agents prefer online part-search (searchParts →  | no |
| [`list-symbol-libraries`](list-symbol-libraries/SKILL.md) | Agent path: list global/power/gnd, port, off-page symbols — call before PlaceSymbolFromLibrary | no |
| [`place-block`](place-block/SKILL.md) | block | no |
| [`place-kicad-symbol`](place-kicad-symbol/SKILL.md) | Place R/C/Q/U from online KiCad symbol URL (SCH_PlaceKicadSymbolFromResource). Invoke after part-sea | no |
| [`place-part`](place-part/SKILL.md) | INTERNAL: low-level part placement — requires engine-native JSON; agents use PlaceKicadSymbol (onlin | no |
| [`place-part-from-library`](place-part-from-library/SKILL.md) | Place a part from local/builtin library (discrete, etc.). Invoke when online part-search has no matc | no |
| [`place-symbol`](place-symbol/SKILL.md) | INTERNAL: low-level symbol placement — requires engine-native JSON; agents use PlaceSymbolFromLibrar | no |
| [`place-symbol-from-library`](place-symbol-from-library/SKILL.md) | Place GND/VCC/power, port, or off-page symbol from symbol libraries. Invoke for power symbols and co | no |
| [`set-net-alias-attach-obj`](set-net-alias-attach-obj/SKILL.md) | net alias attach | no |

## See Also

- [All EDA skills](../SKILL.md)
- [quickstart.md](../references/quickstart.md)
- [serialization.md](../references/serialization.md)
- [`@huaqiu/hqeda` npm package](https://www.npmjs.com/package/@huaqiu/hqeda) — shared runtime + capability registry


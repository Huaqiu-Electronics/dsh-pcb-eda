---
name: eda-netlist
metadata:
  category: netlist
description: >-
  Netlist operations for Huaqiu EDA. Invoke when reading net names or connectivity from the active or project scope.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - netlist
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
---

# Netlist Skills

Netlist operations for Huaqiu EDA. Invoke when reading net names or connectivity from the active or project scope.

## Available Capabilities

Total: **4** skills in the **netlist** domain.

| Skill | Description | Streaming |
| --- | --- | --- |
| [`get-active-page-net-list`](get-active-page-net-list/SKILL.md) | / Gets the netlist for the currently active schematic page (real-time canvas state). | no |
| [`get-port-pairing`](get-port-pairing/SKILL.md) | / Lists cross-page / cross-hierarchy Port and Off-page pairings on the same design net. | no |
| [`get-project-net-list`](get-project-net-list/SKILL.md) | / Gets the complete netlist for the current project. | no |
| [`get-selection-net-list`](get-selection-net-list/SKILL.md) | / Gets the netlist for the currently selected components. | no |

## See Also

- [All EDA skills](../SKILL.md)
- [quickstart.md](../references/quickstart.md)
- [serialization.md](../references/serialization.md)
- [`@huaqiu/hqeda` npm package](https://www.npmjs.com/package/@huaqiu/hqeda) — shared runtime + capability registry


---
name: eda-pattern-layout
metadata:
  category: pattern-layout
description: >-
  Pattern Layout operations for Huaqiu EDA. Use this skill when you need to work with pattern-layout-related operations including apply circuit pattern, get page occupancy, list circuit patterns.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - pattern-layout
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
---

# Pattern Layout Skills

Pattern Layout operations for Huaqiu EDA. Use this skill when you need to work with pattern-layout-related operations including apply circuit pattern, get page occupancy, list circuit patterns.

## Available Capabilities

Total: **3** skills in the **pattern-layout** domain.

| Skill | Description | Streaming |
| --- | --- | --- |
| [`apply-circuit-pattern`](apply-circuit-pattern/SKILL.md) | Lay out and wire one circuit pattern. plan_only = true is the dry-run. | no |
| [`get-page-occupancy`](get-page-occupancy/SKILL.md) | Bounding boxes of what is already on the page, for floorplanning / avoidance. | no |
| [`list-circuit-patterns`](list-circuit-patterns/SKILL.md) | Self-describing catalog — keeps the skill docs from drifting away from the
implementation. Call it  | no |

## See Also

- [All EDA skills](../SKILL.md)
- [quickstart.md](../references/quickstart.md)
- [serialization.md](../references/serialization.md)
- [`@huaqiu/hqeda` npm package](https://www.npmjs.com/package/@huaqiu/hqeda) — shared runtime + capability registry


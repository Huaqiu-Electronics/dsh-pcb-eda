---
name: eda-find
metadata:
  category: find
description: >-
  Find operations for Huaqiu EDA. Use this skill when you need to work with find-related operations including find net, find object.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - find
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
---

# Find Skills

Find operations for Huaqiu EDA. Use this skill when you need to work with find-related operations including find net, find object.

## Available Capabilities

Total: **2** skills in the **find** domain.

| Skill | Description | Streaming |
| --- | --- | --- |
| `find-net` | Find Net via FindService.FindNet | no |
| [`find-object`](../rpc/find-find-object.md) | Find Object via FindService.FindObject | no |

## See Also

- All EDA skills
- [quickstart.md](../quickstart.md)
- [serialization.md](../serialization.md)
- [`@huaqiu/hqeda` npm package](https://www.npmjs.com/package/@huaqiu/hqeda) — shared runtime + capability registry


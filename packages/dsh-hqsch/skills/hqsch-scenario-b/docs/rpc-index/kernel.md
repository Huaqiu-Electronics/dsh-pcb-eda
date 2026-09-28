---
name: eda-kernel
metadata:
  category: kernel
description: >-
  Kernel operations for Huaqiu EDA. Use this skill when you need to work with kernel-related operations including get entity, get snapshot.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - kernel
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
---

# Kernel Skills

Kernel operations for Huaqiu EDA. Use this skill when you need to work with kernel-related operations including get entity, get snapshot.

## Available Capabilities

Total: **2** skills in the **kernel** domain.

| Skill | Description | Streaming |
| --- | --- | --- |
| [`get-entity`](get-entity/SKILL.md) | Get Entity via KernelService.GetEntity | no |
| [`get-snapshot`](get-snapshot/SKILL.md) | Get Snapshot via KernelService.GetSnapshot | no |

## See Also

- [All EDA skills](../SKILL.md)
- [quickstart.md](../references/quickstart.md)
- [serialization.md](../references/serialization.md)
- [`@huaqiu/hqeda` npm package](https://www.npmjs.com/package/@huaqiu/hqeda) — shared runtime + capability registry


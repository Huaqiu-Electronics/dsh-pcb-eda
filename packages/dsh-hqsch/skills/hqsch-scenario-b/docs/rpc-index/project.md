---
name: eda-project
metadata:
  category: project
description: >-
  Project operations for Huaqiu EDA. Invoke when opening, saving, or navigating project pages and schematics.
version: 0.1.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - project
entry: "@huaqiu/hqeda"
manifest: "@huaqiu/hqeda/skill.json"
---

# Project Skills

Project operations for Huaqiu EDA. Invoke when opening, saving, or navigating project pages and schematics.

## Available Capabilities

Total: **10** skills in the **project** domain.

| Skill | Description | Streaming |
| --- | --- | --- |
| [`activate-page-in-project`](activate-page-in-project/SKILL.md) | Switch active workspace and open the target page canvas. | no |
| [`add-page-to-project`](add-page-to-project/SKILL.md) | Add a VxPage to an existing VxSchematic in an opened project (does not open canvas).
See AddPageToP | no |
| [`close-project`](close-project/SKILL.md) | Closes an opened project. | no |
| [`create-project`](create-project/SKILL.md) | Create a new project/design at directory/file_name and open it.
A default schematic (typically SCHE | no |
| [`get-active-project`](get-active-project/SKILL.md) | Returns the project currently active in the editor UI. | no |
| [`get-project`](get-project/SKILL.md) | Returns one opened project. | no |
| [`list-open-projects`](list-open-projects/SKILL.md) | Returns all projects currently opened in this HQ EDA process.
Use response.projects[].name as proje | no |
| [`list-project-tree`](list-project-tree/SKILL.md) | List schematic/page tree (VxSchematic::m_strName → VxPage::m_strName[]) for an opened project. | no |
| [`open-project`](open-project/SKILL.md) | Opens a project into the current HQ EDA editor process. | no |
| [`save-project`](save-project/SKILL.md) | Persists an opened project. | no |

## See Also

- [All EDA skills](../SKILL.md)
- [quickstart.md](../references/quickstart.md)
- [serialization.md](../references/serialization.md)
- [`@huaqiu/hqeda` npm package](https://www.npmjs.com/package/@huaqiu/hqeda) — shared runtime + capability registry


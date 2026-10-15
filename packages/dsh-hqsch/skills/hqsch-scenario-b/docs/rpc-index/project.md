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

Total: **11** skills in the **project** domain.

| Skill | Description | Streaming |
| --- | --- | --- |
| [`activate-page-in-project`](../rpc/project-activate-page-in-project.md) | Switch active workspace and open the target page canvas. | no |
| [`add-schematic-to-active-project`](../rpc/project-add-schematic-to-active-project.md) | Create a new VxSchematic in the UI-active project (no PAGE1; does not open canvas). | no |
| [`add-page-to-project`](../rpc/project-add-page-to-project.md) | Add a VxPage to an existing VxSchematic in an opened project (does not open canvas).
See AddPageToP | no |
| `close-project` | Closes an opened project. | no |
| [`create-project`](../rpc/project-create-project.md) | Create a new project/design at directory/file_name and open it.
A default schematic (typically SCHE | no |
| [`get-active-project`](../rpc/project-get-active-project.md) | Returns the project currently active in the editor UI. | no |
| `get-project` | Returns one opened project. | no |
| [`list-open-projects`](../rpc/project-list-open-projects.md) | Returns all projects currently opened in this HQ EDA process.
Use response.projects[].name as proje | no |
| [`list-project-tree`](../rpc/project-list-project-tree.md) | List schematic/page tree (VxSchematic::m_strName → VxPage::m_strName[]) for an opened project. | no |
| `open-project` | Opens a project into the current HQ EDA editor process. | no |
| [`save-project`](../rpc/project-save-project.md) | Persists an opened project. | no |

## See Also

- All EDA skills
- [quickstart.md](../quickstart.md)
- [serialization.md](../serialization.md)
- [`@huaqiu/hqeda` npm package](https://www.npmjs.com/package/@huaqiu/hqeda) — shared runtime + capability registry


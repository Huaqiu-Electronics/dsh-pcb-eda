# 模块化布局（Scenario B 摘要）

用户要求 **最小系统 / 模块框 / 中文标题 / 分区** 时，在流程 A 之上增加 **P0→P4** 阶段。完整说明见 monorepo `skills/hqeda/modular-placement/`；本文件为 **scenario-b 分发包内** 的必读摘要。

## 何时启用

| 用户说法 | 动作 |
| --- | --- |
| MCU 最小系统、模块化、分区、模块框 | 先读本文 + `modular-layout-hq-mapping.md`，再画电路 |
| 仅补晶振/复位/去耦 | 仍用 `circuit-pattern-layout.md`，不必强行加框 |
| 只读已有图 | 流程 B，**不要**加框 |

## 阶段（固定顺序）

```text
P0  模块规划表 + 复杂度档(S/M/L) → canvas-set-page-size(Custom) → 读 page_box
P1  page_box 内 occupancy 放置器件（禁止整页 magic 坐标；坐标吸附 20 或 50 ext 网格）
P2  统一电源/功能网络名；GND/VCC/NetAlias
P3  applyCircuitPattern（每 pattern 前重读 occupancy）+ routing gate 补线
P3d 同名 NetAlias 合并分段网；删孤儿导线
P4a 器件稳定后：union bbox → place-rect + place-text（记录 objectId）
P4b netlist 关键网 + saveProject + zoomAll
P4c 【可选】估页过大时 union 微调 Custom 页（不移动器件）
```

**P1 完成前不要画模块框。** **P3 完成前不要 P4c。**

## P0 估页（STM32 最小系统）

| 档 | 建议 Custom（ext，Y 向下） |
| --- | --- |
| S 偏 M（电源+双 section MCU+HSE+复位+BOOT+去耦+1 外设） | **1800×1400** 起 |

`pageSizeLabel: "Custom"` + `ltX/ltY/rbX/rbY`；**setPageSize 不移动已有对象**。

## P1 放置护栏

- 先 `getPageOccupancy({ includeWires: false })`，为新器件选 **非 reserved** 空位。
- 双 section MCU：`sectionPlacements`；电源单元与 GPIO 单元 **垂直堆叠** 时预留 pattern `occupied_box` 高度。
- 每个 pattern apply **前** 重读 occupancy（否则 `AREA_OCCUPIED` 误报）。
- `AREA_OCCUPIED`：若冲突 id 仅为 pattern **host** 自身 bbox，可 `ignoreAreaConflict: true`（簇本体与其它器件无交叠时）。
- 引脚坐标：活动页布局优先 `getObjectJsonById` → `PortInstScalar`；`PAGE_TOP = page_box.max.y`（ext Y 向下）。
- **禁止**手写与网格无关的 magic 坐标（如 137、1050 混用导致 P4a 无法对齐）。

## P3 已知引擎注意

- `decoupling_cap` **多电容** 时可能 GND/+3V3 错乱 → 删该区导线后 **链式** `autoConnectObjectsById` 重建。
- `pull_resistor` 可能把电阻放在 host 引脚旁 → 若与连接器分属同一模块，**P4a 前** 将器件归位到模块 union 内。
- 网络表路径：`getActivePageNetList` → **`response.result.value.nets[]`**（不是顶层 `nets`）；成员在 `pinReferences[]`。
- 多 section 位号在 netlist 中可能显示为 `U` 而非 `U2`（电气仍连通）。

## P4a 模块框

1. 按模块 **refs** union bbox + 邻近匿名电源符号（±60 ext）。
2. 外扩 margin；**框边与标题坐标吸附 20 ext 网格**（见 `layout-quality-audit.md`）。
3. `place-rect`：`box.min/max` ext；`place-text`：标题在框顶上方 20–40 ext。
4. **记录** rect/text 的 `objectId`（occupancy 常不含图元）。

## P4b 验收

- 关键 net 成员表（期望 pin 列表）。
- 无单引脚网、无 `N\d+` 孤儿网（或已合并）。
- 跑 `scripts/layout-audit.ts`（布局质量，**勿用 union 外接矩形占比代替**）。

## 模板脚本

| 脚本 | 用途 |
| --- | --- |
| `modular-lib.ts` | connect、occupancy、pins、searchAndPlace、waitForIds |
| `layout-audit.ts` | 填充率、最大空白矩形、框对齐、模块间距 |

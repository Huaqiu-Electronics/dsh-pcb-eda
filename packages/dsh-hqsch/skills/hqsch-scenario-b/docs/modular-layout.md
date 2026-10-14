# 模块化布局（Scenario B 摘要）

用户要求 **最小系统 / 模块框 / 中文标题 / 分区** 时，在流程 A 之上增加 **P0→P4** 阶段。完整说明见 monorepo `skills/hqeda/modular-placement/`；本文件为 **scenario-b 分发包内** 的必读摘要。

**排版质量（页面预算 / 宏观区位 / 密度带 / 标签走廊）见 [modular-layout-compact.md](modular-layout-compact.md) —— 模块化任务必读，用于避免「模块相距过远、排布不规则」。**

## 何时启用

| 用户说法 | 动作 |
| --- | --- |
| MCU 最小系统、模块化、分区、模块框 | 先读本文 + `modular-layout-hq-mapping.md`，再画电路 |
| 仅补晶振/复位/去耦 | 仍用 `circuit-pattern-layout.md`，不必强行加框 |
| 只读已有图 | 流程 B，**不要**加框 |
| **已有模块化图，只修某一区**（如复位模块接错、换一颗电容） | **流程 C** — `editing-a-circuit.md`；**禁止**整页重画 |

## 单模块修补（流程 C，非流程 A）

用户说的是 **「某一块有问题 / 改复位 / 改电源区」**，不是 **「重做最小系统 / 从头画」**：

| 禁止 | 应做 |
| --- | --- |
| 整页重画脚本 / `clearActivePageFull` / 重跑 P0–P4 | 先 **流程 B**（`read-circuit.ts` / `REF=`）定位该模块位号与邻域 |
| 用 occupancy 清整页再 P0–P4 全重放 | 写 **修改集**：只列将删/改/放的 objectId 与 net |
| 无确认批量 `deleteObjectsByIds` | **流程 C**：`edit-property-by-ref` / `rewire-pin-by-ref` / `replace-part-by-ref` 或等价最小 RPC |
| P4a 前 `prepareP4aDecorations`（会删 **全页** 框/字） | 只删 **本模块** 装饰：`deleteModuleDecorations(client, ctx, moduleKey)` |

**模块级爆炸半径**（`modular-lib.ts`）：

| 目的 | 调用 |
| --- | --- |
| 列出该模块的器件 id、位号、邻域导线 id、union bbox | `moduleBlastRadius(client, ctx, refs, pad = 40)` — 先打印给用户确认 |
| 删掉该模块器件+导线（**不动装饰**） | `deleteModuleBlastRadius(client, ctx, refs)` |
| 只删该模块框/标题 | `deleteModuleDecorations(client, ctx, moduleKey)` |
| 整块平移（不重画） | `moveExtBatch(client, ctx, ids, dxExt, dyExt)` — `MoveObjectsByIds` 用窗口像素，该函数自动标定 px→ext 并按残差迭代 |

导线归属靠 **端点落在器件 bbox 外扩 `pad` 内** 判定（`listWireSegments` 不返回归属器件），所以 `pad` 过大会连带删到邻区导线：**先看 `moduleBlastRadius` 的输出再删**。

**模块框随内容变小时**：对该模块 `refs` 做 `unionModuleBBox` → `padUnionBox` → `placeModuleFrameAndTitle`（只登记本模块 `moduleKey`）。其它模块 **不动**。

**何时才允许整页流程 A**：用户明确「清空重做 / 换整套最小系统 / 新工程从零画」，且确认清页（含装饰）后。

详见 `editing-a-circuit.md` § Modular designs。

## 阶段（固定顺序）

```text
P0  模块规划表(key/band/refs) → planCompactZones 算页与槽位 → set-page-size(Custom) → 读 page_box
P1  按 atZone(zones[key]) 放器件（禁止整页 magic 坐标；坐标吸附 20 ext 网格）
P2  统一电源/功能网络名；GND/VCC/NetAlias
P3  applyCircuitPattern（每 pattern 前重读 occupancy）+ routing gate 补线
    模块内短线 autoConnect；跨模块一律双端 stub+alias（禁止导线穿模块框）
P3d 同名 NetAlias 合并分段网；删孤儿导线
P4a 器件稳定后：union bbox → place-rect + place-text（**A：place 后立即 recordDecoration / 账本**）
P4b 验收：netlist + layout-audit + save → 导出当前页 PDF + zoomAll
P4c 【可选】估页过大时 union 微调 Custom 页（不移动器件）
```

**P1 完成前不要画模块框。** **P3 完成前不要 P4c。**

## P0 估页（按模块清单反推，禁止固定大页）

1. 列 **模块规划表**：`key` / 中文 `title` / `refs` / **`band`**（`top`｜`left`｜`center`｜`right`｜`bottom`）。
2. `planCompactZones(MODULES)` → `{ pageW, pageH, zones }`；**主控等多脚器件显式给 `w`/`h`**。
3. `setPageSize`：`pageSizeLabel: "Custom"` + `ltX/ltY/rbX/rbY`；**setPageSize 不移动已有对象**。

模块之间只留 `LABEL_CORRIDOR = 60 ext` 走廊、页边 `PAGE_MARGIN = 80 ext`。**禁止**默认 1800×1400 + 固定 500×400 槽（模块相距过远的主因）。宏观区位模板与阈值见 [modular-layout-compact.md](modular-layout-compact.md)。

## P1 放置护栏

- 槽内锚点用 `atZone(zones[key], dx, dy)`，`dx/dy` 取 **20 的倍数**；同一带内各模块 **顶边对齐**。
- 先 `getPageOccupancy({ includeWires: false })`，为新器件选 **非 reserved** 空位。
- 双 section MCU：`sectionPlacements`；电源单元与 GPIO 单元 **垂直堆叠** 时预留 pattern `occupied_box` 高度。
- 每个 pattern apply **前** 重读 occupancy（否则 `AREA_OCCUPIED` 误报）。
- `AREA_OCCUPIED`：若冲突 id 仅为 pattern **host** 自身 bbox，可 `ignoreAreaConflict: true`（簇本体与其它器件无交叠时）。
- 引脚坐标：活动页布局优先 `getObjectJsonById` → `PortInstScalar`；`PAGE_TOP = page_box.max.y`（ext Y 向下）。
- **禁止**手写与网格无关的 magic 坐标（如 137、1050 混用导致 P4a 无法对齐）。

## 去耦：两种拓扑（不要混用）

| 形态 | 典型位置 | 画法 | 目视目标 |
| --- | --- | --- | --- |
| **A · 电源脚 shunt**（LDO 入/出各 1～2 颗） | 电源模块，host = LDO `VIN`/`VOUT` | **`decoupling_cap`**：每次 apply **最多 1 颗 cap**（或 bulk+`cap_bypass` 一对）；多颗 **多次 apply + anchor 水平错开** | 滤波电容贴在 **LDO 对应引脚一侧** 竖排；**每组**有自己的 +5V/+3V3/GND 符号 |
| **B · 去耦模块并联排**（多颗 100nF 共母线） | **独立槽位**，与 MCU 分开 | **禁止** `applyCircuitPattern` / **`decoupling_cap`**（含一次一颗、多次 apply 均禁止）。**仅 hand**：P1 横排摆 cap → 上下两条母线 `placeHorizontalRail(client, ctx, "+3V3"\|"GND", x1, x2, y)` → `autoConnect` 各 cap 上/下脚到母线 → 模块内 1 个 +3V3 + 1 个 GND 符号；MCU `VDD`/`VDDA` 用 **stub/alias 接到 +3V3** | 槽内 **C13…C10 一排**；**一条顶轨 +3V3、一条底轨 GND**（模块内仅一对电源符号） |

**反模式（禁止）：** 去耦模块内对 MCU（或其它 host）调用 **`decoupling_cap`**。Pattern 会 **挪动电容位置**、**自动插入 VCC/GND**，破坏槽位分区；多 cap 同 apply 还会 **竖链导致 +rail 与 GND 并网**（见 `circuit-pattern-layout.md`）。

**规则：** 模块化 **「去耦电容模块」= 拓扑 B（纯 hand）**；**「电源模块 LDO 滤波」= 拓扑 A（pattern）**。拓扑 B 的去耦排应 **紧邻主控列**，MCU 电源脚靠 **alias** 接入，不拉长线。

## P3 已知引擎注意

- `decoupling_cap` **同一 host 一次绑多颗 cap** 会竖链并网 → 仅用于拓扑 A，且仍须 **一颗一 apply**（或 bulk+bypass 两颗一次）。
- 拓扑 B **不得** 使用 pattern；若曾误跑，删该区 pattern 产生的导线/符号后按上表 **手布母线** 重建。
- `pull_resistor` 可能把电阻放在 host 引脚旁 → 若与连接器分属同一模块，**P4a 前** 将器件归位到模块 union 内。
- 网络表路径：`getActivePageNetList` → **`response.result.value.nets[]`**（不是顶层 `nets`）；成员在 `pinReferences[]`。
- 多 section 位号在 netlist 中可能显示为 `U` 而非 `U2`（电气仍连通）。

## 清页 / 重跑（避免框和字叠层）

`getPageOccupancy` / 按 id 删导线 **不会** 删掉 `placeRect` / `placeText`。整页或模块化重画前必须：

1. 删器件+导线（occupancy + `listWireSegments` 轮询 `deleteObjectsByIds`）；
2. **`listPageDecorations` → 删除全部 rect/text**（或 `modular-lib.clearActivePageFull` / `prepareP4aDecorations`）；
3. 清空装饰账本 `clearDecorationLedger`。

只清 part 不清装饰 → **重复框、重复标题、空槽仍有大框**。

## P4a 模块框 + 中文标题（缺一不可）

1. 按模块 **refs** union 器件 bbox + 槽内匿名电源符号（`unionModuleBBox`）；**禁止**用整槽位矩形当框（器件未放进槽时会画出大片空白框）。
2. 四周外扩 **约 40 ext**（`FRAME_PAD`，20 的倍数）；**框边与标题坐标吸附 20 ext 网格**（见 `layout-quality-audit.md`）。
3. 每个模块 **两次 RPC**：`objPlace.placeRect`（`box.min/max` ext）→ **`objPlace.placeText`**（标题在框顶上方约 20–40 ext，`localPos` 与框同 ext 系、Y 向下）。**只画框不写字不算完成 P4a**。
4. **A：`recordDecoration`** 登记 **rect 与 text** 的 `objectId`（见 `decoration-objects.md`）；`layout-audit.ts` 的 `FRAME_RECTS` 只需框 id，但删改/列举时 text 也依赖账本或 `listPageDecorations`。

## P4b 验收（数值 + 整页目视）

**目标**：判断模块是否摆得合理、空白是否过多、P0 页尺寸是否合适。单靠 netlist 或 union 占比不够，应 **先算后看**。

**推荐顺序（模块化任务必做）**

1. **电气**：关键 net 成员表；无单引脚网、无未合并的 `N\d+` 孤儿网。
2. **数值布局**：`npx tsx scripts/layout-audit.ts`（可选 `FRAME_RECTS=` 为 P4a 登记的模块框 id）。看填充率、**最大空白矩形**、页边距均衡、模块间距、框 mod20 对齐。**禁止**用「union 占页面百分比」代替本脚本。
3. **持久化**：`project.saveProject`（PDF 读磁盘上的页，未 save 会偏旧）。
4. **矢量整页 PDF**：`npx tsx scripts/export-layout-pdf.ts` 或 `export.exportSchematicPdf` → 使用返回的 **`filePath`**。脚本报「不含 ExportSchematicPdf」= 客户端包偏旧（见 `rpc-availability.md`），此时 **以第 2 步数值结论交付**，不要因此中断 P4b。把 PDF 交给支持 vision 的模型或本地打开，目视检查：
   - 各 **模块框** 是否包住本区器件、是否与 **中文标题** 对齐；
   - 模块之间是否 **过疏**（大片空白）或 **过挤**；
   - 内容是否 **贴边/偏一角**（P0 页过大或 P1 槽位未居中）；
   - 页边框（P0）相对内容是否 **留白过多**（考虑 P4c 或回退 P0 重估）。
5. **视图**：`canvasOps.zoomAll` 便于用户在编辑器里对照 PDF 路径。

数值与 PDF **互补**：audit 抓「最大空白矩形、间距散度」；PDF 抓「分区是否一眼可读、标题是否在框上、整体是否像成品原理图」。详见 `layout-visual-review.md`、`layout-quality-audit.md`。

## 模板脚本

| 脚本 | 用途 |
| --- | --- |
| `modular-lib.ts` | **planCompactZones** / `atZone` / `estimateModuleBox`（P0 预算）、**clearActivePageFull**、**unionModuleBBox** / **padUnionBox**、**placeModuleFrameAndTitle**、prepareP4aDecorations、recordDecoration / `saveDecorationLedger` / `loadDecorationLedger`、`placeHorizontalRail`（拓扑 B 母线）、**moduleBlastRadius** / `deleteModuleBlastRadius` / `deleteModuleDecorations` / `moveExtBatch`（流程 C） |
| `layout-audit.ts` | 模块密度带、框净距与 mod20、**导线穿框**、最大空白矩形、页边距（模块框自动发现） |
| `export-layout-pdf.ts` | save → 导出当前页矢量 PDF，目视整页效果 |

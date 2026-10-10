# 模块化布局（Scenario B 摘要）

用户要求 **最小系统 / 模块框 / 中文标题 / 分区** 时，在流程 A 之上增加 **P0→P4** 阶段。完整说明见 monorepo `skills/hqeda/modular-placement/`；本文件为 **scenario-b 分发包内** 的必读摘要。

**排版质量（网格版式 / 两遍收拢 / 网格拉框 / 密度带 / 标签走廊）见 [modular-layout-compact.md](modular-layout-compact.md) —— 模块化任务必读，用于避免「模块相距过远、排布不规则」。**

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

**模块框随内容变小时**：对该模块 `refs` 做 `unionModuleBBox` → `frameAroundContent`（留框内标题带/说明带）→ `placeModuleFrameAndTitle`（传 `title` + `note`，只登记本模块 `moduleKey`）。其它模块 **不动**。

**何时才允许整页流程 A**：用户明确「清空重做 / 换整套最小系统 / 新工程从零画」，且确认清页（含装饰）后。

**自己画完第一版后的微调也按本节走**：哪个模块有问题就只 `deleteModuleBlastRadius` 该模块再原框重放重连，不要改一个常量就整页重跑。确需整页重跑时一次只验证一个假设；纯美观问题 3 轮不收敛就截图问用户（并网/断网除外，必须修通）。

详见 `editing-a-circuit.md` § Modular designs。

## 阶段（固定顺序）

```text
P0   模块规划表(key/title/note/refs/col/order/group；≤3 件小块 attachTo) → mergeSmallModules → planCompactZones(grid) → setPageExt
P1   按 atZone(plan.zones[key]) 放器件（禁止整页 magic 坐标；坐标吸附 20 ext 网格）
P2   统一电源/功能网络的命名；电源 / GND 符号（定网络名 ≠ 给每个引脚挂 NetAlias）
P3   applyCircuitPattern（每 pattern 前重读 occupancy）+ 模块内同网引脚 PlaceWire 直连 + placeDecapRow（模块内不放 NetAlias）
P3.5 repackModules：量真实外包 → 重算网格 → 模块整体平移 → set-page-size（必做）
P3c  跨模块一律双端 placeShortStubAlias（stub ≤ 40 ext，禁止导线穿模块框）；同名 NetAlias 合并分段网；删孤儿导线
P4a  placeGridFrames：按网格单元画框 + 框内左上标题 + 框内左下说明（自动 recordDecoration）
P4b  验收：netlist + layout-audit（含网格对齐）+ persistProject → 导出当前页 PDF + zoomAll
```

**P1 完成前不要画模块框。** **跨模块标签必须在 P3.5 之后**（收拢把模块挤到 60 ext 走廊，先挂的长 stub 会越框抓邻居；收拢后按引脚挂短 stub 最稳）。原「P4c 缩页」已并入 P3.5。

## P0 估页（按模块清单反推，禁止固定大页）

1. 列 **模块规划表**：`key` / 中文 `title`（功能电路名）/ `note`（一行必要说明，可选）/ `refs` / **`col`**（列号）/ `order`（列内顺序）/ `group`（同列并排）/ `span`（底部跨列）。主控所在列不限；外围模块按相连的 MCU 引脚就近选列、按引脚高度排序。
2. **按功能电路分模块，不按小电路分**：只有两三个器件的电路块（复位、BOOT、指示灯、CC 下拉、单颗 ESD、LDO 输入输出电容…）**不单独成模块**，用 `attachTo` 并入电气相连、功能上服务的模块，标题写成合并后的功能名（如「主控 ESP32-S3（含复位/BOOT）」「USB Type-C 供电与 USB 接口」）。`mergeSmallModules(MODULES)` 合并，未给 `attachTo` 的小块直接抛错。并入后在同一框内贴近目标引脚摆放，用 PlaceWire 直连。
3. `planCompactZones(mergeSmallModules(MODULES))` → `{ pageW, pageH, zones, cells }`；**主控等多脚器件显式给 `w`/`h`**。单元已含框内标题带（40 ext）与说明带（有 `note` 时 40 ext），`zones` 自动让开。
4. **`setPageExt(client, ctx, plan.pageW, plan.pageH)`**：Custom 页、保持页面上边不动（`ltY = PAGE_TOP − h`、`rbY = PAGE_TOP`）。setPageSize 不移动对象，但直接写 `ltY=0/rbY=pageH` 会把上边挪走，已有对象的 ext 坐标整体偏一个页高。
5. **页尺寸要落盘**：关页/关工程后再打开，读的是工程里 `VxPage.m_pageSizeInfo`，不是上次画布上的临时框。**P4b 结束前必须 `persistProject`（`saveProject`）**；仅调 API 不保存，或未用已修复的 HQ 引擎同步 VxPage 时，会出现「当时对了、重开又回去」。

模块之间只留 `LABEL_CORRIDOR = 60 ext` 走廊、页边 `PAGE_MARGIN = 80 ext`。**禁止**默认 1800×1400 + 固定 500×400 槽（模块相距过远的主因）。网格版式、选列规则与阈值见 [modular-layout-compact.md](modular-layout-compact.md)。

## P1 放置护栏

- 锚点用 `atZone(plan.zones[key], dx, dy)`，`dx/dy` 取 **20 的倍数**；模块内容不要超出 zone。
- 先 `getPageOccupancy({ includeWires: false })`，为新器件选 **非 reserved** 空位。
- 双 section MCU：`sectionPlacements`；电源单元与 GPIO 单元 **垂直堆叠** 时预留 pattern `occupied_box` 高度。
- 每个 pattern apply **前** 重读 occupancy（否则 `AREA_OCCUPIED` 误报）。
- `AREA_OCCUPIED`：若冲突 id 仅为 pattern **host** 自身 bbox，可 `ignoreAreaConflict: true`（簇本体与其它器件无交叠时）。
- 引脚坐标：活动页布局优先 `pinsOf`（`getObjectJsonById` → `PortInstScalar`）。ext.y = `PAGE_TOP` − 原始 y，`PAGE_TOP` 是页面上边的画布 y，**不是** `page_box.max.y`（page_box 被归一化成 `[0,0]-[W,H]`，差一个页高）。`openCtx` / `setPageExt` 已自动 `calibratePageTop`；自写连接代码后也先调一次。
- **禁止**手写与网格无关的 magic 坐标（如 137、1050 混用导致 P4a 无法对齐）。

## 去耦：两种拓扑（不要混用）

| 形态 | 典型位置 | 画法 | 目视目标 |
| --- | --- | --- | --- |
| **A · 电源脚 shunt**（LDO 入/出各 1～2 颗） | 电源模块，host = LDO `VIN`/`VOUT` | **`decoupling_cap`**：每次 apply **最多 1 颗 cap**（或 bulk+`cap_bypass` 一对）；多颗 **多次 apply + anchor 水平错开** | 滤波电容贴在 **LDO 对应引脚一侧** 竖排；**每组**有自己的 +5V/+3V3/GND 符号 |
| **B · 去耦模块并联排**（多颗 100nF 共母线） | **独立模块**，与主控电源单元相邻列、相近高度 | **禁止** `applyCircuitPattern` / **`decoupling_cap`**。**仅 hand**：P1 横排、竖放、等距 80 ext → **`placeDecapRow`**（全 **PlaceWire** 母线）→ 各放 **一个** +3V3/GND 符号，用 **`connectPinsPlaceWire`** 接到最近电容脚；MCU `VDD`/`VDDA` 用 **stub/alias 接到 +3V3** | 模块内 **一排电容**；**一条顶轨 +3V3、一条底轨 GND**，仅一对电源符号 |

**反模式（禁止）：**
- 去耦模块内对 MCU（或其它 host）调用 **`decoupling_cap`**。Pattern 会 **挪动电容位置**、**自动插入 VCC/GND**，破坏模块分区；多 cap 同 apply 还会 **竖链导致 +rail 与 GND 并网**（见 `circuit-pattern-layout.md`）。
- 电容到母线必须用 **`placeDecapRow` / PlaceWire**；**禁止 autoConnect**（自动布线会沿边绕行，出现双母线、竖线贴边）。
- 去耦排内放 **NetAlias**：一排里多处同名标签，收拢或修补时容易漏掉一个。母线上只放一个电源符号、一个 GND。
- 用导线把去耦排直接拉进主控框：一律禁止穿框，两侧各用 +3V3 / GND。

**规则：** 模块化 **「去耦电容模块」= 拓扑 B（纯 hand + `placeDecapRow`）**；**「电源模块 LDO 滤波」= 拓扑 A（pattern）**。

## P3 已知引擎注意

- `decoupling_cap` **同一 host 一次绑多颗 cap** 会竖链并网 → 仅用于拓扑 A，且仍须 **一颗一 apply**（或 bulk+bypass 两颗一次）。
- 拓扑 B **不得** 使用 pattern；若曾误跑，删该区 pattern 产生的导线/符号后按上表 **手布母线** 重建。
- `pull_resistor` 可能把电阻放在 host 引脚旁 → 若与连接器分属同一模块，**P4a 前** 将器件归位到模块 union 内。
- 网络表路径：`getActivePageNetList` → **`response.result.value.nets[]`**（不是顶层 `nets`）；成员在 `pinReferences[]`。
- 多 section 位号在 netlist 中可能显示为 `U` 而非 `U2`（电气仍连通）。
- **导线压到异网导线上就会并网**（典型：+3V3 符号引线与 GND 母线同 x 共线）。`connectPinsPlaceWire` / `wireOrthogonalLExt` / `placeWireSegmentExt` 下线前会检查共线重叠、平行间距 < `WIRE_CLEARANCE`(8 ext)、T 接点，L 形自动换拐角；两拐角都冲突时抛错——挪器件，不要 `check:false`。
- **逐阶段检查点**：电源符号、每个 pattern、模块内连线、P3.5、跨模块 stub 之后各调一次 `checkpointNets(client, ctx, "<阶段>")`，并网会在造成它的那一步就报出来（哪两个命名网络 + 混入的脚）。

## 清页 / 重跑（避免框和字叠层）

`getPageOccupancy` / 按 id 删导线 **不会** 删掉 `placeRect` / `placeText`。整页或模块化重画前必须：

1. 删器件+导线（occupancy + `listWireSegments` 轮询 `deleteObjectsByIds`）；
2. **`listPageDecorations` → 删除全部 rect/text**（或 `modular-lib.clearActivePageFull` / `prepareP4aDecorations`）；
3. 清空装饰账本 `clearDecorationLedger`。

只清 part 不清装饰 → **重复框、重复标题、空槽仍有大框**。

## P3.5 收拢（必做）

```typescript
const r = await repackModules(client, ctx, MODULES, plan);
plan = r.plan;   // P3c / P4a 一律用新 plan
```

**移动模块 ≠ 移动器件**：导线、电源符号、NetAlias 是独立对象，只搬器件会把引脚上的线拖歪（并网）、把符号/标签留在原地（掉网）。`repackModules` 按 **电气连通** 收集每个模块的器件 + 导线 + 电源符号 + NetAlias；跨模块的直连导线只剪「桥」，平移后两侧挂同名短 stub；用真实外包重算网格并 `setPageExt`；整批平移；最后对比收拢前后网表，掉网自动补挂、并网直接抛错。某模块平移残差超过 20 ext 也会抛错停止：此时不要画框，删该模块按新 `plan.zones[key]` 重放。详见 `modular-layout-compact.md` §P3.5。

**禁止**在收拢后用坐标去「补电源符号 / 补母线」：先确认 `PAGE_TOP` 标定正确（`calibratePageTop`），按引脚补网只用 `placeShortStubAlias`，每补一次复核目标网没有混入别的脚。

## P4a 模块框 + 中文标题（缺一不可）

1. **整页模块化用 `placeGridFrames(client, ctx, MODULES, plan)`**：框 = 网格单元，同层同顶同底、同列同左同右，框之间统一隔 `LABEL_CORRIDOR`；默认先清全页旧框/字。
2. 拉齐后某模块密度 **< 35%**（与 `layout-audit.ts` 同算法）或内容超出单元 → 该模块自动退回 **紧框**（`frameAroundContent`：内容外包 + `FRAME_PAD` 40 ext + 标题带/说明带）并报警；按提示合并、并排或换列后再跑。4 件左右的独立小模块不按密度退回；≤ 3 件的模块会报警要求 `attachTo` 合并。
3. 单元内没有对象不画框，**禁止空框**。
4. 每个框都是 `placeRect` + **标题 `placeText`（框内左上角 `x1+20, y1+24`）** + **说明 `placeText`（`note` 非空时，框内左下角 `x1+20, y2−16`，字号略小）** + **`recordDecoration`**；**只画框不写字不算完成 P4a**。说明只写必要信息（关键取值、接法、注意事项），一行为宜。
5. 流程 C 单模块修补不用 `placeGridFrames`：用 `deleteModuleDecorations` + `unionModuleBBox` + `frameAroundContent` + `placeModuleFrameAndTitle` 只重画该模块。

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
   - 整页外轮廓是否为矩形、框边是否对齐（不齐 → 检查是否跳过 P3.5 或手画了框）。
5. **视图**：`canvasOps.zoomAll` 便于用户在编辑器里对照 PDF 路径。

数值与 PDF **互补**：audit 抓「最大空白矩形、间距散度」；PDF 抓「分区是否一眼可读、标题是否在框上、整体是否像成品原理图」。详见 `layout-visual-review.md`、`layout-quality-audit.md`。

## 模板脚本

| 脚本 | 用途 |
| --- | --- |
| `modular-lib.ts` | **planCompactZones**（grid：`col`/`order`/`group`/`span`）/ `atZone` / `estimateModuleBox`（P0）、**placeDecapRow**（拓扑 B）、`setPageExt` / `calibratePageTop`（改页 / 坐标标定）、**repackModules** / `buildPageGraph` / `netMembership` / `diffNetMembership`（P3.5）、**placeShortStubAlias**（P3c 跨模块）、**placeGridFrames**（P4a）、**clearActivePageFull**、`unionModuleBBox` / `padUnionBox` / `placeModuleFrameAndTitle`、prepareP4aDecorations、recordDecoration / `saveDecorationLedger` / `loadDecorationLedger`、**moduleBlastRadius** / `deleteModuleBlastRadius` / `deleteModuleDecorations` / `moveExtBatch`（流程 C） |
| `layout-audit.ts` | 模块密度带、框净距与 mod20、**网格对齐与间距统一**、**导线穿框**、最大空白矩形、页边距（模块框自动发现） |
| `export-layout-pdf.ts` | save → 导出当前页矢量 PDF，目视整页效果 |

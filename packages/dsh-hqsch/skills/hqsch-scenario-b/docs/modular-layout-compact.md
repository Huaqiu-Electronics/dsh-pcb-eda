# 模块化排版：规整网格、两遍收拢、页面刚好

解决「模块之间距离过大、排布不规则、整页像散点图」。与 `modular-layout.md` 的 **P0→P4** 同一流程，本文补 **网格版式、两遍收拢、网格拉框、密度带、标签走廊**；数值与 `template/scripts/layout-audit.ts` 的阈值一致。

## 核心思路

规整不是把器件挤到一起，而是四件事对齐：

1. **版式是一张网格**：若干列，每列自上而下堆模块，所有列顶边对齐、底边对齐，整页外轮廓是一个矩形；
2. **尺寸用量出来的，不用估出来的**：先按估算放，接完模块内线后量每个模块的真实外包，重算网格并整体平移（P3.5）；
3. **框按网格单元画**：同层同顶同底、同列同左同右，框之间统一隔一个走廊；
4. **所有对象锁同一网格**（`EXT_GRID = 20 ext`），用密度带判断松紧。

**页面刚好** 的可操作定义：`layout-audit.ts` 无 ❌（含「网格对齐」）；各模块密度 **≥ 35%**；最大空白矩形 **≤ 10%** 页面；页边距 **max/min ≤ 2**。

## 网格版式

```text
+------------+--------------+-----------+      +-------------+---------+-------------+
| 输入模块   |              |           |      | 去耦模块    |         | LDO 模块    |
+------------+  主控/语音   |  驱动模块 |      +------+------+  主控   +------+------+
| 麦克风模块 |              |           |      | 复位 | 晶振 |         | SWD  | 输入 |
+------------+--------------+-----------+      +------+------+---------+------+------+
| 测试点模块（跨两列）      |
+---------------------------+
```

两种都合法。规则：

- 页面分 **2～4 列**；每个模块属于一列（`col`），列内按 `order` 自上而下堆叠。
- 一列里某一层可以 **并排** 两个小模块（同 `group`），它们同顶同底、平分列宽。
- 可以有一条放在网格下方、**跨多列** 的整宽模块（`span`），适合测试点、接口汇总。
- **主控所在列不限**（左、中、右都行），通常独占一列；两个 section 上下叠在同一个模块里。
- 较矮的列会被拉到与最高列同高（余量分摊到各层），所以整页外轮廓始终是矩形。

### 怎么给模块选列和顺序

- 先定主控列；与主控 **同一侧引脚** 相连的外围模块放在相邻列。
- 列内顺序按 **相连的 MCU 引脚高度**：靠上的引脚（BOOT0、时钟）对应的模块排上面，电源单元对应的去耦排放下面。
- 两三个器件的小电路（复位、BOOT、CC 下拉…）**不占网格单元**，先并入相连的功能模块（见「合并模块」）；剩下 4 件左右的独立模块再考虑 **并排成一层**。
- 一列里模块太多、明显高于主控时，把一个模块挪到更矮的列，或合并（见下文「合并模块」）。

反模式：所有外围模块平铺成一长行，行高被主控撑高 —— 上下大片空白，对不齐。

## P0：按模块清单反推页面

**禁止**默认 `1800×1400` 起步 + 固定 `500×400` 槽 —— 这是模块相距过远的主因。

```typescript
import { mergeSmallModules, planCompactZones, setPageExt, type ModuleSpec } from "./modular-lib";

const MODULES: ModuleSpec[] = mergeSmallModules([
  { key: "usb",   title: "USB Type-C 供电与 USB 接口", refs: ["J1", "U4"], col: 0, order: 0,
    note: "CC1/CC2 各 5.1k 下拉；D+/D- 经 ESD 后接主控" },
  { key: "cc",    title: "", refs: ["R1", "R2"], attachTo: "usb" },          // 2 件：并入 USB
  { key: "ldo",   title: "3.3V 稳压电源", refs: ["U1", "C1", "C2", "L1", "C3"], col: 1, order: 0,
    note: "5V→3.3V，输出 22µF×2" },
  { key: "mcu",   title: "主控 ESP32-S3（含复位/BOOT）", refs: ["U2"], col: 2, order: 0, w: 420, h: 520,
    note: "3V3 每脚 0.1µF；EN 10k+1µF RC 复位" },
  { key: "reset", title: "", refs: ["R3", "C7", "SW1"], attachTo: "mcu" },  // 3 件：并入主控
  { key: "boot",  title: "", refs: ["R4", "SW2"], attachTo: "mcu" },
]);

let plan = planCompactZones(MODULES);           // layout 默认 "grid"
await setPageExt(client, ctx, plan.pageW, plan.pageH);   // 保持页面上边不动
```

- **两三个器件的电路块不单独成模块**（`MERGE_MAX_PARTS = 3`）：复位、BOOT、指示灯、CC 下拉、单颗 ESD、单路上拉等，用 `attachTo` 并入 **电气上与之相连、功能上服务的** 模块，组成一个功能电路（如「主控（含复位/BOOT）」「USB 接口（含 CC 下拉）」）。`mergeSmallModules` 合并 refs 并放大尺寸；小块未给 `attachTo` 会直接抛错。
- 并入后它就是模块内部电路：在同一框内贴近目标引脚摆放，**模块内用 PlaceWire 直连**，不再走跨模块 stub/alias。
- 合并后的模块 `title` 要写成功能名（必要时括注所含小电路），`note` 写一行必要说明（关键取值、接法），P4a 会画在框内左下角。

- **改页一律用 `setPageExt`，不要直接 `setPageSize({ ltY: 0, rbY: pageH })`**。ext 坐标 = 页面上边的画布 y − 原始 y；`ltY=0/rbY=pageH` 会把上边从 1400 挪到 pageH，已有对象的 ext 坐标整体偏一个页高（pattern 还会报 anchor outside the page）。
- **改页后要保存工程**：`setPageSize` 只改当前会话里的页框；关页再开时从 **`VxPage.m_pageSizeInfo`** 恢复。脚本在验收通过后用 `persistProject`（`saveProject`）。若 HQ 未打「Custom 改页写回 VxPage」的补丁，即使 save 也可能只存旧尺寸——需升级 Jupiter_2 侧 `SCH_Backend_SetPageSize`。
- **`PAGE_TOP` 不是 `page_box.max.y`**：page_box 被归一化成 `[0,0]-[W,H]`。库里用 `calibratePageTop` 按引脚/导线标定（`openCtx`、`setPageExt`、`repackModules` 已自动调用）。用错 `PAGE_TOP` 时，按引脚坐标摆的符号/母线会落到别的网络旁边，直接并网。
- 返回 `zones[key]`（内容放置区，含 `FRAME_PAD`，已让出框内顶部标题带和底部说明带）与 `cells[key]`（网格单元，P4a 画框用）。
- `refs` 个数 → `estimateModuleBox()` 粗估；**主控/多脚器件务必显式给 `w`/`h`**。估不准没关系，P3.5 会用真实尺寸重算。
- P1 用 `atZone(plan.zones[key], dx, dy)` 取锚点，**dx/dy 用 20 的倍数**。
- 旧版三行布局保留为 `planCompactZones(MODULES, { layout: "rows" })`（模块用 `band`），新任务不要用。

## 网格与最小间距

| 项 | 值（ext） | 说明 |
| --- | --- | --- |
| 吸附网格 `EXT_GRID` | **20** | 器件坐标、框边、标题坐标 |
| 内容 → 框 `FRAME_PAD` | **40** | 内容放置区四周留白；紧框也用它 |
| 框 ↔ 框（标签走廊）`LABEL_CORRIDOR` | **60** | 全页统一；走廊只给跨模块 stub/网络名 |
| 页边 `PAGE_MARGIN` | **80** | page_box 到外轮廓 |
| 标题带 `TITLE_BAND` | **40** | 框内顶部；标题在 **框内左上角** `(x1+20, y1+24)` |
| 说明带 `NOTE_BAND` | **40** | 仅 `note` 非空时预留；说明在 **框内左下角** `(x1+20, y2−16)` |
| 模块内行距 | 统一 **60 或 80** | 忌一个模块内混用多种间距 |

## 跨模块只走 NetAlias

| 范围 | 做法 |
| --- | --- |
| **模块内** | 短正交 **`PlaceWire`**（`connectPinsPlaceWire`，routing gate：≤300 ext 且交叉 <3）；去耦并联排用 `placeDecapRow`；**禁止手布 autoConnect** |
| **跨模块** | **双端 `placeShortStubAlias`（同名 netName）**；`+3V3`、`GND`、`NRST`、`HSE_IN/OUT`、`SWDIO/SWCLK`、`BOOT0` 等一律如此 |

**硬性**：导线 **不得穿过任何模块框**。去耦排与 MCU 电源脚也不例外 —— 两边各用 +3V3 / GND 符号或标签，靠 **位置相邻** 表达关系。

**stub 必须短于走廊**：`placeShortStubAlias` 把 `maxStubLength` 限制在 40 ext（< 60 ext 走廊）。直接调 `placePinStubWireAndNetAlias` 默认可伸到 300 ext，收拢后模块挤紧，stub 会跨走廊抓到隔壁模块的线而并网。小器件（按键、电阻、电容）补网也只用短 stub，**不要在 6×6 按键的相邻脚之间拉器件内连线**（会跨过另一组触点，把 NRST 并进 GND）。

## P3.5：两遍收拢（必做，且在跨模块标签之前）

P1 按估算放置，估算总会偏大或偏小。放完器件、pattern 与模块内连线后：

```typescript
import { repackModules } from "./modular-lib";

const r = await repackModules(client, ctx, MODULES, plan);
plan = r.plan;            // 之后的 P3c / P4a 一律用新 plan
if (r.overlaps.length) throw new Error("收拢后模块重叠，先处理再继续");
if (r.netIssues.lost.length) console.warn("收拢后仍有掉网，P4b 网表自检时补");
// 出现并网（短路）时 repackModules 默认直接抛错
```

**移动模块 ≠ 移动器件。** 导线、电源符号、NetAlias 都是独立对象，不是器件的子对象，平移只作用于传入的 id。只搬器件时，引脚上的线被拖着走，端点扫过走廊就把两个网并成一个（短路），留在原地的电源符号/标签则让引脚掉网。`repackModules` 因此按 **电气连通** 而不是几何框收集：

1. 记录收拢前网表；标定 `PAGE_TOP`；从每个模块的引脚出发沿导线求连通分量，分量里的导线、电源/GND 符号、NetAlias 全部归该模块（`buildPageGraph`）；
2. 同一分量跨了两个模块（例如 pattern 把晶振簇直接连到 MCU 引脚）→ 只剪掉中间的「桥」导线，平移后两侧各挂一个短 stub + 同名 NetAlias；剪不开（引脚直接相碰）就抛错；
3. 用真实外包（含导线、符号、标签）重跑 `planCompactZones`，`setPageExt` 改页，每个模块整批 `moveExtBatch`；
4. 复核网表：掉网的脚按原网名补挂短 stub；出现并网默认抛错停止（`strictNets: false` 只报警）；复查模块不重叠。

**仍然要在跨模块标签之前**：收拢会把模块挤到 60 ext 走廊，之前挂的跨模块 stub 若较长就会越框抓邻居；P3c 在收拢后按引脚挂短 stub 最稳。顺序：P3（模块内）→ **P3.5 收拢** → P3c（跨模块短 stub+alias）→ P4a。

## P4a：按网格单元画框

```typescript
import { placeGridFrames } from "./modular-lib";

const frames = await placeGridFrames(client, ctx, MODULES, plan);   // 默认先清全页旧框/字
```

- 框 = 网格单元：同层同顶同底、同列同左同右，框之间统一隔 `LABEL_CORRIDOR`。
- 标题写在 **框内左上角**，`note` 写在 **框内左下角**（字号略小）；单元已预留标题带/说明带，器件不会被压。紧框退回时用 `frameAroundContent`，同样留带。
- 仍有 ≤ 3 个器件的模块会报警：回 P0 用 `attachTo` 并入相连模块。
- 每个框按与 `layout-audit.ts` 相同的算法算密度：**低于 35%** 时退回 **紧框**（内容外包 + `FRAME_PAD`）并报警，提示把该模块与同列小模块合并、改为并排，或换到更矮的列。
- 器件 **4 个** 左右、确实独立成块的模块（`SMALL_MODULE_PARTS`，如晶振 + 两颗负载电容 + 反馈电阻、调试排针）本体只占几格，**不按密度退回**，始终画网格框；审计里只提示不报警。≤ 3 个器件的应已合并，不在此列。
- 内容超出单元（P3.5 没做，或之后又加了器件）也退回紧框并报警。
- 单元内没有对象不画框（禁止空框）。框和标题都会 `recordDecoration`。
- 流程 C 单模块修补 **不要** 用它（它默认清全页装饰）；单模块用 `placeModuleFrameAndTitle`。

## 模块内紧凑约定

- 信号链沿 **同一水平中心线**：源 → 串联器件 → 负载。
- 去耦并联排：电容横排、竖放、等距 80 ext，`placeDecapRow` 画上下母线，**只放一个** 电源符号与 **一个** GND（拓扑见 `modular-layout.md` §去耦两种拓扑）。
- 晶振放两个时钟网络标签之间，负载电容 **向下** 接 GND。
- 复位：`NRST` 水平母线成 T 形，上拉向上、按键/电容向下接 GND。
- 连接器/排针靠模块 **外侧**，网络名朝 **框内**。
- pattern 的 `occupiedBox` 要 **计入本模块单元**；同一 MCU 边上避免两个 pattern 抢同一侧。

### 模块内同网直连，不用网络名拼接

**同一模块框内、同一个网络的引脚，一律用导线连起来**；网络名（NetAlias）只用于这个网络 **离开本模块** 的那一端。适用于所有模块内连接，不只是小电路：

- MCU 引脚 ↔ 并入主控模块的上拉、按键、电容、LED；
- 按键 + 上拉、LED + 限流电阻、复位 RC 这类 2～3 个器件的小电路内部；
- 稳压芯片 ↔ 它的输入/输出电容、电感。

做法：**先把器件摆成能直接相连的位置，再用 `connectPinsPlaceWire` 连线**。连线前按网络分组：一个网络在本模块内的所有引脚连成一棵树（直线或 L 形），整棵树最多在朝向框外的一端挂 **一个** 短 stub + NetAlias。

**反例 1**（主控模块，最常见）：U2 的 `IO0` 挂一个 `BOOT` 标签，旁边 R5 上端挂一个 `BOOT`，SW2 一端再挂一个 `BOOT₁`——三个器件在同一框内、相距不到 200 ext，却靠三个同名标签相连。应该：R5、SW2 摆在 `IO0` 引脚正右侧，`IO0` → R5 下端 / SW2 一端用导线直连成 T 形，R5 上端接 `+3V3` 符号，SW2 另一端接 `GND` 符号，**一个 BOOT 标签都不需要**（除非 BOOT 还要接到框外的排针）。

**反例 2**（小电路）：R7 在上、SW3 在左，两者各挂一个 `KEY1` 标签靠同名相连；R9 与 D1 之间再挂 `LED_A` 标签。每个器件都是孤岛，读图要靠找同名标签。

**正例**（参考版式，同一模块框内三列并排）：

| 子电路 | 摆放 | 模块内连线 |
| --- | --- | --- |
| 按键 KEY1 | 上拉 R7 **竖放**，SW3 在 R7 **正下方**，两者同列（x 对齐到 20 ext 网格） | `+3V3` 电源符号 → R7 上端；R7 下端 → SW3 一端；SW3 另一端 → `GND` 符号；全部 `connectPinsPlaceWire` |
| 按键 KEY2 | 与 KEY1 相同，向右平移一列（列距 160～240 ext） | 同上 |
| 状态 LED | R9 竖放，D1 **横放在 R9 下端右侧**，D1 阴极/阳极与 R9 下端同一水平线 | `LED` 网 → R9 上端；R9 下端 → D1；D1 另一端 → `GND` 符号 |

要点：

- R 与 SW、R 与 LED 之间是 **一段直线或一个 L 形**，不出现网络名。
- 电源/地用 **电源符号**（`+3V3`、`GND`）贴在器件引脚端，每个子电路各一个，不靠标签跨区拉网。
- 只有 **R–SW 中间节点到 MCU 的 KEY1**、**LED 网到 MCU 引脚** 这类跨模块连接才用 `placeShortStubAlias`（≤ 40 ext）；如果 MCU 就在同一模块内且距离短，也直接 `connectPinsPlaceWire`。
- 先定位置再连线：P1 就把并入主控的外围器件放在 **对应 MCU 引脚的同侧、正对引脚高度**，小电路按上表相对位置放（同列、上下相邻、间距 80～120 ext），不要先随手放下再用 stub+alias 补网。
- 同一网络在同一模块内 **最多一个** NetAlias；出现两个及以上同名标签，就是该改成直连。
- 自检：模块内每出现一个 NetAlias，都要能回答「它连到了框外哪里」；答不上来就是该改成直连。

## 合并模块（按功能电路分框）

模块 = **功能电路**，不是「每个小电路一框」。两三个器件的电路块必须并入相连的功能模块（`attachTo`）：

| 小电路块 | 并入 | 合并后标题示例 |
| --- | --- | --- |
| 复位 RC + 按键、BOOT 按键 + 上拉、状态 LED + 限流电阻 | 主控 | 「主控 ESP32-S3（含复位/BOOT）」 |
| 无源晶振 + 2 颗负载电容 | 主控（或独立「时钟模块」，若 ≥ 4 件） | 「主控 STM32F103（含 8MHz 晶振）」 |
| CC1/CC2 下拉、USB ESD | USB 接口 | 「USB Type-C 供电与 USB 接口」 |
| 输入/输出电容、电感 | 稳压芯片 | 「3.3V 同步降压电源」 |
| 功放/麦克风的去耦、增益电阻 | 对应的音频芯片 | 「I2S 数字功放与扬声器」 |
| SWD 排针 + 上拉 | 主控，或与串口合成「调试接口」 | 「调试接口（SWD/UART）」 |

模块数少，网格更容易拉齐、拉框后密度也更高。**多颗并联的去耦排**（≥ 4 颗）可保持独立，与主控电源单元放在相邻列、相近高度。

## 密度带：松紧旋钮

`layout-audit.ts` 输出与建议动作：

| 指标 | 目标 | 偏离时怎么做 |
| --- | --- | --- |
| 单模块密度（框内 20 ext 网格占用） | **35%～70%**（≤ 4 个器件的小模块不判下限） | **< 35%** → 合并、并排或换列；**> 70%** → 拆分 |
| 网格对齐 | 每条框边贴外轮廓 / 与另一框同边 / 与相邻框隔一个走廊 | ❌ → 重跑 `repackModules` + `placeGridFrames` |
| 相邻框间距 | 统一（极差 ≤ 20） | ❌ → 用 `planCompactZones` grid，勿手写坐标 |
| 六分区占用（2×3，50 ext 网格） | **≤ 72%** | 超出 → 拆模块或加大页 |
| 最大空白矩形 / 页面 | **≤ 10%** | 超出 → 检查是否跳过 P3.5 |
| 页边距 max/min | **≤ 2** | 超出 → 检查是否跳过 P3.5 |
| 框边 mod 20 | 全部 **0** | 否则 P1/P4a 有非网格坐标 |
| 导线穿模块框 | **0** | 改双端 stub+alias |

阈值是 **起始经验值**，可按项目调整；但「导线穿框」「框内无器件」「内容贴框」应始终为 0。

## 迭代顺序

1. **P0** 模块规划表（key / title / note / refs / col / order / group；小块 `attachTo`）→ `mergeSmallModules` → `planCompactZones` → `setPageExt`。
2. **P1** 按 `atZone` 放器件；**此时不画框**。
3. **P2/P3** 电源符号、网络名、pattern、模块内连线、`placeDecapRow`。
4. **P3.5** `repackModules` → 新 plan + 新页尺寸。
5. **P3c** 跨模块双端 stub+alias。
6. **P4a** `placeGridFrames`。
7. **P4b** `layout-audit.ts` → 按上表调整；再 `saveProject` + `export-layout-pdf.ts` 目视。

修正优先级：**导线穿框 / 框内无器件 / 内容贴框** → **网格对齐与间距** → **模块过空** → 最后才考虑换更大页。

## 检查单

- [ ] 模块规划表每项都有 `col`；同列顺序按相连 MCU 引脚高度
- [ ] 没有 ≤ 3 个器件的独立模块；小电路块已 `attachTo` 并入相连的功能模块
- [ ] 每个模块有功能标题；需要时有一行 `note`
- [ ] 页面由 `planCompactZones` 算出，不是固定大页
- [ ] 跑过 P3.5 `repackModules`，且在跨模块标签之前；输出无并网、`netIssues.lost` 已补齐
- [ ] 改页只用 `setPageExt`；没有手写 `ltY=0/rbY=pageH`，没有用 `page_box.max.y` 当 `PAGE_TOP`
- [ ] 跨模块 stub 全部用 `placeShortStubAlias`（≤ 40 ext）
- [ ] 框由 `placeGridFrames` 画出；退回紧框的模块已处理（合并 / 并排 / 换列）
- [ ] 所有框边、器件坐标 mod 20 = 0
- [ ] 跨模块 0 长飞线、0 导线穿框
- [ ] `layout-audit.ts` 网格对齐 ✅、相邻框间距统一 ✅
- [ ] PDF 目视：整页外轮廓为矩形，标题在框内左上角、说明在框内左下角，均不压内容

## 相关文档

| 文件 | 内容 |
| --- | --- |
| `modular-layout.md` | P0→P4 主流程、去耦两种拓扑、单模块修补 |
| `layout-quality-audit.md` | 审计指标与反面模式 |
| `layout-visual-review.md` | save → 导出 PDF 目视验收 |
| `placement-conventions.md` | routing gate、stub/alias 细则 |

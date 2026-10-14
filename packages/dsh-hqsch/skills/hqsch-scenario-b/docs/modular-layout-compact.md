# 模块化排版：规则、紧凑、页面刚好

解决「模块之间距离过大、排布不规则、整页像散点图」。与 `modular-layout.md` 的 **P0→P4** 同一流程，本文补 **面积预算、宏观区位、密度带、标签走廊** 四件事；数值与 `template/scripts/layout-audit.ts` 的阈值一致。

## 核心思路

紧凑不是把器件挤到一起，而是三件事对齐：

1. **页面按模块清单算出来**（不是先定一张大页再往里撒器件）；
2. **所有对象锁同一网格**（`EXT_GRID = 20 ext`，框边/标题/器件关键点都是它的整数倍）；
3. **用密度带反推布局**（模块太空就缩框或合并，整页太挤才加页），而不是凭感觉。

**页面刚好** 的可操作定义：`layout-audit.ts` 无 ❌；各模块密度落在 **35%～70%**；最大空白矩形 **≤ 10%** 页面；页边距 **max/min ≤ 2**。

## P0：按模块清单反推页面（替代固定大页）

**禁止**默认 `1800×1400` 起步 + 固定 `500×400` 槽 —— 这是模块相距过远的主因。

```typescript
import { planCompactZones, type ModuleSpec } from "./modular-lib";

const MODULES: ModuleSpec[] = [
  { key: "power",    title: "电源模块 5V→3.3V", refs: ["J1", "U1", "C1", "C2"], band: "top" },
  { key: "decouple", title: "去耦电容模块",      refs: ["C10", "C11", "C12", "C13"], band: "top" },
  { key: "debug",    title: "SWD 调试模块",      refs: ["J3"], band: "left" },
  { key: "crystal",  title: "晶振模块 8MHz",     refs: ["Y1", "C3", "C4"], band: "left" },
  { key: "mcu",      title: "主控模块",          refs: ["U2"], band: "center", w: 420, h: 620 },
  { key: "reset",    title: "复位模块 NRST",     refs: ["R1", "C9", "SW1"], band: "right" },
];

const { pageW, pageH, zones } = planCompactZones(MODULES);
await client.canvasOps.setPageSize({
  context: ctx, ltX: 0, ltY: 0, rbX: pageW, rbY: pageH,
  showBorder: true, pageSizeLabel: "Custom",
} as never);
```

- `refs` 个数 → `estimateModuleBox()` 粗估内容尺寸；**主控/多脚器件务必显式给 `w`/`h`**（估算会偏小）。
- 模块之间只留 `LABEL_CORRIDOR = 60 ext`；页边 `PAGE_MARGIN = 80 ext`。
- P1 用 `atZone(zones[key], dx, dy)` 取槽内锚点，**dx/dy 用 20 的倍数**。
- 估页偏差在 **P4c** 用真实 union 修正；`setPageSize` 不移动已有对象。

## 宏观区位模板（解决「不规则」）

固定阅读结构，与芯片无关。`planCompactZones` 的 `band` 即对应此模板：

```text
+--------------------------------------------------------------+
|  [电源/输入]   [稳压·去耦]            [外设/显示]            |  top
|  [调试/下载]   [==== 主控 ====]       [复位·按键·接口]       |  left | center | right
|  [辅助/安装]                                                 |  bottom
+--------------------------------------------------------------+
```

- **主控最大**，位于中部/中下部，作为视觉锚点；
- 电源与去耦沿 **顶部**；调试/下载在 **左**；复位、按键、排针在 **右**；
- **同一带内各框顶边对齐**（同一 `y1`），带与带之间只差一个走廊；
- 相邻框 **共边或平行边相差 20 ext 的整数倍**。

反模式：电源在左上、晶振漂在页面正中、主控挤在右下 —— 对角线式散布，一定会留大块空白。

## 网格与最小间距

| 项 | 值（ext） | 说明 |
| --- | --- | --- |
| 吸附网格 `EXT_GRID` | **20** | 器件坐标、框边、标题坐标 |
| 内容 → 模块框 `FRAME_PAD` | **40** | `padUnionBox` 默认；最小不低于 `MIN_CONTENT_CLEARANCE = 20` |
| 框 ↔ 框（标签走廊）`LABEL_CORRIDOR` | **60**（40～120） | 给 stub 与网络名；**不是**给长导线 |
| 页边 `PAGE_MARGIN` | **80** | page_box 到最外框 |
| 标题基线 | 框 `y1 − 24` | 见 `modular-layout.md` P4a |
| 模块内行距 | 统一 **60 或 80** | 忌一个模块内混用多种间距 |

## 跨模块只走 NetAlias（对紧凑影响最大）

| 范围 | 做法 |
| --- | --- |
| **模块内** | 短正交线 `autoConnectObjectsById`（routing gate：≤300 ext 且交叉 <3） |
| **跨模块** | **双端 `placePinStubWireAndNetAlias`（同名 netName）**；`+3V3`、`GND`、`NRST`、`HSE_IN/OUT`、`SWDIO/SWCLK` 等一律如此 |

**硬性**：导线 **不得穿过任何模块框**。`layout-audit.ts` 的「导线穿模块框」为 ❌ 项，出现即改成 stub+alias。有了标签走廊，模块框才能彼此靠近而不失可读性。

## 模块内紧凑约定

- 信号链沿 **同一水平中心线**：源 → 串联器件 → 负载。
- 去耦/滤波：**上电源轨、下 GND**（拓扑见 `modular-layout.md` §去耦两种拓扑）。
- 晶振放 MCU 两个时钟脚之间，负载电容 **向下** 接 GND。
- 复位：`NRST` 水平母线成 T 形，上拉向上、按键/电容向下接 GND。
- 连接器/排针靠模块 **外侧**，网络名朝 **框内** 或页面空白，别堆在走廊里。
- pattern 的 `occupiedBox` 要 **计入本模块槽位**；同一 MCU 边上避免两个 pattern 抢同一侧（如晶振放左、复位放右）。

## 合并模块（减框、更整齐）

| 可合并 | 效果 |
| --- | --- |
| 晶振 + 负载电容 | 单「时钟模块」，少一个框与跨区线 |
| 复位 + 按键 | 单「复位/按键模块」 |
| SWD + BOOT/串口（同为调试排针） | 单「调试接口模块」 |

模块数少 1～2 个，整页往往更紧凑、框更容易对齐。**去耦排保持独立**，但应 **紧邻主控列**，靠 alias 接 `+3V3`。

## 密度带：松紧旋钮

`layout-audit.ts` 输出与建议动作：

| 指标 | 目标 | 偏离时怎么做 |
| --- | --- | --- |
| 单模块密度（框内 20 ext 网格占用） | **35%～70%** | **< 35%** → 缩框（减 pad）或与邻模块合并；**> 70%** → 略扩框或拆分 |
| 六分区占用（2×3 分块，50 ext 网格） | **≤ 72%** | 超出 → 拆模块或加大 Custom 页 |
| 最大空白矩形 / 页面 | **≤ 10%** | 超出 → 走廊收到 60 ext、模块向主控收拢，或 P4c 缩页 |
| 页边距 max/min | **≤ 2** | 超出 → 整体平移居中 |
| 最近邻框间距 | **60～120 ext** | 过小 → 补走廊；**> 180** → 向主控收拢 |
| 框边 mod 20 | 全部 **0** | 否则 P1/P4a 有非网格坐标 |
| 导线穿模块框 | **0** | 改双端 stub+alias |

阈值是 **起始经验值**，可按项目调整；但「导线穿框」「框内无器件」「内容贴框」应始终为 0。

## 迭代顺序（先摆稳再画框）

1. **P0** `planCompactZones` → `setPageSize`；打印模块规划表（key/band/refs/预估尺寸）。
2. **P1** 按 `atZone` 放器件；`getPageOccupancy` 确认无重叠；**此时不画框**。
3. **P2/P3** 网络名 + pattern + routing gate 补线；跨模块一律 alias。
4. **P4a** 器件稳定后 `unionModuleBBox` + `padUnionBox` → `placeModuleFrameAndTitle`。
5. **P4b** `layout-audit.ts` → 按上表调整；再 `saveProject` + `export-layout-pdf.ts` 目视。
6. **P4c** 仅当估页明显偏大：按真实 union 缩 Custom 页（不移动器件）。

修正优先级：**导线穿框 / 框内无器件 / 内容贴框** → **模块过空或过远** → **页边距与整页空白** → 最后才考虑换更大页。

## 检查单

- [ ] 页面由 `planCompactZones` 算出，不是固定大页
- [ ] 每个模块有 `band`，同带框顶边对齐
- [ ] 所有框边、器件坐标 mod 20 = 0
- [ ] 跨模块 0 长飞线、0 导线穿框
- [ ] 各模块密度 35%～70%；无空框
- [ ] 最大空白矩形 ≤ 10% 页面；页边距 max/min ≤ 2
- [ ] PDF 目视：主控为视觉锚点，标题在框上方且不压内容

## 相关文档

| 文件 | 内容 |
| --- | --- |
| `modular-layout.md` | P0→P4 主流程、去耦两种拓扑、单模块修补 |
| `layout-quality-audit.md` | 审计指标与反面模式 |
| `layout-visual-review.md` | save → 导出 PDF 目视验收 |
| `placement-conventions.md` | routing gate、stub/alias 细则 |

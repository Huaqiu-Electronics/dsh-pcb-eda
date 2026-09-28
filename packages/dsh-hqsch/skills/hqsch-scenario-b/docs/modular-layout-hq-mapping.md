# KiCad 模块化文档 → HQ EDA 映射

本文档说明如何把 [modular-placement.md](../../../../modular-placement.md) 里的概念落到 HQ EDA skill / RPC 上。**HQ 试跑以本文为准**；KiCad 的 `audit_schematic.py`、S 表达式解析在 hq-edge 仓库中**不存在**，不要调用。

> **维护说明**：`skills/hqeda/modular-placement/` 下文档为人工编写，**不会被** `pnpm capability:generate` 覆盖（生成器目标为 `skills/hqeda/generated/` 与 `skills/eda/**` 等）。

## 阶段对照（Gate → Phase）

| KiCad Gate | HQ Phase | 允许的对象 | 主要 RPC / 文档 |
| --- | --- | --- | --- |
| （规划） | **P0 定页** | 仅改活动页尺寸 | `canvas-set-page-size`（Custom 或 A4 等） |
| Gate 1 放置 | **P1 布局** | 器件实例、Reference/Value | `placement-place-kicad-symbol`、`pattern-layout-get-page-occupancy` |
| Gate 2 网络名 | **P2 命名** | 电源符号、GND、功能 **NetAlias** | `placement-place-symbol-from-library`、`obj-place-place-net-alias-at` |
| Gate 3 布线 | **P3 连接** | 模块内短线；模块间标签 | `pattern-layout-apply-circuit-pattern`；余网 [routing mode gate](../../guides/placement-conventions.md) |
| 收尾 | **P4a 框/标题** | 模块矩形、中文标题、清理孤儿线 | `obj-place-place-rect`、`obj-place-place-text`、`canvas-delete-objects-by-ids` |
| ERC / 网络表 | **P4b 验电** | 只读 + 保存 + 视图 | `kernel-get-snapshot`、`netlist-get-*`、`canvas-zoom-all`、`project-save-project` |
| （可选） | **P4c 裁边** | 微调 Custom 页矩形 | `canvas-set-page-size`（Custom，union 实际内容） |

**规则（与 KiCad 一致）**：器件与模块框位置未稳定前，**不要**大量 `PlaceWire` / 长距离 `autoConnect`。

P1 允许「零网络」或未连接引脚；进入 P3 后电源脚、NRST 等不应长期悬空。

### `setPageSize` 语义（必读）

| 事实 | 含义 |
| --- | --- |
| **不移动对象** | 只改页边框 / `page_box`；器件 ext 坐标不变 |
| **P0** | 在 **空页或清页后** 设定布局画布，避免在默认巨页上拉距 |
| **P4c** | 在 **P4b 验电通过后** 可选裁边；**不能**替代 P1 的 occupancy 放置 |
| 标准纸型 | `pageSizeLabel: "A4"` 等，**勿手猜** lt/rb（见 [canvas-set-page-size](../../eda/canvas/set-page-size/SKILL.md)） |
| Custom | `pageSizeLabel: "Custom"` + **`ltX, ltY, rbX, rbY`**（与页面尺寸对话框同一矩形语义） |

---

## P0：按复杂度设定 Custom 页

### 输入

1. Agent **模块规划表**（模块数、是否双 section MCU、各模块 pattern）；  
2. `pattern-layout-list-circuit-patterns` 或 [circuit-pattern-layout.md](../../guides/circuit-pattern-layout.md) 中的 **`typical_size` / `anchor_semantics`**（估 reserved）；  
3. 标题栏预留（右下）。

### 复杂度档 → 初始 Custom 尺寸（ext，Y 向下）

| 档 | 条件 | 建议 `rbX × rbY`（约，取整到 40 ext） |
| --- | --- | --- |
| S | 5–7 模块，最小系统 | 1800 × 1400 |
| M | + SWD、双 section、第二外设 | 2200 × 1600 |
| L | 多接口 / 接近满页 | A4 或 ≥ 2400 × 1800 |

**粗算（Agent 可手算并加 15–20% 余量）：**

```text
contentW = Σ(模块列宽) + (列数-1)*gap + marginLeft + marginRight + titleBlockW
contentH = Σ(模块行高) + (行数-1)*gap + marginTop + titleHeadroom + titleBlockH

ltX = 0  （或 marginLeft，通常 0–80）
ltY = 0  （或 marginTop）
rbX = contentW
rbY = contentH
```

推荐常量（与 KiCad 映射一致）：

| 常量 | ext | 用途 |
| --- | --- | --- |
| `gap` | 80–120 | 模块列/行间距 |
| `margin` | 80–120 | 页边 |
| `titleHeadroom` | 40 | 框顶中文标题 |
| `titleBlockW` | ≥ 400 | 右下标题栏宽 |
| `titleBlockH` | ≥ 120 | 右下标题栏高 |

### RPC 示例（P0）

```typescript
await client.canvasOps.setPageSize({
  context: projectCtx,
  ltX: 0,
  ltY: 0,
  rbX: 1800,
  rbY: 1400,
  showBorder: true,
  pageSizeLabel: "Custom",
} as any);

const occ = await client.patternLayout.getPageOccupancy({ context: projectCtx, includeWires: false });
// 验收：occ.pageBox.max 与 rb 接近
```

### P0 护栏

- 用户说 **不要改页尺寸** → 跳过 P0 与 P4c。  
- **已有内容的大页**、只改局部 → 跳过 P0，可选 P4c。  
- 估页过小 → P3 `AREA_OCCUPIED`；应 **加大 rb** 或 `plan_only=true` 预演 pattern。  
- P0 **之后** 才做 P1；**禁止** P0 使用「当前已摆器件的 union」代替规划表（除非用户明确要求「仅裁当前页」且走 P4c 流程）。

---

## 页面分区 → `getPageOccupancy`

KiCad 文档的「整页六区」在 HQ 中用 **外部显示坐标**（ext：`local_pos`，Y 向下增大）表达，且 **必须相对 P0 后的 `page_box`**。

| 区位（阅读习惯） | 规划用途 | HQ 操作 |
| --- | --- | --- |
| 顶部 | 电源输入、LDO、显示/外设 | P1 放置；anchor 扫描 **page_box 上半** |
| 中部 / 中下部 | **主控 MCU**（视觉锚点） | 先定 MCU bbox，其它模块相对它排布 |
| 左侧 | SWD、下载、串口 | 连接器标签朝向模块**内侧**或页内空白 |
| 右侧 | LED、按键、GPIO 排针 | 同上 |
| 底部 | 安装孔、机械 | 可选，非电气 |
| 右下 | **标题栏预留** | 模块框与器件勿侵入（建议宽 ≥ 400 ext、高 ≥ 120 ext） |

流程：

1. **P0 后** `pattern-layout-get-page-occupancy`（P1 用 `includeWires: false`；P4c 用 `true`）  
2. 合并 `items[].bbox` + 历次 `applyCircuitPattern` 的 `occupied_box` → **reserved**  
3. 为新模块选 anchor 时，在 **非 reserved** 且 **在 page_box 内** 的区域放入 `typical_size`

这与 KiCad「模块框不挡导线、导线不穿越框」的**意图**一致；HQ 暂无自动 `wire-crosses-module-frame` 检测。

---

## 模块边框与标题（P4a）

| KiCad | HQ |
| --- | --- |
| schematic 矩形 / 闭合折线 | `obj-place-place-rect`（`box` + `snapToGrid`） |
| 面积 ≥ 180 mm² 才计为模块框 | 无引擎阈值；agent 保证框 **包住本模块器件 union bbox + 清边**（建议 margin ≥ 40 ext） |
| 中文功能标题 | `obj-place-place-text`（标题放在框顶边上方 20–40 ext） |

**模块标题只用 `PlaceText`，不要用 `PlaceTextFromVirtual` / `HandleTextDrawClick` 链：**

| RPC | 用途 |
| --- | --- |
| **`PlaceText`** | 在 **ext 坐标**（Y 向下，与 `PlaceRect` / `PlaceNetAliasAt` 一致）**直接落字** |
| `PlaceTextFromVirtual` + `HandleTextDrawClick` | UI 交互链；自动化 **禁止** 依赖 |

**建议顺序**：P1 放置器件 → P3 布线 → **P4a** 用 occupancy 算 bbox → 画框和标题。**记录** `placeRect` / `placeText` 返回的 **`objectId`**（occupancy 常不含图元，P4c union 需要）。

---

## P4c：可选 —— 按实际内容微调页边

### 何时用

- P0 估页 **明显偏大**（`zoomAll` 后空白 > 30%）；  
- 用户要求导出紧凑；  
- **P4a 已删 orphan 线**，且无大量悬空 `N****` 网。

### 算法（Agent / 后续脚本）

1. `getPageOccupancy({ includeWires: true })` → union 全部 `items[].bbox`（ext）  
2. 对每个 P4a 记录的 **graphic objectId**，`getObjectJsonById` 并入 union（rect 的 x1/y1/x2/y2，text 的 loc/bbox）  
3. 扩展边距：`margin` 80–120；上方 + `titleHeadroom` 40；右下 + `titleBlockW/H`  
4. `setPageSize({ pageSizeLabel: "Custom", ltX, ltY, rbX, rbY, showBorder: true })`  
5. `zoomAll` → 读回 `page_box` 写入回复  

### P4c 护栏

- 新页宽/高 **不小于** 例如 800×600 ext（防 orphan 线主导 union）  
- 新面积 **< 旧 page_box 30%** 时打 warning，建议人工看图  
- `success === false` → 保持原页  
- **验电仍在 P4b 完成**；P4c **不替代** P4b

---

## 连接策略

| 规则 | HQ 实现 |
| --- | --- |
| 模块内短连、正交 | `apply-circuit-pattern`；短 hop → `canvas-auto-connect-objects-by-id` |
| 模块间同名标签 | 双端 `obj-place-place-pin-stub-wire-and-net-alias`（同一 `netName`）；**禁止**跨模块长飞线 |
| 网络命名统一 | P2 定名：`+5V`、`+3V3`、`GND`、`NRST`、`HSE_IN`、`SWDIO` 等 |

---

## 间距与网格（近似）

HQ pattern 常用 **40 ext** 步进。临时对应：

| KiCad 习惯 | HQ 临时建议 |
| --- | --- |
| 1 网格清距 | ≥ 40 ext 器件间距 |
| 2 网格导线/文字 | 标题距框线 ≥ 80 ext |

坐标换算见 [placement-conventions.md](../../guides/placement-conventions.md)（`PAGE_SIZE_START_Y`、ext 与 canvas Y）。

---

## 验收（临时，替代 placement audit）

| KiCad | HQ 临时 |
| --- | --- |
| `audit_schematic.py --profile placement` | **无**；用下列组合 |
| SVG/PNG 人工看图 | `canvas-zoom-all` |
| 符号策略 | [part-search](../../eda/part-search/SKILL.md) + `PlaceKicadSymbol` |

**检查清单**

1. **P0**：`page_box` 与规划档一致；非巨页默认值（除非 L 档）  
2. **P4a**：每模块有框 + 中文标题；框不压标题栏区；**objectId 已记录**  
3. MCU 位于视觉中心或中下部（**在 P0 页内**）  
4. `getPageOccupancy`：新框与器件无大面积 overlap  
5. **P4b**：跨模块 net 名一致；关键电源/复位/时钟已接  
6. `zoomAll` 目视：标签不挡引脚编号  
7. **P4c**（若执行）：裁边后内容未贴边、标题栏未裁断

---

## 参考图优先级（与 KiCad 文档一致）

1. 当前用户文字需求  
2. 用户本次上传的原理图  
3. 仓库 [modular-placement.md](../../../../modular-placement.md) 中的通用启发式  
4. **不要**从参考图复制 USB/CH340/OLED 等未要求模块  

设计前输出 **继承 / 调整 / 忽略** 表；参考图页尺寸应 **换算为 P0 Custom**，勿 1:1 复制像素坐标。

---

## 与 circuit pattern 的分工

| 子电路 | 使用 |
| --- | --- |
| HSE 无源晶振 + 负载电容 | `CIRCUIT_PATTERN_CRYSTAL` |
| NRST 上拉 + 滤波 + 按键 | `CIRCUIT_PATTERN_RESET_CIRCUIT` |
| 电源脚去耦 | `CIRCUIT_PATTERN_DECOUPLING_CAP` |
| 模块框、标题、**P0 定页** | **本 modular-placement playbook** |

Pattern 的 `occupied_box` 记入 reserved；anchor 须在 **P0 后的 page_box** 内选取。

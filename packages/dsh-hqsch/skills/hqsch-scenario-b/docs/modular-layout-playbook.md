# 模块化布局 Playbook（HQ EDA）

单页原理图上的 **功能分区**：大矩形模块框、**中文功能标题**、主控为阅读锚点、模块内预留短线走廊、模块间优先 **同名网络标签**。

- 不是 KiCad 层次化 multi sheet。  
- 不是 PCB 布局。  
- 只读审计、纯 ERC、符号库策略细节见 [eda](../../eda/SKILL.md) / [scenario-b](../scenario-b/SKILL.md)。

KiCad 完整版（含审计规则 ID）：[modular-placement.md](../../../../modular-placement.md)。

---

## 概念与适用范围

**模块化放置** = 在一张 `.HQSch` / 当前活动页上：

1. **P0** 按规划表复杂度设定 **Custom 页尺寸**，使后续 `page_box` 与电路规模匹配；  
2. 用 **矩形框** + **中文标题** 划分电源、主控、时钟、复位、调试、传感器、接口等区域；  
3. **主控** 居中或中下部，占主要视觉面积；  
4. **模块内** 标准块用 pattern + 短连；**模块间** 用标签，避免整页长飞线。

读电路、改单个阻值、ERC 专项 **不是** 本 playbook 的主任务。

---

## 推荐流程（P0 → P4）

```text
P0  规划表 + 复杂度档(S/M/L) → 估 Custom 页 → setPageSize → 读 page_box
P1  在 page_box 内：occupancy 扫描 + 放置器件（勿写死整页 magic 坐标）
P2  统一电源与功能网络名，放 GND/VCC/标签
P3  applyCircuitPattern + routing gate 补线
P4a 模块框 + 中文标题 + 清理孤儿线/悬空 stub（记录 rect/text objectId）
P4b 验电：snapshot / netlist / 连通性 + saveProject + zoomAll
P4c 【可选】fitPageToContent：union 实际 bbox 微调 Custom 页（仅估页偏差或用户要求裁边）
```

**不要在 P1 未完成时大量画线。**  
**不要在 P3 未完成时跑 P4c**（导线会改变 union bbox）。

| 阶段 | 能否改页 (`setPageSize`) |
| --- | --- |
| P0 | **必须**（新整页重做时） |
| P1–P3 | **否**（内容仍在变） |
| P4a | **否**（框/标题尚未纳入 union） |
| P4b | **否**（验电与页尺寸无关） |
| P4c | **可选**（微调边距） |

**已有大页、只改局部模块**：可跳过 P0；用户明确「不要改页尺寸」则跳过 P0 与 P4c。

---

## P0：放置前 —— 规划表与估页

### 固定四件事（与旧 P1 规划相同，但 **先于定页**）

1. 必须包含的模块与器件；  
2. 明确 **排除** 的外围（USB、OLED…除非用户要求）；  
3. 本阶段输出 **规划表 + 复杂度档 + 估页矩形**；  
4. 验收：`setPageSize` 成功 + `getPageOccupancy().pageBox` 与估页接近。

### 规划表列

| 列 | 说明 |
| --- | --- |
| 位号 | U1、J1、C1… **以工程为准** |
| 模块 | 电源、晶振、复位、SWD… |
| 本地连接 | 仅模块内（去耦、晶振负载 → pattern） |
| 跨模块网络 | 统一命名，P2/P3 用标签对接 |
| 验证节点 | MCU 脚、连接器 pin |
| pattern | 若有，注明 id 与 host 脚（供估 typical_size） |

### 复杂度档（启发式，非 ML）

| 档 | 典型场景 | Custom 页量级（ext，取整到 40 网格） | 模块数约 |
| --- | --- | --- | --- |
| **S** | 最小系统：电源、MCU、HSE、复位、BOOT、去耦、1 个外设 | 宽 **1600–2000**，高 **1200–1500** | 5–7 |
| **M** | S + SWD + 第二外设 / 双 section MCU 留足高 | 宽 **2000–2400**，高 **1500–1800** | 8–11 |
| **L** | 多接口、多排针、接近整页 A4 内容 | 用 **A4** 或 Custom **≥2400×1800** | 12+ |

STM32F103 最小系统（电源、MCU 双 section、8MHz、复位、BOOT、去耦、DS18B20）→ 默认 **S 偏 M**（建议约 **1800×1400 ext** 起，含标题栏预留）。

估页公式与 RPC 细节见 [hq-mapping.md](hq-mapping.md#p0-按复杂度设定-custom-页)。

### P0 后必须做

1. `getPageOccupancy` → 确认 **`page_box.max`** 与估页一致；  
2. 后续 **所有** P1 坐标与 anchor 扫描 **只在该 page_box 内** 进行；  
3. 禁止沿用「默认巨页（如 2755×2362）」时代的硬编码坐标。

---

## 页面分区（可裁剪）

典型 MCU 最小系统模块（**按项目增删**，勿机械复制 ESP32 参考图）：

| 模块（中文标题示例） | 典型内容 | 跨模块网络 |
| --- | --- | --- |
| 电源模块 5V→3.3V | 输入座、LDO、输入/输出电容 | +5V, +3V3, GND |
| 主控 STM32Fxxx | MCU | 各功能 net 标签 |
| 晶振模块 8MHz HSE | Y, 负载电容 | HSE_IN, HSE_OUT（或 OSC_IN/OUT，全工程统一） |
| 复位模块 | 按键、上拉、滤波电容 | NRST |
| BOOT 模块 | 跳线、下拉 | BOOT0 |
| SWD 调试接口 | 4Pin 座 | +3V3, SWDIO, SWCLK, GND |
| 温度/传感器 | DS18B20 等 | TEMP_DQ 等 |
| 去耦电容模块 | VDD 旁 100nF 等 | +3V3, GND |

区位示意（**相对 P0 后的 page_box**，坐标落地见 [hq-mapping.md](hq-mapping.md)）：

```text
+------------------------------------------------------------------+
|  [电源/输入]       [稳压/LDO]              [外设/显示]   [LED]   |
|  [串口/调试]       [======== 主控 ========]    [按键]    [排针]   |
|  [下载/辅助]                                                     |
|  [安装孔]                                 [标题栏 reserved]      |
+------------------------------------------------------------------+
```

---

## P1：在 page_box 内放置器件

- **先** `getPageOccupancy`（`includeWires: false`），合并 reserved + pattern 将产生的 `typical_size`；  
- **再** `PlaceKicadSymbol` / part-search；MCU 双 section 用 `sectionPlacements`；  
- 选 anchor 时扫描 **整页 page_box** 空位，禁止写死「某电路下方 N 格」（与 circuit-pattern-layout 一致）。

本阶段 **不画** 模块框与标题（移到 **P4a**，避免框先于器件导致 clearance 问题）。

---

## 器件摆放启发式（换芯片仍适用）

| 电路 | 习惯 |
| --- | --- |
| 信号链 | 源 → 串联件 → 负载，**同一水平中心线** |
| 去耦 | 上电源、下 GND，**靠近** MCU 电源脚 |
| 晶振 | 位于 MCU 两时钟脚之间；负载电容 **向下** GND |
| 复位 | NRST 水平母线 T 形：上拉向上，按键/电容向下 GND |
| 连接器 | 标签朝模块内或页内空白 |

紧凑区可隐藏部分 Reference 显示，**工程属性与 BOM 须正确**。

---

## P4a：模块框与标题（器件与 P3 布线稳定后）

1. `get-page-occupancy` 收集本模块所有 `Reference` 的 bbox；  
2. union 后扩展 margin（建议 **40 ext** 起）；  
3. `obj-place-place-rect`；  
4. `obj-place-place-text` 写中文标题（框顶上方 **20–40 ext**）；  
5. **记录** 每次返回的 `objectId`（occupancy 常不含 rect/text，P4c 需要）。

框应 **完整包住** 本模块器件与标题，且 **不穿过** 器件本体（人工预览）。

---

## P4b：验电与保存

- 连通性 / 引脚网名 / `getProjectNetList`（若可用）；  
- 清理孤儿线、悬空 `N****` 网（**P4c 前置**）；  
- `saveProject` + `zoomAll`。

---

## P4c：可选 —— 微调页边（非布局手段）

仅当：P0 估页余量过大、或用户要求「裁掉空白边」、且 **P4a 已清理 orphan 线**。

- union：`getPageOccupancy({ includeWires: true })` + P4a 记录的 graphic `objectId`；  
- 加 margin / 标题栏区 → `canvas-set-page-size` Custom；  
- **不移动器件**；若 union 远小于当前页，可缩小 rb；若估页过小导致内容贴边，应 **回退 P0 估大** 而非强行 P4c 裁切。

---

## P3 与 pattern 触发词

需求中出现下列特征 → **必须先 pattern**（详见 [circuit-pattern-layout.md](../../guides/circuit-pattern-layout.md)）：

| 需求 | pattern |
| --- | --- |
| 无源晶振 + 负载（2 脚） | `crystal` |
| 复位 + 上拉 + 滤波 (+ 按键) | `reset_circuit` |
| 去耦 / 旁路 | `decoupling_cap` |
| 有源 4 脚振荡器 | **不用** crystal，手布 |

每个 pattern 一次 apply；host 电源脚用 **pinName** 绑定。P3 前应用 **P0 后的 page_box** 选 anchor。

---

## 参考图：继承 / 调整 / 忽略

使用用户上传图（如 STM32F103 最小系统）前必须输出：

| 项 | 决策 |
| --- | --- |
| 继承 | 例：单页、框分区、中文标题、MCU 居中、模块间标签 |
| 调整 | 例：位号不一致；网络名 HSE_IN vs OSC_IN；**参考图页尺寸 → 换算为 P0 Custom** |
| 忽略 | 例：参考图中未要求的 USB、OLED、特定标题栏文案 |

参考图 **不能** 推断未说明的电气参数或接口定义。

---

## 常见失效模式

| 现象 | 原因 |
| --- | --- |
| 模块彼此很远、中间大片空白 | 未做 **P0**，在默认巨页上硬编码坐标 |
| 多了 USB/串口模块 | 参考图有而需求未写 |
| 框小、器件挤 | 先摆后画框或 margin 不足 |
| 长飞线穿模块 | 跨模块未用标签，P3 手画长线 |
| 主控偏一角 | 未以 MCU 为锚点、在 page_box 内 occupancy 规划 |
| 电气对但图难读 | 只跑 netlist/ERC，未做 P4a 分区与 zoomAll |
| 裁页后仍散 | 误以为 **P4c 会拉近模块**（只会裁边） |
| P4c 裁出怪页 | union 含 **orphan 导线** 或未并入 rect/text id |
| pattern AREA_OCCUPIED | **P0 估页过小**；增大 Custom 或减小 cap_gap |

---

## 试 skill 时的 Agent 输出模板

1. **继承/调整/忽略** 表  
2. **模块规划表**（位号 + 模块 + 跨模块 net + 复杂度档）  
3. **P0 估页**：档位、lt/rb（ext 或说明 Custom 尺寸）、`page_box` 读回摘要  
4. **P1–P3** 逐步说明将调用的 RPC  
5. **P4a** 框/标题及 **objectId 列表**  
6. **P4b** 验电摘要；**P4c** 仅在有需要时说明  
7. `zoomAll` 提示用户目视  

脚本目录（复用，**不必**为试 skill 改 scenario-b）：`skills/hqeda/scenario-b/template/scripts/`。

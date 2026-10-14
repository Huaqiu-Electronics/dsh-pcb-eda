---
name: pcb-initial-placement
description: "给只有网表、还没布局的 KiCad PCB 做 Phase-1 初始布局：功能分块、锚点定位、分区摆放、无重叠校验与交付报告；结果优先通过 KiCad IPC API 应用到打开的板子上，IPC 不可用时才离线生成新板文件。适用于 20–200 器件、单板、以单面为主的初始布局。"
---

# PCB 初始布局（Phase 1）

把一块"器件散落在板外、零布局"的板子，变成"定位准确、核心合理、分组集中、可以接手"的初始布局。器件不动原理图、不布线、不改网表。

产出的不是"好看的图"，而是一次**可评审、可接手、可一键撤销**的布局决策：每个器件有明确的功能归属，每个模块有明确的核心器件和落位区域，机械件保持原样，模块内器件聚在核心旁边。

## 边界：这个技能不做什么

- 不布线、不铺铜、不做等长/阻抗/试布线/拥塞预测。
- 不做 SI / PI / 热 / EMC 分析，不做 3D 机械干涉检查（只能标注风险，不能验证）。
- 不做 HPWL 或任何"目标函数最优"的承诺——这是 Phase 1，目标是**合理且可接手**，不是最优。
- 不修改原理图、不新建网络、不改封装、不替换器件。
- 不覆盖用户的原始板文件。

## 与 kicad-ipc 的关系

**读**：用 `get_pcb_board` 拿权威语义快照（器件、焊盘、网络、板框），不要靠肉眼或猜测。

**写**：**优先走 KiCad IPC API**。摆放结果通过 `scripts/apply_via_ipc.py` 一次性提交到打开的板子上，KiCad 自己维护对象、UUID、连通性和撤销栈，整个布局是**一个 undo 步骤**。`.kicad_pcb` 不是可以随手改写的中间格式。

先读 `kicad-ipc` 技能再动手。本技能不重复它的连接、版本路由和事务规则。

只有 IPC 确实不可用、且用户明确接受"给我一个新板文件"时，才退回 `scripts/write_board_file.py` 离线写盘——那条路没有撤销栈，写完还要用户手动重新打开。

## 输出目录约定（硬性）

**这次运行产生的每一个文件都放进项目下的 `placement/`**——与板文件同级，不存在就新建。技能目录里只有代码，cwd 和临时目录里不留任何产物。

```
<项目>/
  board.kicad_pcb
  placement/                              <- 本次布局唯一的落盘位置
    geometry.json                         # 步骤 1：courtyard 占用矩形 + 板框
    placement_config.json                 # 步骤 2/3：模块、锚点、定位件、禁布区
    placement_plan.json                   # 步骤 5：每个器件的位姿
    placement_pose_table.csv              # 步骤 6：交接位姿表
    placement_view.svg                    # 步骤 6：模块彩色视图 + 评估面板（必出）
    placement_view.png                    # 可选：同一张图的位图
    verify_placement.txt                  # 步骤 6：独立校验报告
    apply_via_ipc.txt                     # 步骤 6：IPC 提交与回读日志
    <board>-placed-preview.kicad_pcb      # 仅离线退回方案才产生
```

规则：

- **不要写进技能目录**（`scripts/` 是只读代码，不是工作区），也不要散落在 cwd、桌面或 `%TEMP%`。
- **中间脚本也算产物**：为这块板临时写的连通性提取、模块顺序扫描、兜底几何脚本，同样放 `placement/`，取能看懂的名字。收尾时要么留作复现证据，要么明确删掉，不要留在半路。
- **脚本默认就落在那里**：知道 `--board` 的用 `<板目录>/placement/`，其余用输入文件（geometry / plan）所在目录。想换地方用 `--outdir`；要精确指定文件名才用 `--out`。
- **报告里的路径要和磁盘一致**。写完报告回头核对一遍：`placement/` 之外不该有任何本次产物。

## 六步流程

### 步骤 1 读取与预检

1. `kicad_ipc_diagnose` 确认环境。
2. **不要为了"看一眼板子"去读整板快照。** `get_pcb_board` 会返回每个焊盘、每条走线的完整
   JSON——63 器件的板子实测 **194 KB**，其中 95% 是步骤 1 根本不需要的焊盘细节。步骤 1
   要的四个数字（器件数、板框、courtyard 来源、器件在不在板内）**全都能从板文件离线算出**，
   成本约 **0.5 KB**：

   ```
   python scripts/board_geometry.py --board <board>.kicad_pcb --brief
   ```

   一次给全：器件数、板框顶点/尺寸、**真实多边形面积**（不是包围盒）、courtyard 总面积与
   密度、`bbox_src` 逐来源计数、现存角度直方图、器件 X/Y 范围、**有多少器件原点落在板框内**，
   以及所有必须写进报告的警告。`geometry.json` 里同时存了 `preflight` 与 `board_area_mm2`
   字段供后续步骤引用。

   `get_pcb_board` 仍然是**写入时**的权威接口——只是它不是一把量尺。
3. **判断这块板值不值得自动布局**：器件数 20–200、单板、以单面为主。`--brief` 的
   `device origins inside` 一行直接给出判据：
   - `N of N` → 作者手工调过，只做局部调整，**不要整板重排**；
   - `0 of N`（全部在板框外）→ 源布局是"停机坪"导入态，没有价值，整板重排；
   - 介于两者之间 → 混合态，先问用户。
4. 确认原点/单位/层叠；确认器件都有 courtyard。非 `CrtYd` 的来源会逐件标在 `bbox_src` 里，
   `--brief` 会直接点名，**必须在报告里复述**。`bbox_src` 为 `none` 的件没有任何东西保护
   它不被压叠，只能人工处理。
5. **先核对板框与器件坐标是否自洽。** 如果 `--brief` 报"器件原点全部在板框外"，那通常不是
   布局问题，而是**板框本身错了**。这是必须停下来问用户的分叉点：把 N 个器件塞进一个小矩形，
   还是把矩形改对，后续代价差一个数量级。不要自己猜。

   需要改板框时走 `kicad-ipc` 的图形创建能力（`kipy.board_types.BoardRectangle` +
   `create_items`，一个 commit），**不要手改 `.kicad_pcb` 的 Edge.Cuts**。注意连带影响：
   板框一改，先前"在板外"的定位件（安装孔等）坐标全部失效，要一起重定位，并在报告里写明
   这是随板框变动的连带修改，不是布局算法的输出。

6. 这一步的产物：`placement/geometry.json`（每个器件的 courtyard 占用矩形 + 板框多边形 +
   preflight 摘要）。

> `board_geometry.py` 的占用框优先级是 CrtYd → Fab → 焊盘 → 丝印。丝印兜底是为只有丝印的
> 美术件（logo、基准点）准备的：这类件既没有 courtyard 也没有焊盘，早期版本会直接崩在汇总行上。
> 现在它会正常出框，并把 `bbox_src` 标成 `silk`，在 stdout 里点名。真正没有任何几何的件会拿到
> 零面积框并被单独警告——**这种件没有任何东西保护它不被压叠**，必须人工处理。
>
> Edge.Cuts 支持 `gr_line` / `gr_rect` / `gr_poly` / `gr_circle`。整块板只用一个
> **`gr_rect`** 描述是很正常的写法（KiCad 自己的板子就这么做），不要以为必须有四段
> `gr_line`；旧版解析器只认 start/end，遇到 `gr_rect` 会报 "does not form a closed
> polygon"，那是解析器缺口，不是板子的问题。

### 步骤 2 功能分块

**每个电气器件恰好属于一个模块，或者被显式标为"未分组"。**没有重复、没有遗漏，这一点要用
断言守住。

**先把草稿跑出来再改，不要从零手写。** 手写 12 个模块的成员表是本流程最贵的一步（实测
127 s 的纯推理，且极易出错——本次手写就漏了一个器件、重复了一个器件）。让脚本做机械部分：

```
python scripts/suggest_modules.py --board <board>.kicad_pcb
# -> placement/placement_config.json（可直接喂给 pack.py 的草稿）
```

它按可靠性顺序做四件事：非电源/非单脚网络做并查集聚类 → 把只挂在电源上的器件（去耦、
滤波）按电源域归给对应模块 → 把孤立单件并回邻居最多的模块 → 锚点按模块面积比例排成横向带。
它**只做机械部分**：`fixed` 与 `keepouts` 一律留空，因为那是只有用户知道的物理事实。
最后它会**断言分块是一个真划分**（无重复、无遗漏），这正是本步骤要求"用断言守住"的那件事。

拿到草稿后人工做四件事，这才是真正需要判断力的部分：

1. **改名字**：`dip_8_c4` 这类机器名要改成"VPP 升压"这类能评审的名字。
2. **拆过大的簇**：脚本在超过 `器件数/4` 的簇后面标 `<- too big`。那说明有一条跨模块总线把
   两个功能块粘住了，机器分不开，只能人拆。
3. **补 `fixed`**：所有有机械约束的器件。
4. **补 `keepouts`**：插座倾斜体积、天线净空等。

分块依据，按可靠性从高到低：

1. **网表连通性**：谁和谁连得最多，谁就是一组。这是最硬的证据。
2. **网名的原理图 sheet 前缀**（如 `/buspci.sch/`、`/graphic/`）：同一张子图的网络聚在一起，
   是作者本人的功能划分意图。
3. **功能常识**：视频输入/输出、总线接口、帧缓存、图形逻辑、板边连接器。

**电源网络必须降权**：GND 上挂着 115 个器件、+5V 上 70 个，如果按连通性聚类，整板会被并成
一个巨大的"电源模块"。脚本已按三个条件降权（网名命中电源黑名单 / 扇出超过 `--fanout`
默认 8 / 器件只连电源）。聚类完成后再把**只通过电源/地连接的器件**按电源域分配给对应模块。

**总线网络也要降权，但门槛要稳。** `/DATA-RB7` 这类总线从连接器穿过缓冲器一直拉到 ZIF 座，
把它当分组证据会把半个板子并成一块。脚本的判据是"**抽掉这条网，它的脚还能不能连在一起**"：
能，说明这条网没提供新的分组信息，是总线；不能，说明它是真正的局部连线。两个门槛缺一不可：

- `min_pins>=4`：3 脚网络"缓冲器输出→串联电阻→指示灯"是真实子电路，不是总线；
- `max_frac<=0.5`：抽掉后还有一半脚连着的网，硬拆只会把一个完整模块剁成碎件。

**只放宽 `--fanout` 不解决问题**——总线的问题从来不是扇出大，而是它跨越功能块。

每个模块要指定**核心器件**（1–3 个），它是这个模块的摆放锚点，也是评审时的抓手。
找不到核心的模块，说明分块本身有问题。

产出：`placement/placement_config.json` 里的 `modules`。

### 步骤 3 锚点与定位件

先钉死不动的，再谈摆放。

| 类别 | 处理 |
| --- | --- |
| 已存在的安装孔 / 定位孔 | **保持原坐标**，只登记为障碍物 |
| 位置已定、有结构约束的连接器 | **保持位置、角度、朝向** |
| 只要求"靠板边"的连接器 | 在指定板边上给一个合法位置即可 |
| 用户锁定的核心器件 | 保持不动 |
| PCI 金手指、板边支架连接器 | 从板框几何**反推**原点（见下） |

两个必须掌握的推导：

- **金手指**：找一个已知该落在板边的焊盘（如 PCI 的 A1），用它的局部坐标反推封装原点，`origin = 板边目标点 − 焊盘局部坐标`。这样金手指一定贴合板边斜边。
- **支架连接器**：封装名常带结构偏移（如 `EdgePinOffset14.56mm`），原点 = 板边坐标 + 偏移量。

产出：`placement/placement_config.json` 里的 `fixed`。

### 步骤 4 分区（floorplan）

1. 先把**固定件**、**禁布区**（keep-out）在占用栅格上盖章。顺序不能反，否则自由器件会先占掉禁布区。
2. 按"贴边模块优先、面积大的模块优先"分配粗区域：大模块（FPGA、RAMDAC、SIMM 阵列）先落地，小模块（去耦、端接电阻）后填缝。
3. 分区是**粗网格**级别，不是把每个模块锁进一个死框——模块边界处的自由空间应该被相邻模块共享，否则会出现大块空洞和远处的"飞地"。
4. 机械禁布区要显式登记：SIMM/DIMM 模块插上后会倾斜，倾斜体积要预留。**这块区域必须在步骤 1 就识别出来**，否则后期无法收拾。

### 步骤 5 模块内摆放

对每个模块的每个器件：

1. **核心器件和"二级核心"（晶振、时钟、配置 EEPROM、电位器）先摆**——它们比去耦电容更需要贴着自己的芯片。
2. 大器件（courtyard 面积 ≥ 阈值）先于小器件，否则大器件会找不到整块空地。
3. 从模块的锚点向外做**环形搜索**：以锚点为中心，半径按步进增长，每圈按角度采样，找到第一个合法位置。多个锚点时，取"离任一锚点最近"的那个解。
4. 一个器件这一轮找不到位置时，**不要把它甩到板子另一头**，而是下一轮给它更大的搜索半径。突然跳到远处会把功能分组彻底打散。
5. 模块之间**轮流占位**（round-robin），让共享区域的分配对各个模块公平。模块的处理顺序会影响结果：先处理的模块拿到sought-after的近处空间。**顺序要试，不要拍脑袋**——用"每个器件到本模块核心的距离中位数/总和"作为评分比较几种顺序。
6. 收尾：**疏散修复 + 向核心压实**
   - 还有器件放不下时，找一个"驱逐代价最小"的合法位置（被挤走的器件 courtyard 总面积最小），把它换进去，被挤走的重新排队。
   - 全部落地后，反复把每个器件拉向"离自己核心更近的合法位置"。这一步只会让分组更紧，不会破坏可行性。

产出：`placement/placement_plan.json`（由 `scripts/pack.py` 生成，含 `positions` / `unplaced` / `modules` / `anchors` / `fixed` / `keepouts`）。

### 步骤 6 校验、出图与交付

**校验**：跑 `scripts/verify_placement.py`——**独立校验，不共用 packer 的代码**，否则只是把同样的算术再算一遍。它顺手把整份报告写进 `placement/verify_placement.txt`：这份文件是交接证据，不要只留在终端里。

**出图**：跑 `scripts/placement_view.py`，产出 `placement/placement_view.svg`。**每次布局都要出这张图**——评审时它是唯一能一眼看全局的东西，也是"板子到底摆成什么样"最省事的答复：

```powershell
python <skill>/scripts/placement_view.py --geometry placement/geometry.json `
       --plan placement/placement_plan.json --config placement/placement_config.json
# -> placement/placement_view.svg
```

图上有什么：真实板框（含缺口、圆角、异形边）、禁布区（斜线填充，面板里写清为什么禁）、按模块着色的 courtyard（**固定件实心、算法摆放的半透明**，一眼分得清"决定的"和"推出来的"）、模块锚点、比例尺；下方是评估面板——板面积、courtyard 占比、重叠对数、出板数、未摆放数、stand-in 警告。它只用标准库，不依赖 KiCad、浏览器或光栅化库，任何跑得动 packer 的机器都出得来。

面板里的门槛数字只用于**显示**；真正的判据是 `verify_placement.py`。两者不一致时以校验脚本为准。

需要位图或真实铜箔视图时再补（可选）：

```powershell
# 位图（有 ImageMagick / Inkscape 时）
magick -density 96 placement/placement_view.svg placement/placement_view.png
# 3D 渲染（kicad-cli；用离线副本或已保存的板子）
kicad-cli pcb render --output placement/board-3d.png --side top --quality high <board>.kicad_pcb
# 真实铜箔/丝印分层 SVG —— 注意 --output 是目录，不是文件名
kicad-cli pcb export svg --output placement/board-svg/ --layers F.Cu,F.Silkscreen,Edge.Cuts <board>.kicad_pcb
```

交付物（全部在 `placement/` 下）：

| 文件 | 说明 |
| --- | --- |
| `placement_config.json` | 布局决策本身：模块划分、锚点、定位件、禁布区、模块顺序 |
| `placement_plan.json` | 每个器件的位姿（x, y, rot） |
| `placement_pose_table.csv` | 交接位姿表（模块、位号、值、封装、原点、角度、courtyard 尺寸、fixed/placed） |
| `placement_view.svg` | **模块彩色视图 + 评估面板**（必出） |
| `verify_placement.txt` | 独立校验报告（重叠/间距/出板/分组/密度） |
| `apply_via_ipc.txt` | IPC 提交与回读日志 |
| 板文件 | IPC 提交后的板子；离线方案才多一个 `<board>-placed-preview.kicad_pcb` |
| `REPORT.md` | 分组清单（模块→器件→核心）、待确认清单、运行统计、复现命令 |

## 把结果放进 KiCad：优先 IPC

```
python scripts/apply_via_ipc.py --plan placement/placement_plan.json --dry-run   # 先看要动哪些
python scripts/apply_via_ipc.py --plan placement/placement_plan.json             # 提交为一个 undo 步骤
python scripts/apply_via_ipc.py --plan placement/placement_plan.json --save      # 用户满意后落盘
```

每次运行都会留下 `placement/apply_via_ipc.txt`（提交了多少个、回读有没有不一致），这份日志是"确实提交过、且和计划一致"的唯一凭证。

**`--include-fixed` 是这一节最常见的坑。** 脚本默认**不动** `fixed` 里的器件，因为它假设这些定位件本来就在正确位置（真实的机械约束场景）。但板子如果是"全部散落在板外"的导入态，定位件也在停机坪上，默认行为会**静默漏掉**它们——计划里 28 个定位件，板子上一个都没动。判断方法只有一个：提交后从编辑器**实时读回**，比对计划里的全部位号，而不是只看 `parts to move` 的数字。凡是从零布局的板子，都要带 `--include-fixed`。

脚本遵守 kicad-ipc 的规则：

- 先 `kicad_ipc_diagnose`，环境不通就不要往下走。
- 连接后**先定位再改**：按 reference 重新取封装对象，保留 KiCad 的 UUID；引用缺失、重复或**被锁定**的封装直接报错退出，不做部分应用。
- **整批一个 commit**：`begin_commit()` → 设 position/orientation → `update_items([...])` → `push_commit()`；任何异常 `drop_commit()`。用户在 KiCad 里只看到一步撤销。
- **提交后重新读回**，逐个比对坐标和角度。`update_items()` 没抛异常不等于板子已经变成计划的样子。
- `board.save()` 只在用户要求落盘时调用。
- 失败时给出可执行的诊断（编辑器没开 / API 服务没启用 / 沙盒不是 Full Access / 项目管理器占了 socket），而不是丢一个 traceback，更不是转去手改文件。

注意 `orientation` 的 setter 会 `normalize180()`，270° 会存成 −90°：**几何等价，比较时要按最短路角度差**，不要按字符串比。

## 质量门槛（硬性）

| 检查 | 门槛 |
| --- | --- |
| 完整性 | 板上每个器件都有位姿；计划里没有板上不存在的位号 |
| courtyard 重叠 | **0 对**（这是硬门槛，不是"尽量少"） |
| courtyard 来源 | 非 `CrtYd` 的器件必须在报告里点名；`bbox_src` 为 `none` 的件**没有任何保护**，必须人工处理 |
| 最小间距 | 用户给的设计规则，或 ≥ 0.2 mm 兜底 |
| 出板 | 只有"本体本来就要伸出板外"的连接器允许；其它出板都是 bug |
| 分组 | 每个器件到本模块核心的距离中位数、最大值；报告有多少器件离别的模块核心更近 |
| 密度 | courtyard 总面积 / 真实板面积。> 75% 就属于密板，预期会出现溢出和挤占 |
| 出图 | `placement_view.svg` 已生成，且面板数字与 `verify_placement.txt` 一致 |
| 可读性 | 板文件能被 kicad-cli 正常解析（`pcb export svg` / `pcb render`） |
| 产物位置 | 本次所有产物都在 `placement/` 下；技能目录与 cwd **零新增文件** |

密度这一条要**主动算给用户看**：板子放不下时，不要偷偷降低间距或把器件塞进不该塞的地方，而要说清楚"这是板面密度的硬约束"，并给出选项。

## 最要命的几个坑

- **不要整板重排已经手工调过的板子。** 先判断源布局有没有价值。
- **不要用 int() 截断网格索引。** `int(-0.3)` 是 0 不是 −1，会把板外一格当成板内，器件就会挂在板边外面。用 `math.floor()`。
- **板框要做半格腐蚀。** 单元格的**中心和四个角**都在板内才算可用，否则 courtyard 会压到板边外。
- **盖章和判空必须用同一套取整。** 一方用 `round` 一方用 `+0.5` 取整，膨胀后的矩形会溢进邻居的格子，把邻居的所有权改掉，随后在疏散修复里报 `KeyError`。
- **所有权 id 要回收。** 每 commit 一次就新分配一个 id，bytearray 存 255 个就溢出（`byte must be in range(0,256)`）。
- **模块顺序决定成败，要实测**。同一个算法换一下模块顺序，某个模块的位置中位数能从 43 mm 变成 156 mm。
- **courtyard 是唯一的重叠判据。** 没有 courtyard 的封装要用 Fab 层、焊盘或丝印推出来，并且**在报告里点名**——一个错误的 courtyard 会安静地毁掉整个布局。
- **2D 通过不等于机械通过。** 插座类器件（SIMM/DIMM）的倾斜体积必须显式登记为禁布区，并把"有没有器件落在里面"写进待确认清单。
- **别把"全固定"的模块当成空模块。** 安装孔、板边端子这类模块成员可以全是定位件，于是它的 `anchors` 是空表。按锚点算距离/离群时如果直接取 `anchors[k][0][0]`，会在这块板的第一个全固定模块上 `IndexError`。做距离统计前先筛掉没有锚点的模块。
- **产物别乱放。** 技能目录是只读代码区，cwd 是用户的。中途替换用的兜底脚本（几何、校验、出图）也该进 `placement/`，否则下一个人既找不到它们，也不敢删。
- **别用 `get_pcb_board` 做步骤 1 的"看一眼"。** 实测 63 器件的板子返回 **194 KB**，占整轮
  输入 token 的 ~89%，而那些焊盘细节步骤 1 一个都不用。用 `board_geometry.py --brief`（0.5 KB）。
  整板快照是**写入**路径的权威，不是量尺。
- **别假设板的网表是 `(net 12 "GND")` 格式。** 经导入器产生的板子写的是 `(net "GND")`，
  没有数字码。按下标 2 取网名会拿到空串，于是 111 条网络变成 0 条，**下游所有按连通性做的
  分组全部静默失效**——不报错，只是结论全错。统一走 `sexpr.net_name(pad)`。
- **别假设板框是四段 `gr_line`。** 整块板用一个 `gr_rect` 是合法且常见的写法。解析器只认
  start/end 时会报"不闭合"，那是在冤枉板子。`gr_poly` / `gr_circle` 同理。
- **器件值里的非 ASCII 字符能杀掉一整轮运行。** `100µF` 在 GBK/cp1252 控制台上让 `print()`
  抛 `UnicodeEncodeError`——脚本干完了活，却死在最后一行汇总上。`projpaths.make_console_safe()`
  会把 stdout/stderr 重配成 `utf-8/errors=replace`，报告文件仍是 UTF-8。
- **板框和器件坐标不自洽时，先怀疑板框。** "全部器件原点在板框外"通常不是布局问题，是板框
  被改小了而器件没跟着走。这是要停下来问用户的分叉点，不要自己猜着往小矩形里塞。
  改板框后，安装孔一类"在板外"的定位件坐标会一起失效，**必须连带重定位并写进报告**。
- **改板框走 IPC，不要手改 Edge.Cuts。** `BoardRectangle` + `create_items` 一个 commit 就能
  换掉整条板框，用户在 KiCad 里一次 Ctrl+Z 撤销。
- **位姿变换要用真实数据验，不要"看起来对"。** courtyard 局部框 + 原点 + 旋转能否复现 KiCad
  的世界坐标，是整个布局的地基：转错一个方向，所有间距数字全错却依然自洽。用一次
  `get_pcb_board` 的焊盘坐标做交叉验证（247 个焊盘，误差应为 0.000000 mm），验一次，
  省掉后面所有返工。

## scripts/ 索引

| 脚本 | 作用 |
| --- | --- |
| `board_geometry.py` | 只读提取 courtyard 占用矩形 + 板框多边形 → `geometry.json`；`--brief` 额外打印步骤 1 的完整判据（面积/密度/角度/在板内计数/警告） |
| `suggest_modules.py` | **步骤 2/4 的草稿器**：按网表连通性自动分块（电源与总线降权、电源专挂件归域、孤立件并回），给核心与按面积铺开的锚点，并断言真划分 → `placement_config.json` |
| `pack.py` | 核心摆放算法，读 config，输出 `placement_plan.json` |
| `verify_placement.py` | 独立校验（重叠/间距/出板/分组/面积），硬门槛不过就非零退出，报告落 `verify_placement.txt` |
| `placement_view.py` | **出图**：模块彩色视图 + 评估面板 → `placement_view.svg`（纯标准库） |
| `apply_via_ipc.py` | **首选**：整批一个 undo 步骤提交到打开的板子，日志落 `apply_via_ipc.txt` |
| `write_board_file.py` | 退回方案：离线写一个新板文件，源文件不动 |
| `pose_table.py` | 生成交接用位姿表 CSV |
| `projpaths.py` | `placement/` 输出目录解析 + 报告 Tee（报告一律 UTF-8）+ `make_console_safe()` 防终端编码炸掉整轮运行——所有脚本共用 |
| `sexpr.py` / `kipy_common.py` | s-expression 只读解析器（含 `net_name()` 双方言取网名）/ KiCad IPC 连接与事务助手 |
| `placement_config.example.json` | 完整可跑示例（KiCad video 示范板，189 器件） |

所有脚本都接受 `--outdir`（换输出目录）与 `--out`（精确指定文件名）；不给就落在 `<板目录>/placement/`。

跑通示例：先生成草稿配置，再人工改写模块与定位件（技能目录只读，不要就地改
`placement_config.example.json`）。以下假定板子是 `C:\proj\video\video.kicad_pcb`，
命令在任何 cwd 下都能跑；除 `--board` 外一次 `--out` 都不给，产物自动落进 `placement/`：

```
python board_geometry.py  --board C:\proj\video\video.kicad_pcb --brief
python suggest_modules.py --board C:\proj\video\video.kicad_pcb    # 然后人工复核/改名/补 fixed
python pack.py            --geometry C:\proj\video\placement\geometry.json --config C:\proj\video\placement\placement_config.json --board C:\proj\video\video.kicad_pcb
python verify_placement.py --geometry C:\proj\video\placement\geometry.json --plan C:\proj\video\placement\placement_plan.json
python placement_view.py   --geometry C:\proj\video\placement\geometry.json --plan C:\proj\video\placement\placement_plan.json
python pose_table.py       --geometry C:\proj\video\placement\geometry.json --plan C:\proj\video\placement\placement_plan.json
python apply_via_ipc.py    --plan C:\proj\video\placement\placement_plan.json --dry-run
```

算法细节、坐标变换的推导和每个坑的复现过程见 [references/algorithm.md](references/algorithm.md)。

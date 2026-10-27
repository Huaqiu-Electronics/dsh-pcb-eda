---
name: kicad-schematic-design
description: Create or adapt editable KiCad schematics using inspected circuit modules and real component models. New projects require confirmed requirements and a saved hardware design brief before scripted generation. Supports flat and hierarchical projects; not for PCB layout.
---

# KiCad 原理图设计

在当前工作区交付可编辑工程。启用 `@huaqiu/dsh-tool-part-search` 与 `@huaqiu/dsh-tool-kicad-schematic-gen`；工具关闭时不绕过开关。先确认目标项目与会话目录一致，处理相关文件的未保存改动。

主线：**确认需求 → 保存并读回方案 → 检查模块与准备器件库 → 脚本生成候选 → 预览并集中修复 → 发布与正式概览**。

## 1. 需求与方案前置

- 新项目按 `hardware-design-brief` 展示已知目标、交付范围、关键缺口和推荐选项，用 `ask_user_question` 提问并等待真实回复。工具不可用时在对话中提问，结束本轮等待。默认选择、超时、取消和沉默不算确认；等待期间只做只读资料核实。已有同项目确认结果直接沿用，记录需求来源，不增加逐阶段审批。
- 确认后按该技能原有深度完成并保存方案，保留选型、电源、外围、接口、预算依据及未决条件。已有合格方案直接读取；局部修改更新相关部分，纯讨论或诊断不重做全套方案。技能不可用时如实说明，使用现有方案；确需新方案时在授权范围按同等深度编写。
- **编写生成脚本前**用下方 `--read-plan` 读回保存的方案，确认相关内容足以指导实现。目录、todo、口头结论或后台任务不等于方案完成。模块适配和新发现的脚号、网络、器件、DNP 修改与修图同轮写回同一方案，再读回新版本，不依赖过期结论。

```text
node <runnerPath> --read-plan <方案绝对路径>
node <runnerPath> <design.mjs绝对路径> <唯一候选目录> <报告.json> --plan <方案绝对路径> --plan-sha256 <读回的sha256>
```

启动器绑定方案版本并保存 UTF-8 报告。平铺 create 和 create_kicad_hierarchy 同样传 `designPlan:{path,sha256}`。方案变化须重新读回并同步脚本；不得绕过检查、手写工程或先生成后补文档。哈希检查不证明电气完整或文图一致。

## 2. 检查可复用模块

各实际功能分别搜索：型号用 `eda_module_precise_search`，功能用 `eda_module_rag_search`，分类用 `eda_module_category_search`。无合适结果时换别名、功能或分类，不重复原查询。有合适候选即停止扩大搜索，分别决定直接复用、修改复用或从零设计，不重画适用电路。

下载到已创建的 sources/，保持原图及源工程不变。先用下载返回的 analysis，按缺口查询 `analyze_kicad_module` 的 components/nets/bom，不重复 summary。仅缺少必要图纸备注等信息时定向 flat list；坐标、UUID 和 create 留到适配阶段。端口工具只列层次标签，空列表不代表无外部接口，同名网络不代表兼容。

首次判断模块读 [模块选择](references/module-selection.md)，需要明细再读 [模块分析](references/module-analysis.md)。将来源、真实接点、装配状态、已有外围、适配及限制写回方案，更新电源树、连接计划和预算。自研 PCB 统计内部器件，外购成品板不重复计价；未核实条件保持未决，不降低用户硬约束来适配模块。

## 3. 首版前准备实际器件库

新增器件：`search_hqsch_parts` → `get_kicad_component_models` → `import_kicad_component`。将搜索结果的 `manufacturer.id` 映射为 `manufacturer_id`，保留精确 mpn；按需查手册。搜索标记不代表实际模型可用。无结果至少换一次实质不同的查询再考虑本地符号；服务故障或插件关闭不能称为库中无结果。

全部物理器件（含阻容、连接器）首版前完成符号、封装与库表。成套导入须返回双模型可用及 `validation.pinPadMatch: number_sets_match`；放置显式传 `footprint: imported.footprintId`。电源绘图符号不需实体封装。仅用户明确只做原理图或已有核实的本地封装时单独导入符号；编号匹配不代替功能、尺寸及手册核对。

- 新器件首次读 [器件与封装](references/component-pcb.md)，实际器件线上优先，不用参考符号替代采购器件。
- 复用模块首次读 [封装本地化](references/module-footprints.md)，优先随包封装，保留已有符号和接线，用 `footprintMappingPath` 持久应用映射。prepared/check_mapping 表示准备状态，check 检查实际图纸。
- 库保存于 `project/libraries/symbols/`、`project/libraries/footprints/`，库表位于 project 根目录，以 `${KIPRJMOD}` 注册。复用返回路径，不自动回退旧库；映射与来源哈希绑定。

## 4. 选择路线并生成

遵从用户指定形式；否则默认平铺，复杂度及维护需要时才用层次。可混合复用、修改和新增电路。

| 当前操作 | 首次读取 |
| --- | --- |
| 单模块工程副本或多模块平铺整合 | [平铺复用](references/flat-reuse.md) |
| 定向修改已有对象 | [编辑参考](references/editing.md)；工具不新增或移动符号 |
| 编写电路脚本 | [编程接口](references/programming.md)；多功能框再读 [脚本组织](references/modular-scripts.md) |
| 复用模块并增加器件 | [混合整合](references/mixed-design.md) |
| 新增局部电路或排列标签 | [画法索引](references/drawing-patterns.md)：先读所选完整代码/依赖和对应参考图，再编写局部脚本 |
| 转换共享电源符号 | [电源符号](references/power-symbols.md) |
| 层次工程 | [层次组织](references/hierarchy.md)；格式诊断才读 [KiCad 10 参考](references/kicad10-hierarchy.md) |

构建要求：

- 首次新绘局部电路，先选匹配画法，用 `node <patternReaderPath> <画法ID...>` 批量读取说明、完整 .mjs 和依赖，再用 read_image 实际读取返回的 readImagesNext。目录扫描、关键词片段、Markdown图片链接及自己生成的预览不算读过参考。相同项目已读同版本资源直接沿用；已有清楚布局的复用模块无需重读或重画。匹配的电路单元调用 place/connect，标签使用 attachPinLabels；不匹配则在现有方案或脚本注明适配/自定义原因，不强套芯片型号，也不增加审批或独立审计文档。
- 首次候选前读 [布局与停止条件](references/layout-delivery.md)，规划模块、主通道、外围和文字空间。各功能区保留无填充框、短标题及必要说明；保留来源的接法、限制和警告。
- 一个主入口共享 parts 与编号，先放置全部器件，再布线、保存。先导入模块并登记返回位号，再分配新增位号；显式映射共享网络，隔离内部网络。外围靠近所属引脚直接连接，不为每条支路建框。
- 电气栅格 **50 mil = 1.27 mm**，坐标单位毫米。用 gridPoint/snapGrid 规划，用 sch.pin/region.pin 实际坐标连线。模块只对齐平移量，不分别舍入原引脚与导线，不关闭格点检查。
- 共享地与电源声明 `requiredPowerSymbols`，按电源参考执行 planPowerPlacements → replacePowerLabels → 检查。使用本轮 catalog，不沿用旧 UUID；不为遮挡撤掉符号要求，不自动合并隔离地、电源或添加 PWR_FLAG。
- 层次标签实际接入电路，全部端口连接或声明未连接；方向统一 passive，来源方向冲突仅提示。
- 使用公开接口及实际引脚信息。正常设计不读库实现猜接口、不写临时解析器、不做 smoke 工程或全图端点/几何审计；明确内部错误才做最小复现。

## 5. 检查与交付

1. 建立唯一 ASCII 名称的 `designs/<name>/`，按需使用 sources/、work/、scripts/、固定 project/、previews/ 与 `.candidate/<run-id>/`。每轮新候选，不建 revN 交付工程或改变工作区。
2. 普通候选预览传 `projectDir` 指向已备库表的正式目录，检查 footprintCheck。首版看整图确认页面与分区，细节不清再读对应 regionImages；修复版看受影响区域、连接及整页范围。使用返回图片路径，同版本不重复渲染、读图或另写裁图脚本。
3. 按方案核对供电、共地、电压域、极性、使能、复位、必要上拉、负载及跨模块连接，结合图片检查可读性。集中修复；简单项目首版达标即交付，否则默认一次集中修复。额外迭代须有明确阻塞缺陷，真实错误不受轮数限制；不为装饰或清零保守警告重建。
4. 候选通过后发布到固定 project，只替换本设计生成文件及列明子页，保留库及其他文件，子页使用相对路径。回填最终位号、器件、封装、DNP 和限制，完成已用任务清单更新及本轮清理。仅封装/库表变化时重查原候选，不重画电路。
5. 最后调用 `render_kicad_module_preview({schematicPath:正式图路径,projectDir:正式工程目录,delivery:true})`。须 `deliveryStatus:ready` 且 overview 有效；renderStatus:ok 不足。失败按 footprintCheck/overviewError 修正，保留已有工程和图片。

**正式概览是本轮最后一个工具操作**，随后直接输出交付说明；之后若调用任何工具，需重新正式交付。卡片于本轮正常结束后显示页面切换、缩放和 ZIP 下载，不为显示卡片再读图。ZIP 只收集 project 内设计及本地库；脚本、来源和预览另存工作区并在交付说明中链接。

默认不运行 ERC、额外网表比对或生成 PCB，用户明确要求时再执行。预览、连接计划及概览不代表电气验证通过。

## 环境与恢复

使用末尾的 skillDir/runtimePath/runnerPath/geometryPath；相对资源以 skillDir 为根，不从 pluginDir 猜路径。脚本经 assets/runtime.mjs 加载库和模板，保留示例相对结构。安装资源只读，输出存当前工作区。

已有 `get_eda_host_info` 返回值时复用。正常生成、读取和渲染原理图不依赖 PCB IPC，也不查 Python。CLI 默认自动发现；缺路径、启动失败或环境变化时才查宿主，已知绝对路径可传 `kicadCliPath`。失败读 [恢复参考](references/troubleshooting.md)，按 code/stage/nextAction 处理，不原样重试确定性错误或重下载成功资源。

沿用同项目已读接口、模型、映射及未变区域结论；独立只读查询可批量执行，库表写入遵守工具并发约定。只读当前步骤需要的参考，不遍历技能目录。

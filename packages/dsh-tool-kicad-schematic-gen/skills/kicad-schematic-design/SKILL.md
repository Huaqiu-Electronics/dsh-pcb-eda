---
name: kicad-schematic-design
description: Create or adapt editable KiCad schematics using inspected circuit modules and real component models. New projects require confirmed requirements and a saved hardware design brief before scripted generation. Supports flat and hierarchical projects; not for PCB layout.
---

# KiCad 原理图设计

在当前工作区交付可编辑工程；使用已启用的 `@huaqiu/dsh-tool-part-search` 与 `@huaqiu/dsh-tool-kicad-schematic-gen`，不绕过工具开关。方案、真实器件和实际引脚决定电路，预览不代替电气核对。

## 先判断当前角色

- **收到模块 task.md 的子 agent**：完整读取任务，写首版前读所附本模块参考说明，并用 read_image 读指定参考图，再补全 entry；尺寸/方向按需读几何 JSON。借鉴排列，不照搬示例器件或脚号；不加载整套参考、总清单或其他模块，不扫描源码或写探测工程。提交一次候选、报告、已读参考图/候选图及未决项后结束，不重问需求、不再派发、不发布。
- **主 agent**：确认方案与器件后，写电路前按 [并行生成](references/parallel-generation.md) 准备清单、派发并统一验收。按独立功能划分，不按页数/外框数量判断；复位/BOOT/去耦可与MCU同任务。真实单功能电路不强拆。
- **单框生成或已有工程定向修改**：读 [编程接口](references/programming.md)；修改流程见 [脚本修改](references/editing.md)。多框顺序处理仅用于工具不可用、旧图定向修复或不可独立拆分，传 --sequential-reason 说明实际原因。

同会话同版本已经读过的参考沿用；独立子 agent 以自己的任务为准，不能假定继承主 agent 上下文。

出现MODULE_DELEGATION_REQUIRED立即转入派发，不继续补整图脚本；同一方案的派发要求会留存，合框、改脚本名或更新方案文本不能清除。真实工具限制/旧图定向修改才用--sequential-reason并说明依据。

## 主 agent 主线

1. 新项目先用 hardware-design-brief 展示目标、范围、缺口和推荐选择，通过 ask_user_question 等待真实回复；工具不可用时在对话中提问并结束本轮等待。沉默、超时和预选项不算确认。同项目已有确认直接沿用；局部修改或诊断不重做全套方案。
2. 保存有选型、电源树、外围、接口、预算依据和未决条件的方案，编写脚本前用 `node <runnerPath> --read-plan <方案绝对路径>` 读回；生成传 --plan 和 --plan-sha256。器件、脚号或网络变化同步方案并重读，不先画后补。
3. 按实际功能判断复用：型号/功能/分类分别用 eda_module_precise_search / eda_module_rag_search / eda_module_category_search，有合适候选即停止扩大搜索。每个功能在 module-plan.json 的 reuse 中保存选择及实际搜索结果（字段见 references/module-selection.md）；搜索异常记 unavailable，不能当作没有候选。派发前检查记录，已有合格记录直接沿用。来源存 sources/ 且不修改；按需用 analyze_kicad_module 查询 components/nets/bom，端口为空不等于没有接口。
4. 备齐实际符号、封装、共享 parts 和库表，再派发。新增器件用 search_hqsch_parts → get_kicad_component_models → import_kicad_component，沿用精确 manufacturer_id/mpn 和返回的 libraryPath/libId/footprintId，不手工下载模型替代导入。成套导入核对 validation.pinPadMatch；搜索标记和编号匹配均不证明电气适用。物理器件实例保留型号、厂家、参数及封装，阻容填写实际 value，不使用 R_US/C 默认名。库在 project/libraries/ 下，以 ${KIPRJMOD} 注册；电源绘图符号不需实体封装。默认成套导入，仅用户明确只做原理图或已有核实本地封装时才可 scope="symbol"。
5. 默认平铺，多框依并行流程；沿用用户指定形式。候选检查通过后按 [布局与交付](references/layout-delivery.md) 验收、修复、发布到固定 project/。

搜索结果的 manufacturer.id 映射为 manufacturer_id；放置显式传 `footprint: imported.footprintId`，不猜字段或丢失封装。

## 按需参考

不按表逐篇阅读；只选当前操作需要的条目。

| 当前需要 | 参考 |
| --- | --- |
| 主 agent 填清单、派发、装配 | [并行生成](references/parallel-generation.md) |
| 单框 API、扩展接口、编码问题 | [编程接口](references/programming.md) |
| 实际器件属性、封装或旧库补齐 | [器件与封装](references/component-pcb.md) |
| 搜索判断／深入分析复用电路 | [模块选择](references/module-selection.md)／[模块分析](references/module-analysis.md) |
| 平铺复用与新增／来源封装 | [平铺整合](references/flat-reuse.md)／[封装本地化](references/module-footprints.md) |
| 需要某种现成局部画法 | [画法索引](references/drawing-patterns.md)，只读选定项 |
| 明确采用参数模板 | [可选模板](references/module-templates.md) |
| 主 agent 调整电源转换 | [电源符号](references/power-symbols.md)；模块运行时已代管转换，不让子 agent 重做 |
| 主 agent 验收、发布 | [布局与交付](references/layout-delivery.md) |
| 层次工程 | [层次组织](references/hierarchy.md)；格式故障才读 [格式参考](references/kicad10-hierarchy.md) |
| 顺序脚本的旧组织形式 | [顺序示例](references/modular-scripts.md)，并行路线不读 |
| 具体 code/stage 故障 | [恢复参考](references/troubleshooting.md)，只定位对应段落 |

## 共用约束

- 用公开生成 API，不手写 KiCad 工程；修改生成脚本再构建。安装资源只读，产物留工作区；保留用户文件和未保存改动。
- 单位毫米，电气栅格50mil（1.27mm）。端点用实际 pin；正交连线显式规划且不自动避障。全局与框内局部坐标不混用，不分别舍入导线和原引脚。
- 主 agent 独占共享清单、库和跨区连接；子 agent 只写任务范围。用 expectedConnections 覆盖重复电源、地和外壳脚；声明检查通过不等于完整电气验证。
- 关键数值、位号、引脚和标签须可辨认；功能支路紧凑、邻近器件短线直连，不能散成标签孤岛。主 agent 收尾真实文字/布局缺陷；不以零警告或结构通过代替读图，不为纯装饰反复构建。
- 派发前处理空间预检；tight 是估计风险，建议尺寸须结合页面和相邻模块确认。首次空间失败先集中上报主 agent 决定扩框/重排。检查反馈按 repairPlan 阶段批量修复；omittedIssues>0 定向读完整 reportPath，不逐项触发模型/重建。详细诊断留文件，主上下文保留计数、当前路径和未决问题；最终仍读完整当前图。
- 使用资源清单解析后的 runtimePath/runnerPath 等绝对路径，不搜索安装目录猜位置。已有 `get_eda_host_info` 返回值时复用。正常生成、读取和渲染原理图不依赖 PCB IPC，也不查 Python；CLI自动发现，明确路径/环境错误时才查宿主，已知路径可传kicadCliPath。

默认不额外运行 ERC、独立网表比对或生成 PCB；用户要求时再做。正式概览须 deliveryStatus:ready 且 overview 有效，并作为本轮最后一个工具操作，随后直接交付说明。

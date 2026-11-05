# 主 agent：派发与装配

仅主 agent 需要读本页。子 agent 的执行依据是独立task.md，不再读取整套准备/发布流程。模块电路仍由子 agent 编写脚本。

## 准备与派发

1. 沿用确认方案，先按 module-selection.md 对每个功能搜索并决定直接复用、修改复用或从零；有合格记录直接沿用，不重复搜索。再统一备好真实器件、符号/封装、库表和shared/parts.json，写电路前派发。按功能拆任务，电源、MCU、外扩接口即使同页或共用大框仍可独立；复位/BOOT/去耦可与MCU同任务，不为每条支路拆任务。
2. 复制parallelTemplateDir到scripts/，在设计目录根保存module-plan.json。partRoles映射共享器件键，references全局固定，value为实际数值/型号。派发前一次核对确认方案、公共 ports 与 expectedConnections，尤其电源、复位/BOOT按键和上拉连接；工具拒绝同脚不同网及端口/连接清单冲突，但不自动理解自然语言方案。主入口和共享文件由主 agent管理；派发后冻结正在执行模块的接口约定，有真实错误先协调受影响模块停止，再批量修正，避免边运行边改清单引起检查失效。
3. 各模块填写 `referencePatterns:["usb-c-device","ldo-three-pin"]` 等适用画法ID（索引见drawing-patterns.md）；只选本模块需要的项，不把STM32整图套给ESP32。省略时工具按已确认引脚/连接保守匹配USB、三脚LDO、RC/BOOT、去耦和电源LED；复杂电路由主 agent明确选择，定制且无适用图样可填[]。调用 `dispatch_kicad_schematic_modules({manifestPath})`，预检资源、引脚、电源符号Value与网名、框范围/格点及位号。通过后生成骨架、几何、去重参考说明和只读task.md，附参考图绝对路径，要求子 agent写首版前读说明和图片；保留已有脚本及模型配置。
4. maxParallel 为正整数，不再固定限制为3。希望所有独立模块同时启动时，将 maxParallel 设为模块总数；用户指定较小并发时遵从指定值。实际运行仍受原生后端容量和模块 dependsOn 约束。工具最多保持 maxParallel 个任务。收到完成通知立即刷新并补位；action:"status"只刷新不启动。未派发项才会新启动；已派发项不重复启动，不使用Start-Sleep或文件轮询。unknown先核对原生子级状态，进度消息不等于完成。

原生后端须支持独立上下文和直接子级查询；必要时用subagentTool指定，不选fork后端。工具不可用、旧图定向修复或模块无法分离时，说明实际原因，runner传 --sequential-reason；不伪造派发或为省事回退。

MODULE_DELEGATION_REQUIRED后停止整图构建，准备清单并派发；runner在方案旁.schematic-state/记录已观察到的多模块要求，换脚本/报告名或合框仍拦截。--read-plan可查看generationRoute，不删除状态绕过。已声明多模块清单也会绑定此路线。

新派发模块必须填写 `reuse` 选择记录（字段见 [模块选择](module-selection.md)）；缺失或不完整集中返回 MODULE_REUSE_REQUIRED，启动前补齐。派发工具不替主 agent 搜索，也不验证远端事实，禁止编造检索记录。status 与已派发任务的修复/续派不追补旧记录；独立 preflight-modules 检查整个清单。

当前并行模块 draw/region 接口没有 importModule。选中整块复用电路时，主 agent 在派发前按 [平铺整合](flat-reuse.md) 确定导入和适配路线，不把完整来源退化成逐器件重画；不能承诺仅填 reuse 就自动导入。不能独立拆分的实际整合工作按既有 --sequential-reason 规则说明原因，独立新增功能仍遵循派发要求。

## 清单示例

以下仅演示接口；真实库、器件、引脚、数值和方案哈希必须替换。模块id使用小写字母开头及数字/短横线，不能含下划线。

```json
{
  "version":1,
  "maxParallel":3,
  "designPlan":{"path":"docs/project-brief.md","sha256":"读回的64位sha256"},
  "project":{"name":"modular_demo","title":"Modular design","paper":"A4"},
  "parts":"scripts/shared/parts.json",
  "sharedSources":[],
  "resources":["project/libraries/symbols/Device.kicad_sym"],
  "power":{"library":"bundled","nets":{"+3V3":"power:+3V3","GND":"power:GND"}},
  "modules":[
    {
      "id":"input",
      "goal":"输入电阻支路",
      "reuse":{"decision":"new","reason":"候选不满足本方案接口要求，具体差异已核实","searches":[{"tool":"eda_module_rag_search","query":"实际输入支路需求","outcome":"found"}]},
      "entry":"scripts/modules/input.mjs",
      "sources":[],
      "dependsOn":[],
      "references":{"resistor":"R1"},
      "partRoles":{"resistor":"resistor"},
      "nets":{"supply":"+3V3"},
      "ports":{"signal":{"reference":"R1","pin":"2","net":"SIGNAL","voltage":"3.3V"}},
      "region":{"name":"Input","description":"Input resistor","origin":[25.4,25.4],"size":[80.01,80.01]},
      "expectedConnections":[{"net":"+3V3","pins":[{"reference":"R1","pin":"1"}]},{"net":"SIGNAL","pins":[{"reference":"R1","pin":"2"}]}]
    },
    {
      "id":"output",
      "goal":"输出电阻支路",
      "reuse":{"decision":"new","reason":"实际搜索未找到合适候选","searches":[{"tool":"eda_module_rag_search","query":"实际输出支路需求","outcome":"no_match"}]},
      "entry":"scripts/modules/output.mjs",
      "sources":[],
      "dependsOn":[],
      "references":{"resistor":"R2"},
      "partRoles":{"resistor":"resistor"},
      "nets":{"ground":"GND"},
      "ports":{"signal":{"reference":"R2","pin":"1","net":"SIGNAL","voltage":"3.3V"}},
      "region":{"name":"Output","description":"Output resistor","origin":[120.65,25.4],"size":[80.01,80.01]},
      "expectedConnections":[{"net":"GND","pins":[{"reference":"R2","pin":"2"}]},{"net":"SIGNAL","pins":[{"reference":"R2","pin":"1"}]}]
    }
  ],
  "links":[]
}
```

- 路径以清单目录为根；parts推荐JSON，libraryPath用项目相对路径，不猜盘符。格式为 `{器件键:{libraryPath,libId,footprint,value,pins:{语义键:"物理脚号"}}}`。所有用到的库及其它非代码输入列入resources，本地代码依赖列入sharedSources或模块sources，不自动追踪动态导入。旧parts.mjs只作兼容，每次独立进程读取。
- region是并行布局的唯一来源，不另维护layout.mjs。origin/size使用1.27mm栅格，按真实器件和功能组估算，留文字、电源和走线空间；不直接给每个小模块分半张A3。子任务携带region快照，收框/扩框由主 agent统一修改。

派发和 preflight-modules 在现有器件/引脚预检后做原生几何空间筛查。MODULE_SPACE_INSUFFICIENT 表示固定引脚几何即使考虑旋转也无法放入预留标题/说明后的区域，或内容区已无高度，启动前集中修框；spaceWarnings 中 tight 只是带字段/走线余量的拥挤估计，unmeasured 表示缺少可测尺寸，均不代表已证明放不下。suggestedSize 按 1.27mm 对齐但不自动应用，主 agent 要连同相邻框和页面边界一起决定。首次出现 POWER_PLACEMENT_UNAVAILABLE 或明确空间冲突，汇总后统一扩框/重排，不让子任务继续逐个挪动试错；也不能用缩字隐藏问题。

检查返回的 report 默认只给统计及完整 reportPath，问题集中在 reviewPlan：issueCount/counts 是全部统计，issues 最多 12 项且正文预算 6000 字符，优先结构、越框、文字和字段问题，再列近似重叠；omittedIssues>0 或 repairPlan.fullReportRequired=true 必须定向读取完整报告的遗漏诊断后一次批量修复。repairPlan.stage 为 structure/resize/layout/visual_review，分别先修结构连接、先由主 agent 决定空间、集中修已确认布局缺陷、读图确认。近似重叠本身不能作为反复重建理由，最终 reviewMode:full 和真实读图仍必需。
- nets声明所有明确命名的网络；expectedConnections覆盖关键引脚、重复供电/地和外壳脚，同一引脚不能分配到冲突网络。默认网名精确匹配；内部网可显式namePolicy:"connectivity"，公共端口和电源禁止放宽。检查不覆盖全部电气条件或未声明短路。
- dependsOn仅填写生成的真实前置依赖，不因两模块有线相连就串行。公共端口须真实reference/pin、精确net和一致voltage；电平转换两侧分别定义端口，不能改字符串掩盖差异。
- 同页同名标签已连通，默认links:[]。确需画跨区线才添加from/to和laneX或via（全局坐标，二选一）；从真实引脚起线，不保证绕开符号/其它引脚。规划端口labelAt/angle仅为建议，子脚本返回实际落点；主 agent核对跨区路径，不能照搬示例通道。
- power.library="bundled"使用随包GND/+3V3/+5V；特殊电源明确核实库。主 agent负责将已用库复制到project/libraries并注册。电源转换由运行时统一完成，子模块只添加内部电源标签及返回公共端口。

## 收取与局部修复

默认每个子 agent一次交付。状态inactive还须核对新鲜check.json、输入版本和真实候选；passed仅表明已执行的结构/声明连接检查通过，reviewStatus仍pending。

主 agent确认子任务停止后，集中修参数、文字和局部布局，改生成脚本，调用check_and_preview_kicad_module复查再刷新status。failed/stale和真实可读性缺陷列入parentRepair，不自动续派；只有拓扑重做、大范围布局或交付中断才retry，提供moduleId、feedback和retryReason（circuit_redesign / major_layout / interrupted）。不与运行中的子 agent并发写同一文件。

parentLayoutReview保留各模块问题和未检查状态；主 agent结合当前图检查功能组紧凑、局部短线直连、阅读顺序和文字归属，关闭真实缺陷。散乱支路不算纯装饰，近似误报说明位置。readyForAssembly允许构建候选，不认证交付。

## 装配与交付

```text
node <runnerPath> <设计目录>/scripts/design.mjs <唯一候选目录> <报告.json> --plan <方案绝对路径> --plan-sha256 <读回哈希> --modules <设计目录>/module-plan.json
```

入口核对真实派发记录、候选和输入版本，拒绝缺失/失败/过期结果；在同一Schematic先全部place再全部connect，统一公共标签、电源和跨区线，不拼接多个KiCad文件。无关模块或整图links修改不使独立模块过期；共享输入和真实依赖变化仍须复查。

构建和检查保留最新报告及report-history，查看旧问题不重建。最后核对供电、地、电压域和跨模块接点，按 [布局与交付](layout-delivery.md) 发布正式工程。模块端口错误查任务的接口摘要；扩展API查 [编程接口](programming.md)，具体故障查 [恢复参考](troubleshooting.md)，不沿链接通读。

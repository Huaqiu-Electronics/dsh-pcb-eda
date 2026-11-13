# 按具体错误恢复

先读返回的code/stage/message/nextAction；只处理对应文件或模块。确定性错误先改输入，retryUnchanged:false不原样重试。成功资源沿用，不为排障重画无关电路。

| 错误或阶段 | 下一步 |
| --- | --- |
| SCRIPT_READ_FAILED / SCRIPT_CHECK_FAILED | 按preflight.file修路径、Node启动或超时，设计代码尚未执行 |
| SCRIPT_INVALID_UTF8 / SCRIPT_SYNTAX_ERROR、MODULE_INVALID_UTF8 / MODULE_SYNTAX_ERROR | 按报错文件/行定向恢复；入口和模块显式依赖分别检查。双端UTF-8及局部edit见 [编程接口](programming.md#脚本编辑与编码)，不进入修图循环 |
| file changed since it was read | 先读最新文件并核对片段，保留并发改动，不用旧全文覆盖 |
| MODULE_REPORT_MISSING / MODULE_CHECK_FAILED / MODULE_RESULT_STALE | 核对对应模块及变化输入，确认子任务停止后检查/修复；不手写passed或自动续派 |
| MODULE_DELEGATION_REQUIRED / MODULE_DELEGATION_INCOMPLETE / MODULE_DISPATCH_STALE | 停止整图补丁，按 [并行流程](parallel-generation.md) 准备/派发并核对真实child；合框、换文件名不清除方案路线，真实回退才传--sequential-reason |
| MODULE_PLAN_PREFLIGHT_FAILED / MODULE_LAYOUT_OVERLAP / MODULE_RESOURCE_MISSING / MODULE_PART_LIBRARY_INVALID | 按全部issues集中修公共框、位号、库路径；未通过前不启动worker，不重复额外预检 |
| MODULE_PORT_PIN_INVALID / MODULE_PART_PIN_INVALID | 修真实脚号、unit和partRoles，不猜几何或写探测工程 |
| MODULE_SUBAGENT_UNAVAILABLE / MODULE_SUBAGENT_CALL_FAILED / MODULE_PLAN_CHANGED_ACTIVE | 不绕过关闭/权限；先核对原生子级和已保存label。启动结果不明不重派，共享配置变化先完成或停止旧任务 |
| MODULE_REFERENCE_CONFLICT / MODULE_FILE_CONFLICT / MODULE_LINK_INVALID | 主 agent修共享位号、文件分工或端口网络/电压，不让子 agent改公共约定 |
| MODULE_PORT_MISMATCH / MODULE_PART_MISMATCH / MODULE_NET_UNDECLARED | 按任务修真实端口、器件身份、内部网声明或模块前缀 |
| MODULE_CONNECTION_MISSING / MODULE_NET_NAME_MISMATCH / MODULE_NET_MERGED | 核对报告实际网络：补漏接、补准确标签或拆错连；不能仅放宽公共/电源网名检查 |
| WIRE_ROUTE_INVALID | 按全部issues集中修复；connect现取pin，offset/stub带动短线标签，明确axis/lane，不保留移动前坐标或重试零长度线 |
| 文件not found / ENOENT | 相对资源基于skillDir或所在文档，项目资源基于清单根；有需要只列确切父目录，修好前不重复读同一路径 |
| fetch failed / 超时 / 429 / 5xx | 区分服务和器件故障；工具未自行重试时最多补一次，持续失败换已核实候选或报告阻塞，不把服务故障说成无模型 |
| missing / invalid / unsupported_units / PIN_PAD_MISMATCH | 根据sourceUrl、结构及nextAction换合格模型，不原样重试确定性失败；器件更换同步方案 |
| 导入部分写入/库表冲突 | 检查错误给出的项目文件，再修具体冲突，不清空工程或另写下载器 |
| POWER_PLACEMENT_UNAVAILABLE / POWER_SYMBOLS_REQUIRED / POWER_LABEL_INVALID | 按全部接点扩框、补标签/转换或用本轮catalog；保留符号要求。精确操作见 [电源符号](power-symbols.md) |
| 封装未解析 | 检查下载结果和随包封装索引。遇到 MODULE_FOOTPRINTS_UNAVAILABLE，按报告的位号和原封装 ID 改选有完整随包封装的模块。 |
| CLI_START_FAILED | 复用get_eda_host_info中kicad-cli绝对路径；原模块下载参数加 kicadCliPath 和 refreshAnalysis:true，复用当前进程的近期下载 |
| 模型TRANSPORT重试 | 属Harness/模型链路，不通过改原理图或技能资源路径修复 |

## 渲染和交付

format_preflight定位格式字段，kicad_load定位KiCad加载失败，svg_export定位导出失败；按原诊断修脚本/副本，不一律改页名或PNG尺寸。partial只读实际返回的图片；失败未返回PNG时不猜路径。pageNames错误按availablePages修正；省略或[]渲染全页。

普通预览不执行封装检查，projectDir仅用于delivery:true打包。renderStatus:ok不代表delivery成功；deliveryStatus:blocked时检查failures/overviewError，保留已有图和工程。正常字段和发布条件见 [布局交付](layout-delivery.md)，不为显示卡片额外读图。

PREVIEW_OUTPUT_PATH_TOO_LONG是Windows导出路径过长：用工作区内更短的outputDir，不改图纸/纸张。始终使用返回的manifestPath、pages/regionImages图片路径，完整源映射及诊断按需读manifest，不拼旧缓存路径或另找光栅化工具。

缺引脚核对符号/unit，源网络不存在修nets映射，缓存冲突核对真实定义；不支持对象则选合格来源或可靠适配，不删除未知电气对象绕过。当前主线修改生成脚本再构建，不调用旧对象list/UUID编辑接口或研究解析器。

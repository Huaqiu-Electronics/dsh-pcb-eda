# 生成和预览错误处理

## 路径与请求失败

插件根目录 pluginDir 与技能根目录 skillDir 不同。技能返回的 runtimePath、runnerPath、geometryPath 可直接使用；其他相对资源以 skillDir 为根，文档内相对链接以该文档所在目录为根。安装资源只读，生成文件保存到当前工作区。

| 错误 | 下一步 |
| --- | --- |
| 文件 not found / ENOENT | 核对资源清单及相对路径根；仅缺少确切信息时定向列出该父目录。路径未修正前不再次读取同一文件。不要把路径错误当作 ACL 问题。 |
| fetch failed / 超时 / 429 / 5xx | 先区分服务故障与具体器件故障。工具未自行重试时最多补充一次重试；持续失败则保留诊断并换已核实的合格候选或报告阻塞。有成功替代型号后不再尝试失败候选。 |
| 模型 missing / invalid / unsupported_units / PIN_PAD_MISMATCH | 按 sourceUrl、结构和 nextAction 换合适模型或器件；同一输入不原样重试，不伪造模型。更换方案器件时同步文档。 |
| 导入发生部分写入或库表冲突 | 按报错中的目标路径检查已写入文件，修正具体冲突后再调用；不删除其他库或另写绕过工具的下载器。 |
| FOOTPRINTS_UNRESOLVED | 查 footprintCheck.sheets 的引用与原因，修正本地封装、库表或持久脚本映射；几何未变时不重画。修好后重用原候选做普通预览/检查。 |
| 模型 TRANSPORT 重试 | 属于 Harness/模型传输链路，不通过改原理图、重下载器件或更改技能路径修复。 |

## 预览与交付状态

普通候选预览支持 projectDir，指向已准备本地库的工程目录，返回 footprintCheck（未检查时为 null；status 为 ready 或 blocked，含逐页结果）。首版预览就检查此项，避免正式交付时补全器件模型导致换符号和布局返工。也可使用 localize_kicad_module_footprints({action:"check",schematicPath,projectDir}) 单独检查，不重复执行已有同版本检查。

renderStatus 表示图片渲染结果；deliveryStatus 为 not_requested、ready 或 blocked。正式交付失败时顶层 status 为 error，但已生成的 pages/regionImages 仍可用于诊断。overviewError 非空时按具体原因处理，不能因 renderStatus:ok 宣称交付成功。

## 图纸生成与渲染


先读错误 JSON 的 code、stage、schematicPath、diagnostics、nextAction 与 retryUnchanged。format_preflight 表示已定位的格式错误，按行列和字段修正副本或生成程序；kicad_load 表示 KiCad 加载失败，按原始输出定位，不把所有错误当成页码错误。svg_export 是导出失败，不能由修改 PNG 尺寸修复原理图加载问题。

retryUnchanged:false 时修正原因后才调用；失败结果没有可读取 PNG 时不得猜路径。partial 时先读取实际 rootImagePath/pages[].pngPath，再检查 failures。只对不在 failures 中的遗漏页用 omittedPages 中准确 pageNames 补充生成；不要重建已生成工程、寻找外部光栅化程序或修改临时纸张尺寸。

构建器报不存在引脚时核对实际符号和 unit；非正交导线补明确折点；缓存不一致统一真实符号定义。导入报源网络不存在时修正 nets 键，保留私有网络默认隔离。unsupported imported object 时选择支持的来源或可靠地准备副本，不删除未知电气对象绕过失败。

编辑查询 `types:["rectangle"]` 获取外框；frame/region 是生成接口概念，不能作为 list 类型。types 和 UUID 以工具声明及 list 结果为准。失败后局部修正对应模块，不原样重试或编写新的底层解析程序。

## SVG 输出路径过长

PREVIEW_OUTPUT_PATH_TOO_LONG 表示计划或实际 SVG 输出路径达到 Windows MAX_PATH 长度，不是原理图语法错误。使用当前工作区内更短的 outputDir 后重试；不修改原理图、纸张或图像尺寸。预览使用短哈希目录，来源路径、完整版本与渲染参数在 manifestPath 中。必须读取工具返回的路径，不能从旧缓存路径拼接新的文件名。

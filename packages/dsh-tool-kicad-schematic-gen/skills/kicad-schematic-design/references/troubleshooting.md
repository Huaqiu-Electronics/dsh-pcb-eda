# 生成和预览错误处理

先读错误 JSON 的 code、stage、schematicPath、diagnostics、nextAction 与 retryUnchanged。format_preflight 表示已定位的格式错误，按行列和字段修正副本或生成程序；kicad_load 表示 KiCad 加载失败，按原始输出定位，不把所有错误当成页码错误。svg_export 是导出失败，不能由修改 PNG 尺寸修复原理图加载问题。

retryUnchanged:false 时修正原因后才调用；失败结果没有可读取 PNG 时不得猜路径。partial 时先读取实际 rootImagePath/pages[].pngPath，再检查 failures。只对不在 failures 中的遗漏页用 omittedPages 中准确 pageNames 补充生成；不要重建已生成工程、寻找外部光栅化程序或修改临时纸张尺寸。

构建器报不存在引脚时核对实际符号和 unit；非正交导线补明确折点；缓存不一致统一真实符号定义。导入报源网络不存在时修正 nets 键，保留私有网络默认隔离。unsupported imported object 时选择支持的来源或可靠地准备副本，不删除未知电气对象绕过失败。

编辑查询 `types:["rectangle"]` 获取外框；frame/region 是生成接口概念，不能作为 list 类型。types 和 UUID 以工具声明及 list 结果为准。失败后局部修正对应模块，不原样重试或编写新的底层解析程序。

## SVG 输出路径过长

PREVIEW_OUTPUT_PATH_TOO_LONG 表示计划或实际 SVG 输出路径达到 Windows MAX_PATH 长度，不是原理图语法错误。使用当前工作区内更短的 outputDir 后重试；不修改原理图、纸张或图像尺寸。预览使用短哈希目录，来源路径、完整版本与渲染参数在 manifestPath 中。必须读取工具返回的路径，不能从旧缓存路径拼接新的文件名。

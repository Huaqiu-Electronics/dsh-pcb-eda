# 结构化编辑调用

用于已有单页图的局部编辑。程序负责解析、定位和写入；模型负责选择电路修改内容。不需要校验值、固定行号或临时解析脚本。

方案阶段默认用 analyze_kicad_module 查询器件、BOM 和电气网络，不常规调用本工具。每次例外读取应针对现有分析无法回答的具体问题，例如影响选型的图纸备注；使用 list + types:["text","text_box"]，或按实际缺口选择 types/references，读到足够信息即停止。已有结果直接复用，不提前收集绘图坐标/UUID。以下几何定位、connections 和 create 操作主要用于实际原理图适配；纯方案任务不生成修改副本。list/connections 是只读操作，create 才写入新副本。

## 按需列出对象

```json
{
  "action": "list",
  "sourcePath": "designs/ldo/sources/module.kicad_sch",
  "types": ["text", "text_box", "image", "symbol", "hierarchical_label"]
}
```

调用 `edit_kicad_flat_schematic`。`objects` 提供对象类型、UUID 和 `bounds`（毫米，文字范围为保守估计）；符号还有引用编号、数值、libId 和准确引脚坐标，导线还有两个端点。`image` 返回 `image.pixels`、`ppi`、`scale`、毫米尺寸 `size` 和居中放置的 `bounds`，不返回图片数据。工具读取 PNG 头和分辨率，按 KiCad 10 的规则处理旧版本图与缩放，不扫描像素。`types` 可省略；支持 symbol、wire、junction、label、global_label、hierarchical_label、no_connect、text、text_box、rectangle、polyline、image。没有类型筛选时也列出其它有 UUID 的顶层对象；无法测量的几何在 `boundsError` 中说明。按需使用 `nextOffset` 分页。`pinError` 表示该符号坐标无法解析，不能把未返回的引脚坐标当成已确定。此操作不核对电气连接。

`layout` 汇总完整来源内容，独立于类型筛选和分页：`contentBounds`、网格对齐的 `suggestedFrame`、无法测量对象的 `issues`。默认不把旧 rectangle 图形作为外框范围依据，也不计入页面边框和标题栏；其它保留图形仍计入。这个摘要用于了解来源范围，生成时按实际修改重新计算，不需要模型手动抄写建议坐标。

## 查询指定引脚的可见连接

实际适配时需要准确定位复位、启动或接口的可见导线接入位置，调用同一工具；只问电气上连接到哪里时用 analyze_kicad_module 的 nets：

```json
{"action":"connections","sourcePath":"designs/ldo/sources/module.kicad_sch","reference":"U1","pin":"3"}
```

`connection.target` 给出引脚名称、实际页坐标、符号 UUID、unit 和可直接用于 `addWires.from/to` 的 `endpoint`。`objects` 分页返回与该引脚通过可见导线相连的器件引脚、导线、标签、结点和未连接标记；符号只列本次相连的引脚。电阻/电容内部不会被穿透，检查另一端时查询其另一引脚。`connection.netNames` 是接在这组导线上的标签文字，不是完整网络命名解析。同名但不相接的标签、隐式电源和其他页面不跟踪；普通内部交叉没有 junction 时不相连。查看 `limitations` 和 `diagnostics`，结果不等于 ERC 或网表验证。

只要器件清单时用 analyze_kicad_module 的 components；实际编辑需要引脚坐标时，用 `list` 加 `references:["U1","R1"]`，只返回所选符号，避免列出整图。符号还包含 angle、mirror、DNP、Footprint 和引脚 electricalType。两种查询都返回来源 `sha256`；来源变更后重新查询，不沿用旧坐标/UUID。常规接线使用这些结果和 `addWires` 的引脚端点，不编写 PowerShell/正则提取坐标，不根据图片猜引脚位置。`layout` 仍汇总整页，不能当作筛选器件的局部外框。

## 一次生成工程副本

```json
{
  "action": "create",
  "sourcePath": "designs/ldo/sources/module.kicad_sch",
  "targetDir": "designs/ldo",
  "projectName": "ldo_3v3",
  "setValues": [{"reference": "C1", "value": "10uF"}],
  "frames": [{
    "name": "3.3 V 稳压",
    "description": "输入电源稳压；输入与负载条件待确认",
    "autoBounds": true
  }]
}
```

范例中的引用编号必须按当前电路确定。所有编辑数组均可省略；直接采用电路时只提供外框，已有外框符合要求时不重复添加。`autoBounds: true` 不填写 start/end，程序按编辑后的保留内容计算范围，增加标题、说明和留白，按模板网格向外取整。单一模块默认纳入全部保留内容（旧 rectangle 除外）；多个模块用 `objectUuids` 明确各自所属对象，包括器件、导线、标签和说明图片。可用 `excludeUuids` 排除保留装饰对该框范围的影响；排除不会删除对象，不要用它隐藏本应纳入模块的电路。手动框仍使用 start/end，不能与 autoBounds 混用。

支持 `removeReferences` 删除器件的所有 unit，`removeUuids` 删除指定顶层对象（包括明确选中的 image），`setValues` 修改 Value，`setLabels` 按 UUID 修改现有标签，`addWires` 增加明确的导线路径，`frames` 增加模块框和说明。删器件不删周围线、标签或结点，这些对象需明确列出；没有自动分支裁剪。

清理来源说明时先调用 `list`，将 `types` 设为 `["text", "text_box"]`。读取内容后，在 `create` 中提供 `removeTextUuids: ["实际文字UUID", ...]`，与其它修改和 `frames` 一次提交；不要用此示例占位符实际调用。程序只删除选定的顶层普通文字，不接受网络标签、层次标签或符号属性，也不会自动删除所有文字。保留必要接法、限制和警告，选定的冗长介绍保留在来源文件中；新外框默认使用短标题和一行说明，范围依据清理后保留的电路确定。

`addWires` 的 `from`、`to` 可以是 `[x,y]`，或 `{"reference":"U1","pin":"3"}`；坐标单位为毫米，pin 是引脚编号。`via` 是显式折点数组，各段必须水平或垂直且长度非零。不要猜旋转、镜像后的引脚位置。工具不自动规划折点、添加分支结点、新增器件或移动器件。

成功结果返回 `schematicPath`、`projectPath`、实际修改计数 `changes`、实际生成的 `frames` 坐标和 `nextAction`，按返回路径预览一次。失败结果包含 JSON 的 `code: FLAT_EDIT_FAILED`、`message`、`retryUnchanged: false` 和 `nextAction`；根据选择器、缓存、折点或输出名称修正后重试，不原样反复调用。写入失败可能留下此前写入的文件，以错误中的路径清单为准。

`boundsError` 或自动外框错误指出无法测量的对象 UUID，例如非 PNG 图片或未展开的继承符号；改用手动 start/end 并预览，不为测量外框编写临时解析器、提取图片、扫描像素或研究 SVG/DPI。必要说明图片默认保留；确属冗余图片时才按 UUID 删除或浓缩成文字。文字和弧线采用保守范围，不是 KiCad 的精确字形测量，最终预览仍需确认没有遮挡。

## 固定模板

工程配置字段、复制后改名与手动编辑注意事项见 [平铺工程文件处理](flat-project.md)。

工程配置使用 [project.kicad_pro](../templates/project.kicad_pro)；矩形、标题和说明使用 [module-frame.kicad_sch.fragment](../templates/module-frame.kicad_sch.fragment)，间距与导线线宽使用 [frame-style.json](../templates/frame-style.json)。自动布局的 contentPadding、grid、textWidthFactor、textHeightFactor 都由模板配置。程序替换位置、文本及 UUID，不需要模型重新构造字段或测量图片；文字是否遮挡仍通过最终预览判断。

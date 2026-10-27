# 结构化单页编辑

`edit_kicad_flat_schematic` 用于读取几何/UUID，或生成修改副本；不新增、移动符号，不自动布线。方案阶段的器件/BOM/网络优先用 analyze_kicad_module，只有缺少必要备注等信息时定向 list；几何定位与 create 留到适配阶段。

## list：按缺口读取

```json
{"action":"list","sourcePath":"designs/demo/sources/module.kicad_sch","types":["symbol"],"references":["U1","R1"]}
```

需要说明时改用 types:["text","text_box"]；外框类型为 rectangle，不是 frame/region。支持 symbol、wire、junction、label、global_label、hierarchical_label、no_connect、text、text_box、rectangle、polyline、image。省略 types 会列其它有 UUID 的顶层对象，勿默认全图遍历。按 nextOffset 分页，复用查询结果。

返回对象 UUID、类型、保守 bounds；符号含引用、数值、libId、angle/mirror、DNP、Footprint、实际引脚及 electricalType，导线含端点。pinError 表示引脚未解析，不能猜坐标。image 含 pixels/ppi/scale/size/bounds，不含图片数据。

layout 的 contentBounds/suggestedFrame/issues 汇总整页，独立于筛选和分页，不是所选器件的局部框。默认忽略旧 rectangle、页面边框及标题栏。来源 sha256 改变后重新查询，不复用旧 UUID/坐标。

## connections：可见导线定位

```json
{"action":"connections","sourcePath":"designs/demo/sources/module.kicad_sch","reference":"U1","pin":"3"}
```

用于实际编辑前确定接入位置；只问电气网络用分析工具 nets。connection.target 给引脚、unit、符号 UUID、整页坐标及可用于 addWires 的 endpoint；objects 分页列可见导线连接的引脚、线、标签、结点和 NC。

不穿透阻容内部，不追踪同名但不相接的标签、隐式电源或其他页；交叉无 junction 不相连。connection.netNames 只是这组导线的标签文字。须查看 limitations/diagnostics，不当作完整网表或 ERC。

## create：一次生成副本

```json
{
  "action":"create",
  "sourcePath":"designs/demo/sources/module.kicad_sch",
  "targetDir":"designs/demo/.candidate/run-001",
  "projectName":"demo",
  "designPlan":{"path":"<已保存并读回的方案绝对路径>","sha256":"<读回的64位sha256>"},
  "setValues":[{"reference":"C1","value":"10uF"}],
  "frames":[{"name":"3.3 V 稳压","description":"输入与负载条件见方案","autoBounds":true}]
}
```

替换占位方案和实际位号；targetDir 须已存在且输出未占用，工具生成其 schematic/ 子目录。create 必须绑定已读回方案，list/connections 不要求。编辑数组可省略，已有合格框不重复添加。

| 参数 | 语义与限制 |
| --- | --- |
| removeReferences | 删除指定器件全部 unit；不自动删周围导线、标签和结点。 |
| removeUuids | 删除明确顶层对象，包括选定冗余 image；不裁剪分支。 |
| removeTextUuids | 仅选定普通 text/text_box；先读内容，保留必要接法、限制、警告，不接受电气标签或符号属性。 |
| setValues / setLabels | 按引用改 Value，按 UUID 改现有标签。 |
| addWires | from/to 为毫米点或 `{reference,pin}`；via 显式折点，每段非零且正交。不自动加 junction。 |
| frames | name/description，加 autoBounds:true 或 start/end（二选一）。objectUuids 选择所属内容；excludeUuids 只排除装饰的范围影响，不删除对象，不隐藏实际电路。 |

autoBounds 按编辑后保留内容和模板计算，默认纳入单模块全部内容（旧 rectangle 除外），预留标题、说明并向外取整。只增框，不移动或缩放电路；布局表达见 [模块外框](module-layout.md)。不要用固定行号或全局替换改文件。

成功返回 schematicPath/projectPath、changes、frames 和 nextAction，以真实路径预览。FLAT_EDIT_FAILED 返回 message、retryUnchanged:false、nextAction，修正原因再调用；I/O 失败可部分写入，按报错路径检查，不清空工程。

boundsError 或自动框失败时定位具体 UUID，采用保守手动框并预览；不为测量图片编写解析器、像素扫描或校准 SVG/DPI。图片及文字边界非精确字形测量，必要说明图片默认保留。

## 配置与模板

使用随包 [工程配置](../templates/project.kicad_pro)、[外框片段](../templates/module-frame.kicad_sch.fragment) 和 [间距配置](../templates/frame-style.json)，程序替换字段及 UUID。配置、复制改名和缓存匹配仅需时读 [工程文件处理](flat-project.md)；正常编辑不研究模板内部字段。

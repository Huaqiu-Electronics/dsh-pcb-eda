# JavaScript 生成接口

单框编写或确需扩展 API 时读取。模块子 agent 的日常 draw 用法已经在 task.md，不必再读本页；主 agent 的并行组织见 [并行生成](parallel-generation.md)。

## 执行脚本与读取结果

runtimePath、runnerPath直接使用技能返回的绝对路径；其余相对资源基于skillDir，不能基于pluginDir。先保存并读回方案：

```text
node <runnerPath> --read-plan <方案绝对路径>
node <runnerPath> <design.mjs绝对路径> <唯一候选目录> <报告.json> --plan <方案绝对路径> --plan-sha256 <已读哈希>
```

多功能默认派发与 --modules，写电路前先准备清单；同页/合框不改变模块分工。MODULE_DELEGATION_REQUIRED会按方案路径留存，立即按nextAction转派发；真实单功能/旧图修复不虚构回退理由。

脚本将唯一结果 JSON 输出到 stdout，诊断放字段或 stderr；启动器保存完整 UTF-8 报告、historyPath 和精简摘要，不为追溯日志重建。summaryStatus 的 recovered/unavailable 不改变退出码。构建、输入版本和真实交付状态分别核对。

## 单框最小结构

```js
import {pathToFileURL} from 'node:url';
const {Schematic,symbolLibrary,templateDir}=await import(pathToFileURL(runtimePath).href);
const nets={GND:'power:GND','+3V3':'power:+3V3'}; // 只填已确认共享电源
const sch=new Schematic({projectName:'design',title:'设计',paper:'A4',templateDir,
 requiredPowerSymbols:nets}); // runner 提供方案；独立 API 显式传 designPlan:{path,sha256}
const region=sch.region({name:'功能区',description:'用途与限制',
 origin:[25.4,25.4],size:[101.6,101.6]});
// imported 取实际导入结果，不是示例器件定义。
region.addSymbol({libraryPath:imported.libraryPath,libId:imported.libId,
 footprint:imported.footprintId,reference:'U1',unit:1,at:[40.64,40.64]});
// 放完全部器件，再依据实际引脚完成所有接线、标签和标记。
// 关键点和次要支路都用 region.label；把需要保持黑字的电源标签 UUID 加入 keepAsLocalLabels。
const keepAsLocalLabels=new Set();
const spec={libraryPath:symbolLibrary('power'),nets,keepAsLocalLabels};
const plan=sch.planPowerPlacements(spec);
sch.replacePowerLabels({...spec,placements:plan.placements});
sch.checkPowerSymbols();
console.log(JSON.stringify(sch.save(process.argv[2])));
```

Schematic 必填 projectName/title/paper/templateDir；paper 支持 A4/A3/A2/A1/A0。unit 采用模型 availableUnits，不默认全是1。电源库注册及精确调整仅在需要时读 [电源符号](power-symbols.md)。

## 坐标与区域

region 数组坐标均为框内局部毫米，region.pin 也返回局部点；region.at 转全局，sch.pin 返回全局。不要将 sch.pin 数组直接交给 region 方法。`{reference,pin}` 端点无需手动转换。

| API | 参数和行为 |
| --- | --- |
| sch.region({name,description,origin,size}) | 固定外框及标题/说明；不再另加 frame，范围不是自动装箱 |
| addSymbol(spec) | libraryPath/libId/reference/at 必填；可传 value/footprint/unit/angle/mirror/referenceAt/valueAt/fieldAngle/hideReference/hideValue；角度0/90/180/270 |
| pin(reference,number) | 返回放置、旋转、镜像后的真实引脚点；缺失/多unit歧义时报错 |
| wire(from,to,via=[]) | 显式正交折线，不避障；分支用 marker('junction',at) |
| wireOrthogonal(a,b,{axis:'x'或'y',laneX?,laneY?}) | 产生明确折点；axis:x 先水平再竖直，axis:y 先竖直再水平；通道参数按对应方向使用，不负责绕开其它对象 |
| label(net,at,angle=0) | 同页局部标签，同名互连，须落在目标线上/引脚上 |
| marker('junction'或'no_connect',at) | 接点或明确NC，不推断电气接法 |
| hierarchicalLabel(name,at,angle=0) | passive层次标签，必须接入真实电路 |
| frame(spec) | name/description；autoBounds:true 或 start/end 二选一；不移动电路 |
| pinCatalog({includeBounds?}) | 实例真实引脚及pinError；不含标签。includeBounds:true 另测包围框，供空间预检；普通引脚查询继续使用原缓存 |
| render()／save(directory) | 返回文本／写新目录，结果含路径、外框、电源和方案信息；拒绝覆盖旧输出 |

同一 reference 多unit须使用同一符号；重复reference/unit、缺unit、冲突缓存均报错。简单extends可展开，不支持派生图形覆盖时使用已展开模型，不写替代解析器。

## 模块 draw 与公开端口

模块导出 `place({draw,region,parts,references,nets,bounds})`，返回 `{ports,bounds,connect}`，先完成全部 place 再统一 connect。draw.put 复用确认的器件和value，不得覆盖身份。

- draw.put(role,{at,angle?,mirror?,unit?,referenceAt?,valueAt?,referenceOffset?,valueOffset?,fieldAngle?,hideReference?,hideValue?})。竖放两脚电阻、电容的位号和值在右侧左对齐，横放阻容、IC、连接器等默认放在上方居中，位号在上、值在下。摆放时为对应位置预留空间，尤其是并排阻容的右侧和有顶部引脚的 IC 上方。At 是模块内坐标，Offset 是沿图纸轴相对器件原点的毫米数。同一字段的 At 和 Offset 互斥。
- 已确认的两脚串联器件优先用 `draw.putSeries('r_dm',{at:[136.53,82.55],from:draw.pin('mcu','GPIO18'),input:'a',output:'b'})`。先放上游器件，选有足够空间的串联位置，再让生成器按实际引脚几何选择角度并对齐输入脚。显式 `angle` 时只尝试该角度。到 `connect()` 再通过 `draw.pin` 获取两端实际坐标并用 `draw.wire` 连接，输出端标签朝器件外侧。并排摆放多颗器件时给位号、值和输出标签留空。需要绕开其他器件或没有直连空间时，用 `draw.put` 明确指定朝向和走线。
- draw.pin(role,pinRole) 按 parts.pins 的语义键取真实局部坐标；不能把物理脚号冒充语义键。
- draw.offset(at,dx,dy)、draw.row(start,count,step=10.16)；row 沿x方向。
- draw.stub(role,pinRole,dx,dy,{net?,angle?}) 从真实pin引短线并返回末端，内部标签可随线放置；用于随器件移动的电源/地支路，不重复公共端口标签。
- draw.wire(a,b,route) 对应 wireOrthogonal；draw.label/junction/nc 对应标签/接点/按语义引脚NC。
- 公共端口返回 `{reference,pin,labelAt?,angle?}`，pin 为物理脚号；运行时统一画标签及短引线，不在 connect 重复画。labelAt 为局部点，路径不避障，必须按实际符号预留通道。

旋转器件通常保留默认 fieldAngle，使文字在图纸上保持水平。默认流程使用放置时确定的字段位置。发现重叠时按预览调整器件、走线或显式字段位置。

## 脚本编辑与编码

局部修改用edit，保留实现；connect内现取pin，支路用offset/stub，相邻器件用真实pin直连。改锚点/间距，不全局替换坐标数字；移动器件同步核对导线和标签。模块检查汇总可继续检查的WIRE_ROUTE_INVALID，按全部issues集中修复，失败不保存候选。并行region只改清单，旧顺序脚本才用layout.mjs。

确需 PowerShell 读写时双方显式UTF-8：`Get-Content -LiteralPath $p -Raw -Encoding UTF8`、`Set-Content -LiteralPath $p -Value $t -NoNewline -Encoding UTF8`。工具名pwsh/控制台编码不保证文件编码。SCRIPT_INVALID_UTF8、乱码伴随SCRIPT_SYNTAX_ERROR时从正常版本恢复，不反复转码。提示file changed先读最新内容再局部修改。

需要 importModule 时读 [平铺复用](flat-reuse.md)；attachPinLabels/attachPinLabel 参数见 [标签对齐](drawing-patterns/label-alignment.md)。明确选用现成电路画法才读 [画法索引](drawing-patterns.md)，模板见 [可选模板](module-templates.md)。正常设计不读取builder/检查器源码。

检查、修复与发布统一见 [布局交付](layout-delivery.md)；具体错误查 [恢复参考](troubleshooting.md)。

# JavaScript 设计脚本接口

用于编写 `.mjs` 电路脚本。通过技能返回的 runtimePath 加载运行时，使用公开 API；正常设计不读取构建库实现猜接口。多功能框的组织见 [脚本组织](modular-scripts.md)，只复用模块见 [平铺整合](flat-reuse.md)。

## 执行脚本与读取结果

先保存方案并读回，再据此编写脚本；统一通过 runnerPath 启动：

```text
node <runnerPath> --read-plan <方案绝对路径>
node <runnerPath> <design.mjs绝对路径> <唯一候选目录> <报告.json> --plan <方案绝对路径> --plan-sha256 <读回的sha256> [额外参数]
```

启动器向脚本依次传入候选目录、额外参数，设置插件及方案环境，保存 UTF-8 JSON 报告（退出码、耗时、stdout/stderr、方案和脚本哈希）。stdout 只输出一个包含 schematicPath/projectPath 的结果 JSON，诊断放结果字段或 stderr；不用 shell 重定向或截断日志。启动器 summaryStatus 为 ready/recovered/unavailable；recovered 表示从多段 JSON 中恢复唯一结果，unavailable 附 summaryError，均不改写脚本退出码。摘要包含最多20项最终电源问题，完整输出在报告中，不为看完整日志重新构建。方案修改后重读版本；直接调用构建库也须传 designPlan，不能绕过启动器约定。

## 初始化与放置

下面是接口片段：imported 来自实际器件导入，先在项目脚本中提供该数据；不是独立测试工程。runtimePath、KICAD_SYMBOL_DIR 使用技能返回值，路径不得写死到其他安装位置。

```js
import {pathToFileURL} from 'node:url';
const {Schematic, templateDir} = await import(pathToFileURL(runtimePath).href);
const sch = new Schematic({projectName:'design', title:'设计', paper:'A4', templateDir,
  requiredPowerSymbols: powerNets}); // powerNets 只包含已确认共享电源
const region = sch.region({name:'功能区', description:'用途与限制',
  origin:[30.48,30.48], size:[76.2,76.2]});
region.addSymbol({libraryPath:imported.libraryPath, libId:imported.libId,
  footprint:imported.footprintId, reference:'U1', unit:1, at:[25.4,25.4]});
// 放置所有器件后，用真实引脚及已核实连接计划布线。
// 转换共享电源后统一保存：console.log(JSON.stringify(sch.save(process.argv[2])));
```

Schematic 必填 projectName、title、paper（A4/A3/A2/A1/A0）、templateDir；方案由启动器提供，独立 API 调用显式传 `designPlan:{path,sha256}`。构造及 render/save 均校验方案版本。实际 unit 采用模型的 availableUnits，不默认所有符号都支持 unit 1。

## 坐标与区域

坐标为毫米，电气栅格为 50 mil（1.27 mm）；用 gridPoint/snapGrid 规划，端点用 pin 返回值。构建器处理库 Y 轴、旋转和镜像；不从图片猜引脚，不分别舍入原引脚与导线修复不兼容模块。

- `sch.region({name,description,origin,size})` 创建固定外框、顶部标题、底部说明，返回 region；不用再为它加 frame。先注册各 region，预定框重叠会报错，但不检查内容越框。
- region 的数组坐标（at、referenceAt/valueAt、wire 的端点/via、label/marker）相对区域；region.pin 返回局部坐标，region.at 转整页坐标。sch.pin 返回全局坐标，不直接传给区域方法。
- `{reference,pin}` 端点按真实实例定位，区域方法无需换算。全部器件先放置，再统一布线；跨区用 sch 方法或同名标签。
- origin 改变后重新生成组内内容，不现场移动文件。origin/size 是规划范围，不是自动装箱；空间不足调整区域，预览确认。

## 基础 API

| 接口 | 参数与行为 |
| --- | --- |
| addSymbol(spec) | 必填 libraryPath/libId/reference/at；libId 为库名:符号名。可选 value、footprint、unit（默认1）、angle（0/90/180/270）、mirror（x/y）、referenceAt/valueAt；返回 UUID。属性位置在 sch 上为全局，在 region 上为局部；默认文字在器件上方。 |
| pin(reference,number) | 放置后取得真实 `[x,y]`；不存在或多 unit 歧义时报错。 |
| wire(from,to,via=[]) | 返回线段 UUID；点数组或引脚端点均可。每段非零且正交，折点显式提供，分支显式加 junction。 |
| label(name,at,angle=0) | 同页局部标签，返回 UUID；同名互连，须落在目标引脚/导线上。 |
| marker(kind,at) | kind 为 junction/no_connect，返回 UUID；NC 只表示设计意图。 |
| hierarchicalLabel(name,at,angle=0) | 生成 passive 层次标签；须真实接入电路，保存后读端口，再用于层次工具。 |
| frame(spec) | name/description，加 autoBounds:true 或 start/end（二选一）；objectUuids 选择内容，excludeUuids 默认空。不移动电路。 |
| pinCatalog() | 实例、unit、旋转/镜像/平移后的实际引脚及 pinError；不含标签。 |
| render() | 返回 schematic/project 文本、resolvedFrames 和修改统计，不写文件。 |
| save(directory) | 写同名原理图及工程，返回 schematicPath/projectPath/frames/layoutWarnings/powerLayout/designPlan；拒绝覆盖已有输出，失败可能部分写入。 |

同一 reference 的多个 unit 必须同符号；重复 reference/unit、缓存差异、缺 unit 均报错。简单 extends 可展开，派生自定义图形覆盖不支持，选展开模型。原文件和模型保持可追溯，不编写替代解析器。

## 按需扩展

- `importModule({sourcePath,name,offset,nets,footprintMappingPath?})`：见 [平铺整合](flat-reuse.md)；name 为唯一 ASCII 标识，返回 references/ports/netNames/objectUuids。先登记导入位号，再分配新增位号。
- 同侧信号用 `attachPinLabels(region,{reference,direction,pins:[{pin,net}]})`；完整参数、坐标与警告见 [标签对齐](drawing-patterns/label-alignment.md)。单个折线信号可用 attachPinLabel，详见同页，不重复给已接线引脚加线。
- 局部单元按 [画法索引](drawing-patterns.md#选定后直接读取) 先读取所选完整代码/依赖及参考PNG，再共享 place/connect；读编程接口、索引或通用 modular-design 不代表读过局部画法，不各自保存工程。
- 共享电源声明、规划、转换和 catalog 见 [电源符号](power-symbols.md)。

## 候选与发布

每次保存到新 `.candidate/<run-id>/`；一次输出路径和外框结果，不为查坐标重建。脚本存 scripts/，正式工程固定 project/；不交付候选或 revN 工程。按 [布局交付](layout-delivery.md) 检查、集中修复、发布、同步方案、清理后，最后正式 delivery。仅替换本设计生成文件及明确子页，保留库和其他文件。

报错按 [恢复参考](troubleshooting.md) 修复具体输入；构建成功、零警告及启动器 nextAction 都不是电气或交付就绪证明。

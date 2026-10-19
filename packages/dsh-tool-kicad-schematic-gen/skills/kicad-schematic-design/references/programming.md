# JavaScript 设计脚本接口

多功能区域设计先读 [模块脚本参考](modular-scripts.md)：每个框编写独立模块，统一放置完成后布线，由一个主入口保存整张原理图。下面的单电阻示例用于最小接口演示。

脚本使用普通 ESM JavaScript，保存为 `.mjs`。在 Harness 的 shell 工具中用可用的 Node 执行 `node <项目内脚本绝对路径>`。构建库通过当前 skill 末尾提供的安装目录加载；运行项目前设置 `DSH_SCHEMATIC_PLUGIN_DIR`，标准符号库设置 `KICAD_SYMBOL_DIR`（路径同样由 skill 提供）。配置与输出目录由脚本明确传入。下面是可运行的电阻示例，实际设计须替换器件和连接。

```javascript
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const pluginDir = process.env.DSH_SCHEMATIC_PLUGIN_DIR;
if (!pluginDir) throw new Error('Set DSH_SCHEMATIC_PLUGIN_DIR using the current skill installation path.');
const { Schematic, templateDir, symbolLibrary } = await import(pathToFileURL(join(pluginDir,
  'skills/kicad-schematic-design/assets/runtime.mjs')).href);
const sch = new Schematic({
  projectName: 'resistor_demo', title: 'Resistor example', paper: 'A4',
  templateDir
});
const power = sch.region({ name: '电阻模块', description: '10k 电阻示例',
  origin: [30, 30], size: [70, 70] });
power.addSymbol({
  libraryPath: symbolLibrary('Device'),
  libId: 'Device:R', reference: 'R1', value: '10k', at: [35, 30], angle: 0
});
const p1 = power.pin('R1', '1');
const p2 = power.pin('R1', '2');
const a = [p1[0], p1[1] - 5.08];
const b = [p2[0], p2[1] + 5.08];
power.wire(p1, a);
power.wire(p2, b);
power.label('INPUT', a);
power.label('OUTPUT', b);
const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error('usage: node design.mjs <absolute-output-directory>');
console.log(JSON.stringify(sch.save(outputDirectory)));
```

## 接口

本页与范例是稳定接口入口；正常项目不逐段阅读 lib/builder.js 猜测调用方式。`importModule.name` 使用 ASCII 标识符（如 `power_3v3`），中文放外框标题。先确定连接计划，再生成脚本；文档引脚表与脚本共享同一份 reference/pin/net 数据，避免末尾重新抄写与核对全部引脚。

### 常见局部电路

新增 LED、上拉按键、并联去耦电容时，读取 [画法索引](drawing-patterns.md) 并复用对应 ESM 范例。它们调用本页已有接口，不是额外的 builder API；位号、真实符号与引脚映射由项目提供。示例生成器只用于维护参考图，正常项目直接在功能模块内调用 place，再统一 connect。

### 信号标签引出与对齐

同侧信号优先批量排列，见 [左右/上下标签参考](drawing-patterns/label-alignment.md)。从 runtime.mjs 或 builder 导入：

```javascript
const {items, warnings} = attachPinLabels(region, {
  reference: 'U1', direction: 'left',
  pins: [{pin:'1',net:'EN'}, {pin:'2',net:'GPIO0'}],
});
```

默认 textPosition="overWire"，名称排在引线上方/沿竖线排列；length=5.08 mm 为最短线长，按整组最长名称保守延长到公共基线；可用 alignAt 指定左右标签列的 x 或上下标签行的 y（与 target 相同坐标系）。left/right 水平，up/down 竖排；名称从外端沿引线向符号方向展开，标签锚点保持在线上。textPosition:"outside" 可恢复线外文字。名称长度不单独改变某根线长。pins 由实际符号侧边分组，不自动识别朝向、既有接线或障碍。minPitch 默认 1.8 mm；warnings 中 LABEL_LEAD_SHORT 提示指定基线太近，LABEL_PITCH_TIGHT 提示局部间距不足，应查看相关预览，不自动拉成全侧阶梯。

单个需要显式转折的信号可用旧接口：

```javascript
attachPinLabel(region, {reference:'U1',pin:'1',net:'MOT_PWM',direction:'left',length:7.62,lane:1});
```

旧接口保留水平文字；lane 是垂直于引出方向的整数通道，pitch 默认 2.54 mm。不自动避障，不对已接电路的引脚重复加线。两种接口都以实际 pin 坐标连接；电源、地、NC 由相应流程处理。

### 执行脚本与读取结果

优先使用技能目录的 `scripts/run-design.mjs`：

```text
node <skill目录>/scripts/run-design.mjs <design.mjs绝对路径> <唯一候选目录> <构建报告.json>
```

启动器用当前 Node、参数数组启动项目脚本，自动提供插件目录，并将退出码、stdout/stderr 保存为 UTF-8 JSON，终端只返回摘要。读取报告中的 stdout 得到 save 返回值；不要用 PowerShell `>` 重定向后猜 UTF-8/UTF-16/BOM，不用复杂 node -e 内联正则、Select-Object 截断诊断或为打印状态重新构建。沿用 get_eda_host_info 已知路径，需要时在进程环境提供 KICAD_SYMBOL_DIR；首次预览传已知 kicadCliPath，避免先运行找不到的裸 kicad-cli 再重试。

`importModule({sourcePath,name,offset,nets})` 把已准备的单页电路整体放入当前 Schematic，返回 references、ports、netNames、objectUuids。具体网络隔离和映射见 [平铺整合](flat-reuse.md)。它与 addSymbol 可以共用同一页；新增实例编号须避开导入返回的编号。多个来源先导入全部模块，再从统一编号表分配新增引用，不让每个模块从 R1/U1 重新计数。

`hierarchicalLabel(name,at,angle=0)` 在实际引脚或明确坐标添加 passive 层次标签，返回 UUID；region.hierarchicalLabel 使用局部坐标。用于从零生成层次子页，标签必须确实位于目标引脚或网络导线上。保存子页后重新调用端口工具，确认能作为 create_kicad_hierarchy 的 sourcePath。

所有坐标单位为毫米；库内符号 Y 轴转换和正交旋转由程序完成。不要自己用图片坐标猜引脚位置。

- `addSymbol({libraryPath,libId,reference,at,value?,angle?,mirror?,unit?,footprint?,referenceAt?,valueAt?})`：库文件必须含实际符号定义。`libId` 为 `库名:符号名`，例如 `Device:R`。默认角度 0、unit 1、无镜像，默认值和封装来自符号库，referenceAt/valueAt 可指定水平文字的绝对位置，省略时放在器件上方；返回对象 UUID。同一引用的不同 unit 要使用相同符号；重复 reference/unit、缓存差异或缺少 unit 会报错。
- `pin(reference,number)`：返回 `[x,y]`；不存在或多 unit 中无法唯一匹配的引脚报错。实例放置后再查询。点数组和 `{reference,pin}` 均可作为下面接口的端点。
- `wire(from,to,via=[])`：返回每段导线 UUID。所有线段必须非零且正交；折点由模型给出。分支相连处显式添加 junction，不自动生成。
- `label(name,at,angle=0)`：写本页局部网络标签，返回 UUID。同名局部标签表示同一页网络；标签要位于预期引脚或导线上，跨功能组可用短导线和标签连接，避免大段交叉线。
- `marker('junction'|'no_connect',at)`：返回 UUID。不连接标记表示设计意图，不补充外围电路。
- `frame({name,description,autoBounds:true,objectUuids?,excludeUuids:[]})` 或 `frame({name,description,start:[x,y],end:[x,y]})`：沿用现有模板，计算范围和写文字；不自动分组或移动内容。
- `render()`：返回 `schematic`、`project` 文本、`resolvedFrames` 和修改统计，不写文件。
- `save(directory)`：写同名 `.kicad_sch` 和 `.kicad_pro`，返回 `schematicPath`、`projectPath`。不覆盖任一现有输出；每轮生成使用唯一候选目录。写入异常可能留下部分输出，以异常和目录实际内容为准。

符号库中的简单 `extends` 会展开父符号图形和派生属性；派生符号自定义图形覆盖不支持。符号文件路径需来自真实安装库或导入工具返回值。重复引脚号在多 unit 中需要选择唯一实例；不能用猜坐标绕过歧义。

生成错误会抛出具体原因；不存在引脚需改引脚标识或放置相应 unit，非正交路径需补折点，缓存差异需统一实际库定义。调试先修生成脚本，再重跑至新的候选目录，然后预览。库不执行电气正确性审计或 ERC。

## 固定工程与候选输出

一个设计只交付一个可打开的 KiCad 工程：

```text
designs/<name>/
├─ scripts/design.mjs
├─ project/<name>.kicad_pro
├─ project/<name>.kicad_sch
├─ previews/
└─ .candidate/<run-id>/
```

调用脚本时传入唯一候选目录的绝对路径。候选目录存在时换一个 run-id，不删除或覆盖来源文件。候选预览通过后，将其中同名 `.kicad_sch` 和 `.kicad_pro` 复制到 `project/`；正式文件已存在时只替换这两个由本设计生成的文件，不清空 `project/`，不改本地符号库和其他工程文件。复制完成后对 `project/<name>.kicad_sch` 生成最终预览，再删除本轮 `.candidate/<run-id>/`。

不要把 `.candidate/`、`history/` 或 `revN/` 中的工程作为交付链接，也不要提示用户在 KiCad 中打开这些目录。默认用 `scripts/design.mjs` 和现有版本控制保存设计历史；用户明确要求独立历史工程时再生成，并说明打开该工程会被 KiCad 集成识别为另一个工作区。

## 先规划外框，再放置电路

先在脚本顶部定义各分区的 origin/size。所有 region 在放置器件之前注册，可即时发现预定框重叠；这个检查只涉及矩形布局，不检查电气连接。region 自动添加一个固定外框、标题和说明，不需要再调用 frame。尺寸由模型根据主要器件和接口估计，采用对齐行列与明确间距，保留标题、说明和跨区通道。库不会自动决定框尺寸、分区、移动内容或检查内容越界；最后一次预览确认。

`sch.region({name,description,origin:[x,y],size:[width,height]})` 返回区域操作对象：addSymbol 的 at/referenceAt/valueAt、wire 的数组端点和 via、label/marker 的数组位置全部使用区域相对坐标。`region.pin(reference,number)` 返回相对坐标；`region.at([x,y])` 转为全局坐标。`sch.pin` 仍返回全局坐标，不要把它的返回值直接传给区域方法。`{reference,pin}` 端点由全局实际实例定位，区域方法无需自行换算。

改变 origin 后重新运行脚本，组内器件、文字、导线和标记跟随原点重建；不是对已生成文件进行现场移动。全部器件先放置，再布线。跨区导线用 sch.wire 与 sch.pin 全局坐标在放置完成后生成，显式规划中间折点，或用短线和同名局部标签连接。空间不足先局部扩大 size 或调整区域内位置，不编写全图几何审计、像素扫描或外框探测脚本；保留手动 frame/autoBounds 供其他布局模式使用。

自动框 sch.frame 的 excludeUuids 可省略，表示不排除对象。符号放置前使用器件工具返回的 builderCompatibility.availableUnits；不靠反复放置或读取构建库源码猜测单元。复用来源并补充脚本电路见 [mixed-design.md](mixed-design.md)。

## 标准电源符号与当前标签查询

共享电源网络在 Schematic 构造选项里声明 `requiredPowerSymbols: powerNets`。导入模块/补充标签后先用 `sch.planPowerPlacements({libraryPath: POWER_LIB, nets: powerNets})` 批量规划，再把返回的 placements 交给 replacePowerLabels。需要修正的少量位置用 `sch.powerLabelCatalog(Object.keys(powerNets))` 按 module、net、at 选取当前标签，覆盖对应 plan.placements；不要硬编码上一轮 UUID 或把所有 angle 固定为 0。保存前转换为标准符号并检查 `sch.checkPowerSymbols()`；render/save 同样自动检查声明的网络。详细示例与错误处理见 [电源符号交付](power-symbols.md)。

`sch.pinCatalog()` 返回当前符号的引用、单元、实际毫米引脚坐标与 pinError，包含旋转、镜像和导入平移。它是符号目录，不包含标签；标签定位用 powerLabelCatalog。布线继续使用 sch.pin，不需要读取实现或自写解析器。

sch.save 返回 schematicPath、projectPath、frames 和 layoutWarnings。一次保存后打印这些结果，不为查坐标重复生成。layoutWarnings / sch.powerLayoutWarnings() 是电源符号与文字、器件、导线外接框交叠的保守提示，排除直接连接的导线接点，可能误报或漏报，不证明电气连接。先调整 valueAt，再按需要移动符号并连接原接点；局部预览确认可读性。

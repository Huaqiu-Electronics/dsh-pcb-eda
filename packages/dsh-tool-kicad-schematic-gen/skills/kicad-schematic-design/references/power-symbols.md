# 电源符号交付

用于将已确认共享电源标签转换为标准符号。只声明实际共享网络，不推断 AGND/GND 等同，不合并隔离域，不自动加 PWR_FLAG。

## 最小调用

初始化与执行方式沿用 [编程接口](programming.md)，不另建演示工程。powerNets 使用精确网络名与符号 ID，POWER_LIB 使用实际 power.kicad_sym 路径：

```js
const powerNets = {GND:'power:GND', '+3V3':'power:+3V3'};
const sch = new Schematic({...projectOptions, requiredPowerSymbols:powerNets});
// 先完成所有模块导入、器件、接线及标签。
const spec = {libraryPath:POWER_LIB, nets:powerNets};
const plan = sch.planPowerPlacements(spec);
// 如有具体遮挡，在转换前按下节修正 plan.placements。
sch.replacePowerLabels({...spec, placements:plan.placements});
sch.checkPowerSymbols();
console.log(JSON.stringify({...sch.save(process.argv[2]), powerPlan:plan.diagnostics}));
```

## 规划与返回

`planPowerPlacements({libraryPath,nets,clearanceMm?,maxMoveMm?})` 不修改图纸，返回 placements、diagnostics。默认 clearanceMm=0.6、maxMoveMm=5.08；保持符号原生角度0，冲突时有限尝试90/270/180度、水平文字位置及2.54 mm倍数的短直引线。maxMoveMm=0只规划方向和文字，不绕复杂路径；候选拒绝穿越其它导线、引脚或对象边界。

自动诊断 stage:automatic，包含 plannedCount/rotatedCount/movedCount/candidateCount、unresolved（UUID、网络、坐标、冲突对象）及 unmeasuredObjectUuids。拥挤时仍返回较少冲突方案，不能据此宣称无重叠。规划自动采用已注册 region/frame 的实际外框，预留顶部标题和底部说明带；未归属任何框的标签只受页面约束。符号和文字不能跨出所属内容区，新增短引线不能越出所属框。POWER_PLACEMENT_UNAVAILABLE 会一次列出无法安放的网络和区域，集中扩大区域或调整接点后重试，不逐个试坐标。外框应在规划前注册。

## 精确调整当前标签

`powerLabelCatalog(nets)` 返回所选局部/全局标签的 `{uuid,net,at,angle,type,module?}` 副本；at 是整页坐标，module 为导入名，新建标签没有 module。它不列层次端口。跨次构建 UUID 会变化，按模块、网络、坐标定位当前对象：

```js
const labels = sch.powerLabelCatalog(Object.keys(powerNets));
const targets = labels.filter(x => x.module==='core' && x.net==='GND'
  && Math.abs(x.at[0]-plannedAnchor[0])<0.001
  && Math.abs(x.at[1]-plannedAnchor[1])<0.001);
if (targets.length!==1) throw new Error('Expected one current core GND label');
plan.placements[targets[0].uuid] = {at:targets[0].at, valueAt:plannedTextAt};
```

plannedAnchor/plannedTextAt 来自当前布局计划。先改 valueAt；确需移动再用 `{at:plannedSymbolAt,via:plannedBends,angle,valueAt}`，库从原接点补正交线。多个匹配不得任选第一个；确定全部位置后转换一次。转换后 catalog 不再含原标签，要调整则改脚本重建，用新 plan，不重复转换旧对象。

## 最终诊断

手工改 placements 不会更新早先 plan.diagnostics。转换后用 sch.powerLayoutDiagnostics()，或直接读 save().powerLayout（stage:final、checkedCount、issues、unmeasuredObjectUuids），以实际符号、水平文字及生成的外框重新检查。issues 包含 POWER_LAYOUT_OVERLAP、POWER_LAYOUT_OUTSIDE_FRAME、POWER_LAYOUT_OUTSIDE_PAGE；即使手工将符号移出原框也保留原归属。layoutWarnings 保留旧的重叠提示接口。自动诊断不能冒充最终结果；最终诊断仍是保守几何提示，不是电气检查。

## 检查与恢复

| 条件 | 处理 |
| --- | --- |
| checkPowerSymbols | 每个声明网络至少一个精确对应电源符号，无残留局部/全局标签；返回 symbolCount/remainingLabelUuids。核对实际缓存 power 定义、libId 和 Value，不只看 #PWR 编号。 |
| POWER_SYMBOLS_REQUIRED | render/save 写入前同样检查；补缺失符号、漏转换或转换后新加标签。未声明网络不会被此检查覆盖，新设计必须显式声明。 |
| POWER_LABEL_INVALID | 查本次 catalog 和 placements，勿复制旧 UUID、取消转换或改回电源标签。 |
| 图形/文字遮挡 | 调整 valueAt 或 at/angle/via 后看受影响区域；不能撤掉 requiredPowerSymbols 绕过。无法解决则报告具体位置。 |

layoutWarnings/powerLayoutWarnings() 和规划诊断采用保守边界，可误报或漏报。按 [布局交付](layout-delivery.md) 判断实际可读性，已确认无影响的警告可保留，不追求清零。检查不证明供电拓扑、连通性或全部遮挡正确，不代表 ERC 通过。

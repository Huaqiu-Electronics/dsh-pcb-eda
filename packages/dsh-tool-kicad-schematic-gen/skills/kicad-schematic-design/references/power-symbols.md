# 共享电源符号

主 agent或单框脚本需要手动控制转换时读取；模块运行时已代管转换，子 agent只在内部实际接点添加电源标签。只处理确认共享的网络，不合并隔离地、不自动添加PWR_FLAG。

同一功能组内相邻且同网的引脚先用短线汇接，在母线端或明确的接点标一次。例：USB-C 的 CC1、CC2 下拉电阻各自保留信号网，只有两只电阻的接地端汇到同一个 GND 落点。已有对外端口标签时，优先让其接入同一母线。相距较远或汇线会穿过其他功能组时，各支路保留自己的符号。

模块运行时在摆放电源符号前，根据实际导线和接点去重。同一模块同一连通组只保留一个同名标注。入口、稳压输出和主供电/地母线用符号，同页远端和次要支路用同名本地网标，显示为无边框黑字。默认每模块每网选一个代表符号，优先公共端口；其余独立接点保留本地网标。用 `draw.label(net, at, angle, {powerStyle:'symbol'})` 或 `{powerStyle:'label'}` 指定表现方式，`draw.stub` 选项和返回的公共电源端口也支持同名字段。跨层次页连接继续使用明确的跨页机制。

## 最小接口

```js
const powerNets={GND:'power:GND','+3V3':'power:+3V3'};
// 初始化 Schematic 时声明 requiredPowerSymbols:powerNets。
// 先完成器件与接线。关键锚点用 sch.label()，次要支路也用 sch.label() 并保存返回的 UUID。
const keepAsLocalLabels=new Set([sch.label('GND',remoteGroundAnchor,0)]);
const spec={libraryPath:symbolLibrary('power'),nets:powerNets,keepAsLocalLabels};
const plan=sch.planPowerPlacements(spec);
sch.replacePowerLabels({...spec,placements:plan.placements});
sch.checkPowerSymbols();
console.log(JSON.stringify(sch.save(process.argv[2])));
```

symbolLibrary从runtimePath导入；随包库含GND/+3V3/+5V，无需联网或搜本机目录。特殊符号使用核实的库，不能换网名凑符号。正式project/libraries/symbols/power.kicad_sym保留实际库字节，sym-lib-table以power和${KIPRJMOD}注册；已有不同库先核对，不覆盖其他条目。电源绘图符号不需实体封装。

## 规划和精确调整

planPowerPlacements({libraryPath,nets,clearanceMm?,maxMoveMm?})返回placements、diagnostics，不改图。默认间距0.6mm、引线总长上限7.62mm，优先原生角度0和短直线，必要时尝试一处直角折线或旋转符号，文字保持水平。maxMoveMm:0仍可规划方向和文字。

规划利用已注册region/frame的真实边界，预留标题/说明；新增短线和符号不得越框或穿越其它引脚/导线。POWER_PLACEMENT_UNAVAILABLE时按全部接点集中扩框或改通道，不逐个微调，不删除符号要求。

已有线和新增引线都只允许在电气接点接触电源符号。若导线继续穿过符号笔画，自动放置会尝试其他朝向或落点。最终报告中的 `POWER_SYMBOL_WIRE_CROSSING` 提供位号、网络和线段端点。按局部图调整落点或接入方向，保留同一网络。

需要定点调整时，powerLabelCatalog(nets)返回当前标签的uuid/net/at/angle/type及可选module，at为全局坐标，不含层次端口。每轮UUID会变，按模块、网络和实际坐标唯一定位：

```js
const targets=sch.powerLabelCatalog(['GND']).filter(x=>x.module==='core'
 && Math.abs(x.at[0]-anchor[0])<0.001 && Math.abs(x.at[1]-anchor[1])<0.001);
if(targets.length!==1)throw new Error('Expected one current GND label');
plan.placements[targets[0].uuid]={at:targets[0].at,valueAt:textAt};
```

anchor/textAt由当前布局确定；先调整文字valueAt，确需移动再提供at/angle/via，库从原接点补正交线。多个匹配不任选第一个，转换只执行一次；后续改脚本重建，不重复转换旧对象。

## 最终检查

- checkPowerSymbols 检查声明网络有准确的符号或显式保留的同名网标。单页合图后核对本地网标与电源符号的实际网表成员。
- plan.diagnostics是automatic阶段，手改placements不会更新它；最终读save().powerLayout或powerLayoutDiagnostics()的final结果，关注overlap、outside_frame/page和未测对象。
- 默认字段调整保留显式位置；零未决不代表文字可读。诊断采用保守边界，须按 [布局交付](layout-delivery.md) 看实际图，误报说明位置，不追求清零。

POWER_SYMBOLS_REQUIRED先补漏标签/转换；POWER_LABEL_INVALID用本轮catalog，不复制旧UUID。具体错误查 [恢复参考](troubleshooting.md)。检查不认证供电拓扑或完整电气正确。

# 共享电源符号

主 agent或单框脚本需要手动控制转换时读取；模块运行时已代管转换，子 agent只在内部实际接点添加电源标签。只处理确认共享的网络，不合并隔离地、不自动添加PWR_FLAG。

## 最小接口

```js
const powerNets={GND:'power:GND','+3V3':'power:+3V3'};
const spec={libraryPath:symbolLibrary('power'),nets:powerNets};
// 初始化Schematic时声明requiredPowerSymbols:powerNets；先完成所有器件与接线。
const plan=sch.planPowerPlacements(spec);
sch.replacePowerLabels({...spec,placements:plan.placements});
sch.checkPowerSymbols();
console.log(JSON.stringify(sch.save(process.argv[2])));
```

symbolLibrary从runtimePath导入；随包库含GND/+3V3/+5V，无需联网或搜本机目录。特殊符号使用核实的库，不能换网名凑符号。正式project/libraries/symbols/power.kicad_sym保留实际库字节，sym-lib-table以power和${KIPRJMOD}注册；已有不同库先核对，不覆盖其他条目。电源绘图符号不需实体封装。

## 规划和精确调整

planPowerPlacements({libraryPath,nets,clearanceMm?,maxMoveMm?})返回placements、diagnostics，不改图。默认间距0.6mm、最大移动5.08mm，优先原生角度0和短引线；必要时有限旋转且保持文字水平。maxMoveMm:0仍可规划方向/文字，不绕复杂路径。

规划利用已注册region/frame的真实边界，预留标题/说明；新增短线和符号不得越框或穿越其它引脚/导线。POWER_PLACEMENT_UNAVAILABLE时按全部接点集中扩框或改通道，不逐个微调，不删除符号要求。

需要定点调整时，powerLabelCatalog(nets)返回当前标签的uuid/net/at/angle/type及可选module，at为全局坐标，不含层次端口。每轮UUID会变，按模块、网络和实际坐标唯一定位：

```js
const targets=sch.powerLabelCatalog(['GND']).filter(x=>x.module==='core'
 && Math.abs(x.at[0]-anchor[0])<0.001 && Math.abs(x.at[1]-anchor[1])<0.001);
if(targets.length!==1)throw new Error('Expected one current GND label');
plan.placements[targets[0].uuid]={at:targets[0].at,valueAt:textAt};
```

anchor/textAt由当前布局确定；先调整文字valueAt，确需移动再提供at/angle/via，库从原接点补正交线。多个匹配不任选第一个，转换只执行一次；后续改脚本重建，不重复转换旧对象。

## 最终检查

- checkPowerSymbols确认声明网络有精确符号、无未转换标签；不能只看#PWR编号。未声明的网络不在保证范围内。
- plan.diagnostics是automatic阶段，手改placements不会更新它；最终读save().powerLayout或powerLayoutDiagnostics()的final结果，关注overlap、outside_frame/page和未测对象。
- 默认字段调整保留显式位置；零未决不代表文字可读。诊断采用保守边界，须按 [布局交付](layout-delivery.md) 看实际图，误报说明位置，不追求清零。

POWER_SYMBOLS_REQUIRED先补漏标签/转换；POWER_LABEL_INVALID用本轮catalog，不复制旧UUID。具体错误查 [恢复参考](troubleshooting.md)。检查不认证供电拓扑或完整电气正确。

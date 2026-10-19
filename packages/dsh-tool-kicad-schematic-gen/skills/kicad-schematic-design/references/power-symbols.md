# 电源符号交付

随机 UUID 是对象身份，不是布局选择条件。跨次构建按网络、整页毫米坐标和导入模块名定位；在一次构建中使用 catalog 返回的 UUID 调整当前对象，不固定 UUID，也不读取构建库源码。

## 完整流程

下面是小型电路的接口示例，实际设计按真实器件、连线及可用空间规划位置。复用模块也使用同一流程：importModule 和新增标签全部完成后查询 catalog，再转换、保存。

```js
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const pluginDir = process.env.DSH_SCHEMATIC_PLUGIN_DIR;
if (!pluginDir) throw new Error('Set DSH_SCHEMATIC_PLUGIN_DIR using the current skill installation path.');
const { Schematic, templateDir, symbolLibrary } = await import(pathToFileURL(join(pluginDir,
  'skills/kicad-schematic-design/assets/runtime.mjs')).href);
const powerNets = { GND: 'power:GND', '+3V3': 'power:+3V3' };
const sch = new Schematic({
  projectName: 'power_demo', title: 'Power symbols', paper: 'A4',
  templateDir,
  requiredPowerSymbols: powerNets,
});
sch.addSymbol({
  libraryPath: symbolLibrary('Device'),
  libId: 'Device:R', reference: 'R1', value: '10k', at: [50, 50],
});
const topPin = sch.pin('R1', '1');
const bottomPin = sch.pin('R1', '2');
const supply = [topPin[0], topPin[1] - 5.08];
const ground = [bottomPin[0], bottomPin[1] + 5.08];
sch.wire(topPin, supply);
sch.wire(bottomPin, ground);
sch.label('+3V3', supply);
sch.label('GND', ground);
const spec = {
  libraryPath: symbolLibrary('power'),
  nets: powerNets,
};
const plan = sch.planPowerPlacements(spec);
console.log(plan.diagnostics); // 只对 unresolved 的位置安排局部检查
sch.replacePowerLabels({ ...spec, placements: plan.placements });
console.log(sch.checkPowerSymbols());
console.log(sch.save(process.argv[2]));
```

## 有限位置规划

`sch.planPowerPlacements({libraryPath, nets, clearanceMm?, maxMoveMm?})` 在当前构建里批量返回 `{placements, diagnostics}`，不修改图纸。它使用实际符号图形旋转后的边界及水平文字尺寸，默认保持符号原生角度 0（标准 GND 朝下、常见正电源朝上），存在遮挡时尝试 90、270、180 度和文字的四个方向。没有必要时不为方向多样而旋转。

默认 clearanceMm=0.6，maxMoveMm=5.08。移动仅尝试 2.54mm 的有限倍数、四个方向的短直线，不自动绕复杂路径；会拒绝穿过其他导线、引脚或对象边界的候选，不把整张图交给模型逐个重定位。可设置 maxMoveMm=0，仅规划旋转与文字。需要特殊接法时按真实连接计划覆盖具体 placements。

diagnostics 返回 plannedCount、rotatedCount、movedCount、candidateCount、unresolved（当前 UUID、网络、坐标、冲突对象 UUID）和 unmeasuredObjectUuids。拥挤时仍返回较少冲突方案并明确列出 unresolved，不声称完全无重叠。有未测量对象时也不能据此宣称布局全部检查通过。有限评分和保守边界不能替代 KiCad 电气检查或最终预览。

集中检查诊断对应区域，一次修改相关 placements 后再生成；不要统一覆写所有 angle=0、不要反复渲染整页，也不要为缩短文字任意重命名网络。模型初次按自动方案生成一次，再根据明确剩余问题修正，保留原电源交付要求。

## 复用模块中的精确选择

`powerLabelCatalog(nets)` 只列指定网络的局部/全局标签，返回 `{uuid, net, at, angle, type, module?}`。at 是导入平移后的整页坐标；module 是 importModule 的 name，脚本新建标签没有 module。返回值是副本，修改它不改变图纸。不会列普通未选信号或层次端口，不推断 AGND 和 GND 等同。

若 plan.diagnostics.unresolved 或局部预览指出仍有遮挡，在转换前获取 `const labels = sch.powerLabelCatalog(Object.keys(powerNets))`，按当前网络、模块和坐标调整 plan.placements。假设需要调整 core 模块中的一个 GND 标签，用当前图纸的实际坐标而不是旧 UUID：

```js
const target = labels.filter(label => label.module === 'core'
  && label.net === 'GND'
  && Math.abs(label.at[0] - plannedAnchor[0]) < 0.001
  && Math.abs(label.at[1] - plannedAnchor[1]) < 0.001);
if (target.length !== 1) throw new Error('Expected exactly one planned core GND label');
plan.placements[target[0].uuid] = {
  at: target[0].at,
  valueAt: plannedTextAt,
};
```

plannedAnchor 和 plannedTextAt 来自当前设计的布局计划。网络可能有多个标签，不能直接 find 第一个而忽略歧义；模块名可以区分重叠位置的复用块。先调整 valueAt，若仍需移动符号，使用 `{at: plannedSymbolAt, via: plannedBends, angle, valueAt}`；库从旧接点补正交导线。只在全部位置确定后调用一次转换，转换后的 catalog 不再含这些标签；如果已转换，修改脚本并重建，用新一轮 plan 的 UUID，不二次转换旧对象。

## 交付检查与错误处理

- requiredPowerSymbols 只声明本设计实际共享的网络及精确符号 ID，不将隔离地、电源域或未使用的电源添加进去。
- checkPowerSymbols 返回每个声明网络的 symbolCount、remainingLabelUuids。至少一个对应电源符号且没有残留局部/全局标签才通过。它检查实际缓存中的 power 定义、实例 libId 和 Value，不只统计 #PWR 引用。
- render/save 自动执行同一检查，缺符号、漏转换或之后又加回标签时抛出 POWER_SYMBOLS_REQUIRED，失败发生在写文件之前。未声明 requiredPowerSymbols 的历史脚本保留旧行为，因此新设计必须显式声明。
- POWER_LABEL_INVALID 若提示 placement 未选中标签，重新查询本次 catalog；不要从候选文件或上一轮日志复制 UUID，不绕过校验、不取消转换。
- 文字重叠时改 valueAt；符号图形遮挡时调整 at/angle/via，然后重新构建并预览。不撤掉交付要求、不将全部电源换回标签。无法满足时报告具体未解决的位置。
- 这些检查不核对供电拓扑、电气连通性或全部图形遮挡。layoutWarnings 是提示，局部预览仍需确认；不自动加 PWR_FLAG 或运行 ERC。

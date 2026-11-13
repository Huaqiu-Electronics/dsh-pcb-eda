# 可选参数模板

仅明确选用模板时读本页；自由draw脚本无需读取。由moduleTemplatesPath或moduleCircuitPath的file URL导入，沿用已确认的实际器件、脚号和参数，模板不选型或证明电气正确。

## 排针

```js
import {placeHeader} from '<moduleTemplatesPath 的 file URL>';
export function place(args){
 return placeHeader(args,{
  partKey:'header',role:'header',at:[40.64,35.56],confirmed:true,
  pinNets:{'1':'+3V3','2':'GND','3':'SDA','4':'SCL'},
  ports:{sda:'3',scl:'4'},
 });
}
```

每脚网络必须按方案填写，ports 的键与清单一致，值为实际脚号。只支持原生朝向下两侧水平引脚的符号；从 region.pin 自动获得实际落点，向外延伸标签，不重复绘制公共端口标签。遗漏 pinNets 的引脚不会自动连接，因此 expectedConnections 必须覆盖所有应接引脚。多单元符号和上下出脚使用自由绘制。

## 上拉 RC

```js
import {placePullupRc} from '<moduleTemplatesPath 的 file URL>';
export function place(args){
 return placePullupRc(args,{
  resistorKey:'r10k',capacitorKey:'c100n',
  resistorRole:'pullup',capacitorRole:'filter',
  supply:args.nets.supply,ground:args.nets.ground,
  signalPort:'signal',confirmed:true,
 });
}
```

只实现电阻上拉、电容对地；不含按钮、不推断 RC 值、不替代器件复位时序要求。parts 必须映射 pins.top/bottom 且实际引脚垂直、top 在 bottom 上方，电容在电阻下方偏右；不符合条件报 MODULE_TEMPLATE_INVALID，改用适合实际器件的自由绘制。signal 端口绑定上拉电阻下端，并生成清晰的公共标签引线。模板版本纳入模块输入哈希，升级后需重新检查。

## 组合电路描述

适合已确认拓扑的排针、上拉 RC、固定输出 LDO 和电源 LED 支路。子 agent 提供器件角色、引脚映射和网络，不逐个编写放置与连线。模板不判断器件适用性、电容稳定性、额定值或电源预算；这些必须已在方案中确认。

项目模块入口只需导入当前安装的 moduleCircuitPath（file URL），调用：

```js
import {placeModuleCircuit} from '<moduleCircuitPath 的 file URL>';
export function place(args){
 return placeModuleCircuit(args,{
  version:1,
  blocks:[{
   kind:'ldo-fixed',confirmed:true,
   regulator:{partKey:'ldo',role:'regulator',pins:{vin:'1',gnd:'2',enable:'3',nc:'4',vout:'5'}},
   inputCap:{partKey:'c1u',role:'inputCap',pins:{top:'1',bottom:'2'}},
   outputCap:{partKey:'c1u',role:'outputCap',pins:{top:'1',bottom:'2'}},
   supply:args.nets.input,output:args.nets.output,ground:args.nets.ground,
   enable:'input',ports:{vin:'input',vout:'output'},
  },{
   kind:'led-indicator',confirmed:true,
   resistor:{partKey:'r1k',role:'indicatorResistor',pins:{top:'1',bottom:'2'}},
   led:{partKey:'led',role:'indicator',pins:{anode:'2',cathode:'1'}},
   supply:args.nets.output,ground:args.nets.ground,seriesNet:'power__indicator',
  }],
 });
}
```

上例引脚号仅展示格式，必须替换为实际确认的映射。所有角色和端口名须与模块清单一致，全部应放器件须在描述中出现。私有网络前缀应替换为实际模块 id。若存在额外 VOUT 引脚（例如散热片），在 regulator.pins 映射其语义名，并通过 additionalOutputs:['tab'] 明确连接；不要遗漏重复引脚。enable 仅支持已确认接输入电源的常开接法，其他使能拓扑自由绘制。未使用的 nc 仅放不连接标记，不能把有功能的脚改成 nc。实际原生朝向不合适时，可在对应器件描述中指定 angle；电容、电阻及 LED 需要支持模板要求的垂直引脚次序，错误时明确拒绝，不自动猜极性。

header、pullup-rc 使用上文相同字段，外加 kind。公共端口标签由运行时统一添加，模板只返回引线末端；内部支路通过明确的同名网络标签连接，不能依赖肉眼接近。预期网表应覆盖重复电源脚、使能、地、LED 极性和电容连接。

组合入口按固定槽位竖向组织功能支路，先检查框容量，放不下返回 MODULE_CIRCUIT_INVALID 请求主 agent 扩框或拆模块。不会缩小符号、改框或自动避障；超大符号、复杂多单元器件、USB-C 和完整 MCU 尚未提供此处的专用模板，沿用现有画法自由绘制。LED 支路不包含对外端口；需要导出时使用自定义模块。模板几何、布局诊断和读图仍需核对。

## 检查与提交

沿用task.md的review_kicad_module_candidate入口；它不是发布工具。先修真实连接错误，再读图集中修可读性缺陷。提交固定候选、报告、已读图片与未决项后结束；共享接口或空间不足报告主agent，不修改清单。

# 平铺复用与新增电路

适用于导入单页电路、组合多个来源或补充新器件；默认多框仍按 [并行生成](parallel-generation.md) 分工。来源存sources/并保留原样，实际适配落实到生成脚本和工作副本。

## 导入和接点

```js
const core=sch.importModule({sourcePath:checkedSource,name:'core',offset:[25.4,25.4],
 nets:{VCC:'VCC_3V3',GND:'GND'}});
sch.frame({name:'核心电路',description:'已确认用途与限制',
 autoBounds:true,objectUuids:core.objectUuids});
// 真实脚号经方案核实；此处仅演示导入后如何取点。
const p=sch.pin(core.references.U1,'1');
```

name为唯一ASCII标识；offset是全局毫米平移，不能缩放电路。nets只映射确认共享的源网络；未映射名称自动加模块前缀，局部/全局/层次标签和隐藏电源网络均隔离，层次标签转同页局部标签。不要默认合并同名地或电源。

返回references（源→目标位号）、ports（标签→平移后锚点数组）、netNames（最终网名）、objectUuids。明确选择正确锚点；无标签的连接器通过references和实际pin定位，重复端口不任选第一个。所有导入位号先加入共享reserved集合，再分配新增器件位号。

导入处理UUID、实例路径、缓存及编号，整体平移符号、导线、文字、图形和图片，不判断电气兼容或自动布线。仅支持单页；多层级来源须明确准备单页，不能删除sheet或静默改层次。错误网络映射、缓存/编号/unit冲突、未展开继承和不支持对象须修来源副本或换合适来源，不能丢弃未知电气对象。

## 补充电路

只补方案中来源未覆盖的功能，先核对已有上拉、保护、复位、DNP和实际装配，避免重复添加。新增区使用region局部坐标；跨区连接用导入的netNames、明确ports或真实pin。外部原图需要复杂修改时，按 [脚本修改](editing.md) 定向适配或重建，不能依赖旧对象编辑工具或全局文本替换。

需要顺序混合示例时才看 [入口](../assets/mixed-design/design.mjs) 与 [新增模块](../assets/mixed-design/modules/load.mjs)；示例使用独立layout.mjs，仅适用于明确允许的顺序构建。真实并行布局只以清单region为准。配置的source、端口、实际器件和区域须替换，并按实际原因传--sequential-reason；不为套示例改变器件或接法。

## 外框与说明

新绘用region预留空间，不额外套frame；已有内容用frame({autoBounds:true,objectUuids})，excludeUuids仅在确需排除时提供。自动框只估计范围，不移动电路；长型号、文字和图片需在预览中核对，boundsError时用明确手动范围。

按完整功能分区，外围靠所属芯片，不为每只LED/按键拆框。使用统一无填充框、顶部短标题和必要的底部说明，保留真实接法、额定限制及未决条件；聊天说明不能代替图纸。框线避开器件、文字和接点，不强求所有框等高。样式由 [frame-style.json](../templates/frame-style.json) 统一控制。

生成脚本中的冗余介绍、旧框和无用图片在对应脚本里清理；外部来源保留副本和必要标注，不删除电气标签、器件属性或限制来凑外框。API见 [编程接口](programming.md)，完成后按 [布局交付](layout-delivery.md) 验收。来源封装映射见 [封装本地化](module-footprints.md)。

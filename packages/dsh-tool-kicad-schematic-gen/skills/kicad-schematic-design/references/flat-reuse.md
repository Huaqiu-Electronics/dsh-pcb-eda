# 单模块复用与多模块平铺整合

单页候选已符合需求时，用 edit_kicad_flat_schematic 的 create 创建副本和外框，省略无用编辑项。修改副本前 list 选定对象，保留 sources/。调用方法见 [editing.md](editing.md)。新增或移动符号不由该编辑工具完成；构建库可导入修改后的单页，并添加所需符号。

多个下载模块、修改副本和从零脚本模块共用一个 Schematic。调用 `sch.importModule({sourcePath,name,offset,nets})` 导入已准备的单页电路：name 为唯一 ASCII 标识，offset 为全局毫米平移量，nets 将源标签/电源网络名映射到明确共享网络。未映射命名网络自动加模块前缀，避免同页误连；不要把所有同名 GND 或电源默认合并，只有规划共享的网络才映射。

```js
const power = sch.importModule({
  sourcePath: sourcePowerPath, name: 'power', offset: [20, 30],
  nets: { '+3V3': 'VCC_3V3', GND: 'GND' },
});
const control = sch.importModule({
  sourcePath: sourceControlPath, name: 'control', offset: [150, 30],
  nets: { VCC: 'VCC_3V3', GND: 'GND' },
});
sch.frame({ name: '电源', description: '已确认的用途与供电条件',
  autoBounds: true, objectUuids: power.objectUuids, excludeUuids: [] });
sch.frame({ name: '控制', description: '控制接口说明',
  autoBounds: true, objectUuids: control.objectUuids, excludeUuids: [] });
```

返回 references（源编号到目标编号）、ports（源标签到平移后锚点数组）、netNames（源网络到最终网络）、objectUuids（导入顶层对象 UUID）。端口重复时保留所有锚点；明确使用正确接点。新增导线可用 `sch.pin(power.references.U1,'1')` 定位，真实引脚号须已核实。没有标签的连接器接口用 references 与实际引脚定位，不编造端口。

导入统一编号、实例路径和 UUID，各模块缓存隔离。原图的符号、导线、文字属性、图形和图片整体平移；原图不变。局部/全局标签、层次标签和电源网络默认隔离，层次标签转为同页局部标签，隐藏电源引脚名称同时隔离。源网络映射拼写错误、缺失缓存、重复编号/unit、继承未展开或不支持的对象会抛出具体错误，修正副本或选择可支持来源后再试。

当前导入接受单页电路，不能自动展开多层级来源；总线、组对象、嵌入附件等不支持的对象失败而不丢弃。用户要求平铺时准备各单页或从零实现缺少部分，不能静默改成层次或删除 sheet 块。导入只做平移和整合，不自动缩放、放置或布线，不决定电气连接。

来源冗余 text/text_box、旧框和图片用明确 UUID 在副本中先删除。保留必要限制与说明，再用统一短标题和说明重建框；电气标签和器件属性不当作说明删除。布局见 [module-layout.md](module-layout.md)。自动框按保留内容估计范围，程序不会自动移动电路或避免两个模块内容重叠，最终预览必须检查。脚本和固定输出规则见 [programming.md](programming.md)。

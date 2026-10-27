# 复用单页模块并新增脚本电路

适用于已有核心模块、另需补充供电或接口的平铺工程。使用 [主入口](../assets/mixed-design/design.mjs) 和 [独立负载模块](../assets/mixed-design/modules/load.mjs) 作为结构参考；示例只展示连接方式，不代表具体产品的推荐电路。器件数据使用线上搜索、模型摘要和导入结果，不沿用示例器件作为选型依据。

先从项目方案读取已检查的模块记录与适配决定，落实实际源接点到系统网络的映射。只为模块未覆盖的功能新增电路；已有上拉、保护、复位等按实际接法和 DNP 决定保留或修改。初步方案中的候选器件不强行覆盖来源模块；修改时同步文档。生成后利用 references/netNames 回填最终编号与网络，不单独重新规划文档引脚表。

按 [执行约定](programming.md#执行脚本与读取结果) 读回方案后，通过启动器执行；输出目录在前，配置路径作为额外参数在后：

```text
node <runnerPath> <design.mjs绝对路径> <唯一候选目录> <报告.json> --plan <方案绝对路径> --plan-sha256 <读回的sha256> <配置.json绝对路径>
```

布局位置和电源显式覆盖集中在示例 layout.mjs；loadPlacement 的坐标相对新增区，configurePowerPlacements 用本轮 catalog 修改 plan。新增区 origin/size 仍来自配置中的 loadRegion。复制示例时保留 assets 相对结构，runnerPath、KICAD_SYMBOL_DIR 使用技能返回路径。以下路径、网络、引脚及布局须换成真实检查结果；powerSymbols.libraryPath 可通过 symbolLibrary('power') 获取，resistor.footprint 使用成套导入返回值。

```json
{
  "projectName": "mixed_demo", "title": "Mixed circuit", "paper": "A4",
  "source": { "sourcePath": "<实际项目绝对路径>/designs/demo/work/core.kicad_sch", "footprintMappingPath": "<实际项目绝对路径>/designs/demo/project/libraries/mappings/core.json", "name": "core", "offset": [0, 0], "nets": { "OUT": "SIGNAL", "GND": "GND" } },
  "sourceTitle": "核心模块", "sourceDescription": "已检查的核心电路；适用条件简述",
  "signalPort": "OUT", "groundNet": "GND",
  "powerSymbols": { "libraryPath": "<实际符号库目录>/power.kicad_sym", "nets": { "GND": "power:GND" } },
  "loadRegion": { "name": "新增负载", "description": "用途及参数", "origin": [160, 30], "size": [70, 80] },
  "resistor": { "libraryPath": "<实际项目绝对路径>/designs/demo/project/libraries/symbols/selected.kicad_sym", "libId": "Selected:ExactSymbol", "footprint": "Selected:ExactFootprint", "unit": 1, "value": "10k", "pins": { "signal": "1", "ground": "2" } }
}
```

先用结构化编辑清理 source 副本的冗余文字和旧框，保留实际电路，再规划平移量和新增区域；不能靠框尺寸缩放已有电路。导入返回的目标编号加入共享 reserved 集合，之后所有新增模块共用分配器。跨区标签使用 imported.netNames 的实际名称；需直接导线时，使用 imported.ports 的明确锚点或 sch.pin(imported.references[源编号], 实际引脚号)。重复端口不自动任选一个。

原理图统一保存一次，不输出独立新增模块或 smoke 工程。先处理外框范围与重叠，再按 [布局检查顺序](layout-delivery.md) 预览：首版整图、必要局部；修复版看新增区、相邻受影响区及整页范围。sch.frame 的 excludeUuids 省略时为空，确需排除才指定。

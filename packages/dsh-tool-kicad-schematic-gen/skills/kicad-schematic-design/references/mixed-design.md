# 复用单页模块并新增脚本电路

适用于已有核心模块、另需补充供电或接口的平铺工程。使用 [主入口](../assets/mixed-design/design.mjs) 和 [独立负载模块](../assets/mixed-design/modules/load.mjs) 作为结构参考；示例只展示连接方式，不代表具体产品的推荐电路。器件数据使用线上搜索、模型摘要和导入结果，不沿用示例器件作为选型依据。

先从项目方案读取已检查的模块记录与适配决定，落实实际源接点到系统网络的映射。只为模块未覆盖的功能新增电路；已有上拉、保护、复位等按实际接法和 DNP 决定保留或修改。初步方案中的候选器件不强行覆盖来源模块；修改时同步文档。生成后利用 references/netNames 回填最终编号与网络，不单独重新规划文档引脚表。

执行 `node design.mjs <绝对配置路径> <绝对候选目录>`。复制示例到项目时保留 assets 的相对目录结构，并按 skill 的当前安装路径设置 DSH_SCHEMATIC_PLUGIN_DIR、KICAD_SYMBOL_DIR。配置中的占位路径必须替换为本机真实绝对路径；powerSymbols.libraryPath 可通过 symbolLibrary('power') 获取。配置如下；sourcePath、signalPort、网络映射、布局和引脚号必须换成已检查的模块及器件信息。

```json
{
  "projectName": "mixed_demo", "title": "Mixed circuit", "paper": "A4",
  "source": { "sourcePath": "<实际项目绝对路径>/designs/demo/work/core.kicad_sch", "name": "core", "offset": [0, 0], "nets": { "OUT": "SIGNAL", "GND": "GND" } },
  "sourceTitle": "核心模块", "sourceDescription": "已检查的核心电路；适用条件简述",
  "signalPort": "OUT", "groundNet": "GND",
  "powerSymbols": { "libraryPath": "<实际符号库目录>/power.kicad_sym", "nets": { "GND": "power:GND" } },
  "loadRegion": { "name": "新增负载", "description": "用途及参数", "origin": [160, 30], "size": [70, 80] },
  "resistor": { "libraryPath": "<实际项目绝对路径>/designs/demo/project/selected.kicad_sym", "libId": "Selected:ExactSymbol", "unit": 1, "value": "10k", "pins": { "signal": "1", "ground": "2" } }
}
```

先用结构化编辑清理 source 副本的冗余文字和旧框，保留实际电路，再规划平移量和新增区域；不能靠框尺寸缩放已有电路。导入返回的目标编号加入共享 reserved 集合，之后所有新增模块共用分配器。跨区标签使用 imported.netNames 的实际名称；需直接导线时，使用 imported.ports 的明确锚点或 sch.pin(imported.references[源编号], 实际引脚号)。重复端口不自动任选一个。

原理图只统一保存一次，不单独输出新增模块工程，也不默认创建独立 smoke 测试。先收集全部外框坐标并处理页面范围、重叠，再预览。渲染会按带标题的矩形外框返回 regionImages；读取新增区和相邻来源区，集中修复一次实际遮挡或连接问题，再看全图。sch.frame 的自动范围不写 excludeUuids 时按空列表处理；需要排除对象才传入明确 UUID。

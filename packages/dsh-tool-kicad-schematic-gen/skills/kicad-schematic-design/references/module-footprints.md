# 复用模块的封装本地化

原理图的嵌入符号可显示，不代表其 `Footprint` 能用于 PCB。模块选定后立即准备封装，与布局编写交错进行，不等布局完成才开始。对精确 MPN 去重搜索，保存候选 manufacturer.id/mpn；同一型号的多个引用合成一个 assignment。布局微调复用映射，不重复搜索和下载。

1. 对实际采用的 sources/work 原理图调用 `localize_kicad_module_footprints({action:"list",schematicPath:模块路径})`，查看实例的 reference、value、libId、footprintId、pinNumbers、dnp。工具与 importModule 共用供应商缓存 ID 对齐逻辑；仅缓存别名差异不需自行重写原理图或解析器。DNP 需结合实际用途确认，不能假设模块中上拉或旁路一定已装配。电源符号及 on_board=no 对象不要求封装。
2. 优先查看下载结果的 footprints：包含 archiveEntry、footprintName、footprintPath。匹配原封装型号，并确认实际器件的封装规格；不能仅凭名称近似替换。没有随包封装时，对去重后的精确型号调用器件搜索，选择同一候选的 manufacturer.id/mpn。已有模块符号保持不变，缺少在线符号模型不妨碍只下载封装。
3. 调用 import，projectDir 指向最终 project。一个 assignment 可以指定多个相同型号实例；选择 footprintPath 或 manufacturer_id+mpn，不能同时提供。工具以模块原符号的编号检查焊盘集合，而不是采用在线符号替换模块。额外的编号机械/散热焊盘须显式列入 allowedExtraPads，并填写 extraPadReason；说明来源及如何处理，不能为绕过不匹配而随意放行。检查只能确认编号覆盖，不证明引脚功能、封装尺寸或电气兼容。

```javascript
// 模块随包封装优先。省略 targetPath，保持来源文件不变。
localize_kicad_module_footprints({
  action: "import", schematicPath: modulePath, projectDir,
  assignments: [{ references: ["U1"], footprintPath: archiveFootprintPath }]
});
// 或使用精确器件搜索候选，不能猜 manufacturer_id：
// assignments: [{references:["U1"],manufacturer_id:manufacturer.id,mpn:exactMpn}]
```

4. 将返回的 mappingPath 写入设计脚本，使用相对于脚本自身位置的路径。Schematic.importModule 支持 footprintMappingPath，会根据 importModule 的编号映射更新 Footprint，而不改变符号、引脚、连线和模块位置。

`import` 返回 `stage: prepared` 和 `validationScope: source_with_mapping_applied` 表示映射及本地库就绪，**不表示源文件已更新**。对该来源使用 `action:"check_mapping"` 验证准备状态。不要对未改写的来源调用 `check` 并把 resolved:0 当作导入失败；`check` 只检查传入原理图的实际 Footprint 属性。失败批次返回 assignment 索引和短错误，验证全部通过前不写库；成功下载在当前进程缓存 15 分钟，修改失败项后重试整批可复用成功下载。网络准备最多 4 并发，项目库表写入串行；不需要拆成几十次单器件导入。缺少 manufacturer_id 时不可仅传 MPN 试探调用。

```javascript
const imported = sch.importModule({
  sourcePath: modulePath, name: "core", offset: [30, 30], nets: sharedNets,
  footprintMappingPath: mappingPath,
});
```

映射文件保存到 project/libraries/mappings/，与准确来源内容哈希绑定。修改来源器件或原理图后需要重新生成映射；不能继续套用旧文件。局部布局只修改集成脚本、不改来源时，映射可直接复用。手动的最终编号映射接口为 `sch.assignFootprints({U1:"LocalLibrary:Footprint"})`；优先采用 importModule 的映射文件方式，避免固定最终编号在后续重建中失效。

如需直接修改单页工作副本，可显式传 targetPath；工具仅更新 Footprint 属性。不要将不可变 sources 原文件作为 targetPath。I/O 失败可能留下部分库文件，按返回错误检查，不清空 project 重试。

5. 正式发布后调用 `localize_kicad_module_footprints({action:"check",schematicPath:最终原理图,projectDir})`。层次工程逐个检查实际子页。ready 只说明项目库表和对应封装文件齐全；未解决条目需要定位，不盲目替换型号。正式 delivery 也会检查所有已收集的根图/子页，缺失时返回 FOOTPRINTS_UNRESOLVED，不生成完整交付卡片。此类错误补齐映射即可，不重画电路、不重做布局。

项目 ZIP 递归包含本地封装和 libraries/mappings 下的映射记录。3D 模型并非本步骤保证项，上游外部模型路径可能仍不可用。

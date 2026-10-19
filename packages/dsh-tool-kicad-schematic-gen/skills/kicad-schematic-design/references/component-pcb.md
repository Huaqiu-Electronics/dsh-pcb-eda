# 器件与封装交付

独立搜索工具使用厂家 ID 与精确 MPN 选定器件。厂家名、搜索关键词和 huaqiuPn 不能代替 manufacturer.id。

1. `search_hqsch_parts({query, require_eda_model: true, requirements: {symbol: true, footprint: true}})` 取得候选。搜索标记只辅助筛选。
2. 使用同一 `{manufacturer_id: candidate.manufacturer.id, mpn: candidate.mpn}` 读取实际模型摘要和必要的手册，确认目标型号、引脚功能与封装尺寸。
3. `import_kicad_component({...identity, projectDir})` 下载并解析两种模型，登记项目库。缺模型、编号集合不一致和不支持的符号 unit 会被拒绝。重复编号焊盘按唯一编号比较，无编号的机械焊盘不参与比较；额外的有编号焊盘也会被拒绝。此严格规则可能拒绝需人工确认的散热焊盘或堆叠引脚模型。
4. 将返回的 libraryPath、libId、footprintId 写入共享 parts 数据；使用返回的 supported units。

```js
sch.addSymbol({
  libraryPath: imported.libraryPath,
  libId: imported.libId,
  footprint: imported.footprintId,
  unit: imported.builderCompatibility.availableUnits[0],
  reference: 'U1', value: selected.mpn, at: [100, 100],
})
```

下载保持上游封装内容，不生成 3D 文件或修改 PCB。模型中的外部 3D 引用可能仍无法解析，此处成功只保证符号、封装与编号集合检查。原理图的 Footprint 属性指向项目 `.pretty` 库中的实际模型，后续可使用 KiCad 更新 PCB 流程。

库文件已存在且内容不同时拒绝覆盖；两个库表保留其他条目。单个文件写入有版本保护，但多个文件不是事务。权限、取消或并发写入失败时按错误给出的项目路径检查部分文件，不能将失败导入算作成功；确认状态后可以重试相同器件。

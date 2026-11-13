# 复用模块的项目本地封装

下载模块后，保留源图、相邻的 `.kicad_sch.footprints.json` 索引及 `.footprints/` 资源目录。下载返回 `footprints: null` 时，按 `nextAction` 改选模块。已有下载缺少索引时，可重新执行下载补建索引；平铺脚本也可以通过 `footprintPaths` 提供现有的本地封装路径列表。

平铺调用只需给出模块源图及布局和连接信息：

```js
sch.importModule({
  sourcePath: modulePath,
  name: 'core',
  offset: [25.4, 25.4],
  nets: sharedNets,
});
sch.save(outputDirectory);
```

平铺导入和层次组装按原图的 `Footprint` 引用匹配随包模型。有完整库名与封装名匹配时优先使用，退回名称匹配时要求候选内容唯一。生成器核对源符号引脚与编号焊盘集合，并在输出目录中登记 `fp-lib-table`、保存项目本地封装、写入新的封装引用。相同内容在多个模块中共用，同名不同内容使用不同库 ID。原源图、符号和连线保留。发布候选时随工程保留库表和 `libraries/`。

`MODULE_FOOTPRINTS_UNAVAILABLE` 列出缺失、歧义或编号不匹配的位号。改选随包封装完整的模块。DNP 器件仍参与封装匹配，电源绘图符号及 `on_board=no` 对象无需实体封装。封装尺寸、电气适用性及 3D 模型需另行核对。

已有脚本可以继续传 `footprintMappingPath` 使用与源图哈希匹配的旧映射，并保留对应本地库。新加入的独立器件通过 `import_kicad_component_symbol_and_footprint` 成套入库，`addSymbol()` 可继承符号的默认封装。

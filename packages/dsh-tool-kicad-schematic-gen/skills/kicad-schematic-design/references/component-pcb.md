# 实际器件与封装

按精确manufacturer.id和mpn选器件，不用厂家名、关键词或huaqiuPn替代身份。常规生成只读导入部分，旧工程补参数时才读最后一节。

## 查询与成套导入

1. search_hqsch_parts({query,require_eda_model:true,requirements:{symbol:true,footprint:true}})筛选候选；搜索标记不证明实际模型可用。
2. 用同一manufacturer_id/mpn查get_kicad_component_models和必要手册：parsed含name/units/pins，单位0为公共单元；normalization=common_only_to_unit_1表示导入规范为1。get_hqsch_part补参数，get_hqsch_part_models仅给链接；需要采购信息才查供应链，空报价不代表无库存。
3. import_kicad_component({manufacturer_id,mpn,projectDir})登记本地符号/封装。缺模型、编号不匹配或不支持unit会拒绝，不手改库/换脚号绕过；同sourceUrl和结构的确定性失败不因换MPN重试。编号检查按唯一编号，无编号机械焊盘不参与，额外编号焊盘也拒绝；不替代尺寸、功能和手册核对。
4. 将返回libraryPath/libId/footprintId、实际value和引脚角色存共享parts，采用builderCompatibility.availableUnits。

```js
sch.addSymbol({libraryPath:imported.libraryPath,libId:imported.libId,
 footprint:imported.footprintId,unit:imported.builderCompatibility.availableUnits[0],
 reference:'U1',value:selected.mpn,at:[101.6,101.6]});
```

仅符号导入scope:"symbol"返回units，不建立封装引用；成套失败不自动降级。完整来源/兼容信息在libraryPath+'.import.json'，具体排障再读。

## 库与属性

成套封装使用kicad_api_lib:<精确MPN>及<MPN>.kicad_mod，保持上游封装字节/内部名称；默认libraries/footprints/kicad_api_lib.pretty，已有项目内注册则复用。符号默认Footprint同步为返回值；仅符号导入后的相同内容可在后续成套导入绑定。相同型号不同厂家模型内容不同、非法文件名或外部库注册会拒绝覆盖。

productDetail补齐缺失MPN、Manufacturer、huaqiu_pn、Description、Datasheet及技术参数，保留非空值，新增字段隐藏；addSymbol复制到实例。旧库/实例不会自动更新。全部物理器件（包括阻容/连接器）准备实际模型，电源绘图符号除外。方案BOM和parts一致，不用参考符号冒充采购器件。

库表保留其他条目；多个文件写入不是事务。权限/取消/并发失败先检查报错路径的部分结果，再重试，不清空工程。预览和正式快照不检查封装；需要时单独localize_kicad_module_footprints(action:"check")检查实际图，未变图仅改库后重查，不重画。来源模块的映射准备见 [封装本地化](module-footprints.md)。上游3D引用可能仍不可用，不保证PCB已更新。

## 旧库缺参数时才使用

node <propertySyncPath> <工作区manifest.json>默认检查；确认修复范围后加--apply。清单格式：

```json
{"workspace":"<绝对工作区>","parts":[{"manufacturer_id":"<确认ID>","mpn":"<精确型号>","libraryPath":"<项目库>","libId":"<库:符号>","references":["U1"]}],"schematics":["<实际图纸>"]}
```

part可指定工作区内detailPath复用同身份详情；否则查询精确器件。仅处理清单选定库/实例，不按Value猜型号；多页明确列图，必要时逐页建清单。冲突/缺项先报错，成功准备全部输入后备份到manifest旁properties-backup-*，再补库、lib_symbols和实例。

保留非空参数、Value/Footprint、引脚/UUID/连线，只补缺失字段；重复检查changedFiles应为空。失败按具体文件检查部分写入。脚本不更新来源模块、库表或模型下载，不能靠重跑绘图补源库缺失参数。

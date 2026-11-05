# 查询模块器件、网络与BOM

下载只保存文件，需要电路信息才查询analyze_kicad_module；不必先调用summary。需要改电路时按 [脚本修改](editing.md)，缺少的图纸备注按需看来源和预览。

## 请求与结果

```json
{"schematicPath":"designs/demo/sources/module.kicad_sch","view":"nets","reference":"U1","pin":"7"}
```

必填schematicPath/view；可选reference、pin、net、offset、kicadCliPath、refresh。pin只用于nets且须配reference，net仅用于nets；offset不用于summary。正常省略CLI和refresh。

| view | 何时使用及重要含义 |
| --- | --- |
| components | 位号、数值、封装、装配状态；按reference筛选时附自定义fields/sheetPath。只有BOM推导器件时partial，可能不全；bomIncluded省略表示未知，其余装配布尔标记省略为false |
| nets | 网名和节点；reference/pin查询返回该脚所在网络。每块最多32节点，按nextOffset继续，并将相同net的分块合并，不能把一个网络误认为多个 |
| bom | 按数值、封装、完整物料字段和装配状态分组，含references/quantity。仅BOM而缺网表补充时，采购字段可能不完整 |
| summary | 确需总统计时使用；counts.bom为纳入BOM的器件数，不是分组行数；缺统计表示未知 |

详情返回status/items及可选nextOffset、warnings、error、files；无nextOffset才结束。每页最多60项/24000字符；fieldsTruncated或omitted表示需从files读完整数据，不代表连接缺失。ready+空items是无匹配，unavailable+空items是未取得数据，partial仅部分可用。DNP网络不证明已装配，ready不证明电气正确。

components/nets复用网表，bom按需补物料字段；summary可能补充尚未尝试的阶段。成功/失败按阶段缓存，不为获取另一个view重新下载或重复导出。完整网表器件/物料在components.json，网络在connectivity.json，需排障时再从返回files定位。

## 来源与恢复

工具内部选择CLI及同名配套工程：HQ_EDA_*优先.source.kicad_pro，否则.kicad_pro；其它本地图使用同名.kicad_pro。不传sourceProjectPath或扫描任意文件；非标准来源须准备同名工程，原始来源保持不变。

来源、子页、配套工程或CLI变化使结果失效；工作副本按自身路径查询。修好问题后保留原查询和筛选条件，加refresh:true刷新所需阶段；刷新失败不能继续沿用该阶段旧成功结果。普通调用不会隐式重试缓存的失败。

error含code/message，完整诊断在files的metadata.stages；启动探测尚未生成文件时可没有files。CLI_START_FAILED复用已知宿主CLI路径，加kicadCliPath和refresh:true重试；导出、解析、能力或超时按原原因处理，不一律换路径。其余按 [恢复参考](troubleshooting.md)，不重新下载已成功来源。

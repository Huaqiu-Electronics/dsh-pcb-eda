# 模块网表与器件清单

下载已返回 analysis 摘要，无明细需求不重复 summary。用 analyze_kicad_module 查询器件、BOM 或电气网络；坐标、UUID、图纸备注和可见接线定位才用 [编辑工具](editing.md)。

## 查询

必填 schematicPath、view（summary/components/nets/bom）；可选 reference、pin、net、offset、kicadCliPath。pin 必须与 reference、view:nets 同用；net 仅用于 nets，offset 分页不用于 summary。正常省略 kicadCliPath。

```json
{"schematicPath":"designs/demo/sources/module.kicad_sch","view":"components"}
```

```json
{"schematicPath":"designs/demo/sources/module.kicad_sch","view":"nets","reference":"U1","pin":"7"}
```

CLI 和配套工程内部解析，不传 sourceProjectPath。HQ_EDA_* 图优先同名 .source.kicad_pro，否则同名 .kicad_pro；其它本地图使用同名 .kicad_pro。非标准外部图需准备同名工程，不扫描任意文件。来源保持不变，正式配置用模板。

## 返回与分页

详情为 status/items，可选 nextOffset/warnings。无 nextOffset 才结束；每页最多60项、24000字符，单条超限有 omitted/files，按返回文件定位，不能当空记录。

| view | 解释 |
| --- | --- |
| components | 位号、数值、封装、装配状态；指定 reference 才附原始 fields/sheetPath。采购型号从原字段获取，不从 Value 推测。省略的布尔标志为 false；bomIncluded:null 是不可用，不是未纳入。 |
| nets | `{net,nodes}`，节点含位号、脚号及非空脚名/类型。reference/pin 返回所在网络节点；超过32节点分块，有 nodeOffset/totalNodes，按 nextOffset 继续并按 net 合并。 |
| bom | 按数值、封装、全部原字段和装配标志分组，返回 references/quantity/物料属性，不合并不同型号或装配状态；可按 reference 筛选。 |
| summary | status/counts/inventoryScope，失败附 warnings/files；counts.bom 是器件数而非分组行数，缺统计表示未知。 |

ready 只表示提取完整；partial/unavailable 先看 warnings。bom_only 可能漏掉排除符号；空 items 仅在对应数据可用时表示无匹配。DNP 的连线不代表器件已装配，结果不代替手册、计算或 ERC。

## 复用与恢复

同版本成功或部分结果复用，不重复失败导出；修复配置后用 view:summary 重试分析，不重下载。来源、子页、配套工程或 CLI 身份改变会失效；工作副本按副本路径查询。

错误返回 error:{code,executable} 及诊断。CLI_START_FAILED 的路径恢复见 [错误处理](troubleshooting.md#路径与请求失败)，其它探测/能力/导出错误按其诊断处理，不一律换路径。完整本地数据按返回 files 定位，无需了解缓存目录布局或读取全部文件。

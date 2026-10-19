# 模块网表与器件清单

下载成功后会自动分析。先使用下载返回的 analysis 摘要；没有明细需求时不要再调用 summary。需要器件、BOM 或连接时直接查询对应 view，不反复读取相同结果。

本工具是方案阶段的主要电路查询入口。不要再例行调用 edit_kicad_flat_schematic 读取相同器件或可见导线来重复核对网络。只有缺少影响方案的图纸备注等具体信息时，才定向使用 flat 的 list，指定 types/references；几何坐标、UUID、局部导线路径及 create 留到实际原理图适配。每次查询均应有具体信息缺口，复用已获得的结论。

## 入参

`analyze_kicad_module` 必填 schematicPath、view；可选 reference、pin、net、offset、kicadCliPath。view 为 summary/components/nets/bom。pin 必须与 reference、view:nets 同用；net 只用于 nets。offset 是分页位置，不用于 summary。kicadCliPath 仅用于异常恢复，传宿主提供的 kicad-cli 绝对路径；正常查询省略。

```json
{"schematicPath":"designs/demo/sources/module.kicad_sch","view":"components"}
```

```json
{"schematicPath":"designs/demo/sources/module.kicad_sch","view":"nets","reference":"U1","pin":"7"}
```

CLI 和配套工程默认由内部解析，不传 sourceProjectPath。下载或分析时提供的环境按工作区和实际源路径记忆。重启后，HQ_EDA_* 原理图优先采用同名 .source.kicad_pro，否则采用同名 .kicad_pro；其他本地图采用同名 .kicad_pro。不扫描任意工程文件；非标准命名的外部本地图需先准备同名配套工程。CLI 使用插件配置及现有可移植发现，默认命令名 kicad-cli/kicad-cli.exe 不覆盖自动发现。来源工程保持不变，正式工程使用模板。

## 精简返回

详情返回 status、items；还有下一页才返回 nextOffset；有问题才返回 warnings。没有 nextOffset 表示分页结束。每页最多 60 项、24000 字符；单条超过限制时返回明确 omitted 提示及 files 路径，按本地文件定向读取，不能当作空记录。

- components 默认给位号、数值、封装及装配状态；指定 reference 时附原始 fields 和 sheetPath。采购型号只从原始字段获取，不从 Value 推测。未输出的布尔标志为 false，bomIncluded:null 表示 BOM 不可用，不能理解为未纳入 BOM。
- nets 每项为 {net,nodes}，nodes 包含位号、引脚编号和非空引脚名称/类型。reference/pin 筛选返回所在网络的全部连接节点。大于 32 个节点的网络分块，带 nodeOffset、totalNodes；继续按 nextOffset 查询并按 net 合并，不能把单块当作全部连接。
- bom 从统一器件清单的 bomIncluded 派生，按数值、封装、全部原始字段和装配标志分组，返回 references、quantity 和物料属性；不同采购型号或装配状态不合并。可用 reference 查询单个器件。
- summary 返回 status、counts、inventoryScope；失败时附 warnings 和可用的 files。不重复输出 revision、cached 和固定操作提示。counts.bom 是 BOM 器件数量，不是分组后行数；缺失统计表示未知。

ready 表示提取完整，不表示电路正确；partial/unavailable 时先看 warnings。bom_only 清单可能漏掉被排除的符号。空 items 只有在对应数据可用时才表示无匹配结果；不可用时有明确警告。

## 缓存与重试

完整有效缓存直接复用；详情查询也复用同版本的部分或失败数据，不反复执行失败导出。修复配置后，显式使用 view:summary 重试失败分析，不重新下载。来源、子页、配套工程或 CLI 身份变化会使缓存失效。修改工作副本后按副本路径分析。

CLI 探测失败时返回 error:{code,executable}，保留具体诊断。只有 CLI_START_FAILED 才引导路径恢复：复用已有 get_eda_host_info 的 installation.executables 中 name 为 kicad-cli 的 path；没有宿主信息才调用一次获取。用原 schematicPath、view:summary、kicadCliPath:<宿主绝对路径> 调 analyze_kicad_module。不得为补路径重新下载、扫描安装目录或读取全局配置。成功路径后续自动复用。CLI_CAPABILITY_UNSUPPORTED 检查版本与导出选项；CLI_PROBE_TIMEOUT/CLI_PROBE_FAILED 按诊断处理，不一律归为路径问题。

只持久化 analysis/<来源名>/<revision>/components.json 和 connectivity.json，使用 {metadata,data} 结构保存完整数据、诊断及缓存校验信息。原始网表和 BOM CSV 在临时目录处理后清理。精简的是查询返回，完整分析文件仍保留原始字段。旧缓存不自动删除。

默认装配变体，不执行 ERC 或预期接线审计。DNP 器件的网络连接不表示它已装配；需坐标、UUID 时使用 edit_kicad_flat_schematic，图片用于布局与可读性检查。

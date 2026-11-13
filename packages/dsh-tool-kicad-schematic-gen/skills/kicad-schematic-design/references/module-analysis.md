# 下载模块的器件、网表与 BOM

`download_eda_module_schematic` 保存源图、可用的配套工程和随包封装。有随包封装时，它同时提取模块信息。读取 `analysis` 里的短摘要，按当前问题选择文件：

| 字段 | 用途 |
| --- | --- |
| `analysis.ports` | 显式层次端口名称、总数和方向冲突。摘要截断时按 `analysis.ports.nextAction` 获取完整名称数组。空列表时从连接器引脚和网表判断接口。 |
| `analysis.files.components` | `components.json` 中的 `data.components` 保留网表导出的位号、值、封装、字段和装配信息。网表失败而 BOM 可用时，`data.bomRows` 提供有限的器件信息。 |
| `analysis.files.bom` | `bom.json` 的 `items` 按器件实例列出 BOM 成员和可取得的物料字段。 |
| `analysis.files.connectivity` | `connectivity.json` 的 `data.nets` 保存网名和完整连接节点。 |

`analysis.status` 为 `ready` 时摘要和导出均可用，`partial` 时先复用已有文件，`unavailable` 时查看诊断及端口子状态。下载的原理图仍可查看。阶段诊断见 `analysis.stages`，完整导出文件保存在源图附近按版本划分的 `analysis/` 目录。结果对应默认装配变体，电气验收按设计检查流程进行。

`footprints: null` 时按 `nextAction` 改选模块，`analysis.status` 为 `skipped`。导出失败时先处理原因，再使用相同 `moduleId` 和 `targetDir` 加 `refreshAnalysis: true`，复用当前插件进程记录的近期本地下载。CLI 启动失败时可额外传 `get_eda_host_info` 已知的 `kicadCliPath` 绝对路径。进程重启或本地记录被淘汰时，重新调用正常下载流程。

对于自己生成的候选原理图，按模块检查和整图验收流程核对实际连接。

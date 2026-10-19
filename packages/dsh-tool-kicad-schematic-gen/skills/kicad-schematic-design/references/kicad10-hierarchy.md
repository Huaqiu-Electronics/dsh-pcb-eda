# KiCad 10 层次工程参考

仅在需要手工检查层次文件格式，或 `create_kicad_hierarchy` 报错而需要定位文件问题时读取此参考。正常生成工程时直接提供模块路径与已核实的端口连接表，不把这些示例文件复制成实际电路设计。

## 可打开的最小样例

[样例目录](kicad10-hierarchy-template/)包含根图 `hierarchy_template.kicad_sch`、工程配置 `hierarchy_template.kicad_pro`、子图 `schematic/hierarchy_template_sheet_1.kicad_sch`、局部符号库及 `sym-lib-table`。根图的 `Sheetfile` 指向相对路径 `schematic/hierarchy_template_sheet_1.kicad_sch`；根图页引脚 `IN`、`OUT` 与子图层次标签名称和方向一致。根图将这两个端口分别映射到 `EXAMPLE_IN`、`EXAMPLE_OUT` 网络。子图里两端用导线相接，仅演示 KiCad 文件格式，不是可复用的电路模块。

该样例由当前骨架生成逻辑生成，并通过本机 KiCad 10.0.6 的 `kicad-cli sch export svg` 导出根页和子页。这个结果只证明 KiCad 能读取并绘制文件，不证明任何实际电路的电气条件。

## 使用规则

- 新设计优先调用 `create_kicad_hierarchy`。它从已声明层次端口的单页模块生成根图、子图副本、工程配置和页引脚；`sources/` 中的下载文件保持原样。
- 每个源端口必须恰好在 `connections` 或 `unconnectedPorts` 中出现一次。相同的根图网络名称使对应页引脚相连；名称由明确连接表决定，不由工具猜测。
- 模块没有层次标签时，先在副本中核实内部接点并建立接口，再把副本交给生成工具。参考样例不提供自动寻找接点的方法。
- 要查看具体字段时按需打开样例中的根图、子图或工程配置；不要把全部样例文本放进常规模型上下文。

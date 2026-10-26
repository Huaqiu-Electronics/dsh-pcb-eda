# 无源晶振与负载电容

仅适用于芯片确认使用外部无源晶振、且需要外部负载电容的接法。显式传 externalCrystalConfirmed:true；不用于有源时钟模块，不给内部已集成负载的电路重复加电容。

## 用法

[可执行 place 代码](../../assets/drawing-patterns/crystal-load.mjs) · [实际生成的参考图](../../assets/drawing-patterns/crystal-load.png)

parts.crystal.pins 提供 left/right；有经核实的外壳接地脚时提供 caseGround 数组。parts.capacitors/references.capacitors 各为长度 2 的数组，电容提供 top/bottom。references.crystal 为实际编号；nets 提供 left/right/ground。

沿用索引的 place/connect 两阶段调用：所有器件放置后再调用 connect()。返回 ports（真实 reference/pin）、reservedBounds（估计预留区域）和 connect。与 geometry.mjs 一同复制；不自动保存、分框或导入模型。

## 布局与检查

晶振水平居中，两侧各一只电容向下接地，左右振荡网络分别连接芯片。先核实晶振频率、负载条件和芯片要求；频率、容值与外壳脚号均来自具体器件，图中符号来自固定的 KiCad 官方参考模型。

使用 50 mil（1.27 mm）栅格；基于 region.pin 的真实引脚坐标连接，不把截图坐标当接点。电源/地标签由主入口统一转成标准电源符号；外围需位于所属功能框内。维护生成图使用 KiCad 官方参考符号展示代码布局，不代表已选型、物理封装或电气验证通过。

实际模型不满足代码的方向/间距检查时先调整 angle/mirror 和区域，不能互换物理脚号。按布局交付停止条件集中修复明确问题，清晰可读后停止装饰迭代。

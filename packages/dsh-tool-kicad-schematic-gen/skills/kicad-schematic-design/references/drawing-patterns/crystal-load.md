# 无源晶振与负载电容

仅适用于芯片确认使用外部无源晶振、且需要外部负载电容的接法。显式传 externalCrystalConfirmed:true；不用于有源时钟模块，不给内部已集成负载的电路重复加电容。

## 用法

[可执行 place 代码](../../assets/drawing-patterns/crystal-load.mjs) · [实际生成的参考图](../../assets/drawing-patterns/crystal-load.png)

parts.crystal.pins 提供 left/right；有经核实的外壳接地脚时提供 caseGround 数组。parts.capacitors/references.capacitors 各为长度 2 的数组，电容提供 top/bottom。references.crystal 为实际编号；nets 提供 left/right/ground。

与geometry.mjs一起复制；返回ports、reservedBounds和connect，共用调用约定见画法索引。

## 布局与检查

晶振水平居中，两侧各一只电容向下接地，左右振荡网络分别连接芯片。先核实晶振频率、负载条件和芯片要求；频率、容值与外壳脚号均来自具体器件，图中符号来自固定的 KiCad 官方参考模型。

方向/间距不兼容时调整angle/mirror或布局，不互换物理脚号。

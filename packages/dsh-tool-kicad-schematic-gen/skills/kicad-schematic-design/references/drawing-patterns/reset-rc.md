# 复位/使能 RC

仅适用于已核实的有效低信号、上拉电阻、对地按键和对地电容。必须显式传 activeLowRcConfirmed:true；不自动用于所有 RESET、EN 或 BOOT。

## 用法

[可执行 place 代码](../../assets/drawing-patterns/reset-rc.mjs) · [实际生成的参考图](../../assets/drawing-patterns/reset-rc.png)

parts.resistor/button/capacitor 各含 top/bottom 角色及实际导入符号属性。references 提供 resistor/button/capacitor；nets 提供 supply/ground/signal。

沿用索引的 place/connect 两阶段调用：所有器件放置后再调用 connect()。返回 ports（真实 reference/pin）、reservedBounds（估计预留区域）和 connect。与 geometry.mjs 一同复制；不自动保存、分框或导入模型。

## 布局与检查

上拉、信号节点、按键同轴，电容在右下方，信号水平向右引出。核实按键触点关系、RC 充放电时序和芯片输入条件；示例不计算或推荐 RC 值。

使用 50 mil（1.27 mm）栅格；基于 region.pin 的真实引脚坐标连接，不把截图坐标当接点。电源/地标签由主入口统一转成标准电源符号；外围需位于所属功能框内。维护生成图使用 KiCad 官方参考符号展示代码布局，不代表已选型、物理封装或电气验证通过。

实际模型不满足代码的方向/间距检查时先调整 angle/mirror 和区域，不能互换物理脚号。按布局交付停止条件集中修复明确问题，清晰可读后停止装饰迭代。

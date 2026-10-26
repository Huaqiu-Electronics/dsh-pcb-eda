# I²C 双线上拉

仅适用于已核实的同一电压域 SDA/SCL 上拉；不是电平转换或不同电压域兼容性证明。先确认板内及外部设备是否已有上拉，避免重复添加。

## 用法

[可执行 place 代码](../../assets/drawing-patterns/i2c-pullups.mjs) · [实际生成的参考图](../../assets/drawing-patterns/i2c-pullups.png)

parts.resistors 和 references.resistors 均为长度 2 的数组；电阻提供 top/bottom 角色。nets 提供 supply/sda/scl，SDA 与 SCL 必须不同。

沿用索引的 place/connect 两阶段调用：所有器件放置后再调用 connect()。返回 ports（真实 reference/pin）、reservedBounds（估计预留区域）和 connect。与 geometry.mjs 一同复制；不自动保存、分框或导入模型。

## 布局与检查

两只电阻竖向并排，共用上方电源母线；下端分别接 SDA、SCL，信号绝不互连。取值依据实际总线、电压、设备驱动和时序约束确定；范例不固定推荐阻值。

使用 50 mil（1.27 mm）栅格；基于 region.pin 的真实引脚坐标连接，不把截图坐标当接点。电源/地标签由主入口统一转成标准电源符号；外围需位于所属功能框内。维护生成图使用 KiCad 官方参考符号展示代码布局，不代表已选型、物理封装或电气验证通过。

实际模型不满足代码的方向/间距检查时先调整 angle/mirror 和区域，不能互换物理脚号。按布局交付停止条件集中修复明确问题，清晰可读后停止装饰迭代。

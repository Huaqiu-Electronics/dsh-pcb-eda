# I²C 双线上拉

仅适用于已核实的同一电压域 SDA/SCL 上拉；不是电平转换或不同电压域兼容性证明。先确认板内及外部设备是否已有上拉，避免重复添加。

## 用法

[可执行 place 代码](../../assets/drawing-patterns/i2c-pullups.mjs) · [实际生成的参考图](../../assets/drawing-patterns/i2c-pullups.png)

parts.resistors 和 references.resistors 均为长度 2 的数组；电阻提供 top/bottom 角色。nets 提供 supply/sda/scl，SDA 与 SCL 必须不同。

与geometry.mjs一起复制；返回ports、reservedBounds和connect，共用调用约定见画法索引。

## 布局与检查

两只电阻竖向并排，共用上方电源母线；下端分别接 SDA、SCL，信号绝不互连。取值依据实际总线、电压、设备驱动和时序约束确定；范例不固定推荐阻值。

方向/间距不兼容时调整angle/mirror或布局，不互换物理脚号。

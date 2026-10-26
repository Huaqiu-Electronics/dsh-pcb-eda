# 三脚固定输出 LDO

适用于已核实 VIN/VOUT/GND 三种引脚角色、没有 EN 的固定输出稳压器。可用于经手册和模型确认的 1117 类接法；不依据名称认定引脚、TAB、压差、稳定性或封装兼容。

## 用法

[可执行 place 代码](../../assets/drawing-patterns/ldo-three-pin.mjs) · [实际生成的参考图](../../assets/drawing-patterns/ldo-three-pin.png)

parts.ldo.pins 提供 vin/vout/gnd；存在独立输出 TAB 时显式提供 outputTabs 数组。inputCapacitors/outputCapacitors 为非空实际电容数组，每项使用 top/bottom 角色。references 提供 ldo/inputCapacitors/outputCapacitors；nets 提供 input/output/ground。

沿用索引的 place/connect 两阶段调用：所有器件放置后再调用 connect()。返回 ports（真实 reference/pin）、reservedBounds（估计预留区域）和 connect。与 geometry.mjs 一同复制；不自动保存、分框或导入模型。

## 布局与检查

输入电容在 VIN 左侧，输出电容在 VOUT 右侧，各支路对地；GND 向下。图中短型号/容值仅为演示，不是通用 BOM。器件的 angle/mirror 必须使 VIN 在左、VOUT 在右、GND 在下。

使用 50 mil（1.27 mm）栅格；基于 region.pin 的真实引脚坐标连接，不把截图坐标当接点。电源/地标签由主入口统一转成标准电源符号；外围需位于所属功能框内。维护生成图使用 KiCad 官方参考符号展示代码布局，不代表已选型、物理封装或电气验证通过。

实际模型不满足代码的方向/间距检查时先调整 angle/mirror 和区域，不能互换物理脚号。按布局交付停止条件集中修复明确问题，清晰可读后停止装饰迭代。

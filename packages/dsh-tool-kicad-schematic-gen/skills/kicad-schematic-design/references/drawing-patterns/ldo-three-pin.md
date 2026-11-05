# 三脚固定输出 LDO

适用于已核实 VIN/VOUT/GND 三种引脚角色、没有 EN 的固定输出稳压器。可用于经手册和模型确认的 1117 类接法；不依据名称认定引脚、TAB、压差、稳定性或封装兼容。

## 用法

[可执行 place 代码](../../assets/drawing-patterns/ldo-three-pin.mjs) · [实际生成的参考图](../../assets/drawing-patterns/ldo-three-pin.png)

parts.ldo.pins 提供 vin/vout/gnd；存在独立输出 TAB 时显式提供 outputTabs 数组。inputCapacitors/outputCapacitors 为非空实际电容数组，每项使用 top/bottom 角色。references 提供 ldo/inputCapacitors/outputCapacitors；nets 提供 input/output/ground。

与geometry.mjs一起复制；返回ports、reservedBounds和connect，共用调用约定见画法索引。

## 布局与检查

输入电容在 VIN 左侧，输出电容在 VOUT 右侧，各支路对地；GND 向下。图中短型号/容值仅为演示，不是通用 BOM。器件的 angle/mirror 必须使 VIN 在左、VOUT 在右、GND 在下。

方向/间距不兼容时调整angle/mirror或布局，不互换物理脚号。

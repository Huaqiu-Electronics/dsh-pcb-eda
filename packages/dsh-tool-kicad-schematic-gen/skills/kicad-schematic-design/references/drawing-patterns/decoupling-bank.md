# 去耦电容组

电源母线在上，电容竖直并排，公共地线在下；属性水平放在各电容右侧。每个电容通过明确的支路接入母线，不跨越其他电源域。

parts.capacitors 是含实际 value、footprint、angle、pins.top/bottom 的数组；references.capacitors 与其一一对应。默认列距 20.32 mm，长文字可增大 pitch。数量、容量、耐压和极性按设计确定，不能把示例当成通用容量组合。

[代码](../../assets/drawing-patterns/decoupling-bank.mjs) · [参考图](../../assets/drawing-patterns/decoupling-bank.png)。原理图上并排不代表 PCB 上已靠近电源引脚放置。

LDO 输入、输出电容优先按 [LDO 整体画法](ldo-fixed-on.md) 分别放在 VIN/VOUT 两侧，不把电容集中在模块下方只用同名标签连接；不同电源域不能合并为一组。

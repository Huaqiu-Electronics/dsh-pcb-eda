# LDO 与所属输入、输出电容

采用用户提供的 [参考画法](../../assets/drawing-patterns/reference-ldo.png)：VIN 在左，VOUT 在右；输入电容紧邻左侧输入母线，输出电容紧邻右侧输出母线，下方共地。用短直接导线表现所属关系，不把两组电容放到框下方再靠同名标签表达。

[代码](../../assets/drawing-patterns/ldo-fixed-on.mjs) · [实际生成图](../../assets/drawing-patterns/ldo-fixed-on.png)。

这是固定输出、已确认 EN 可以接 VIN 的特定画法，必须显式传 enableToVin:true。不适用于可调反馈、外部使能、旁路脚或其他方向的符号；不能仅为套图改接法。输入、输出各两个电容只是本例拓扑，实际数量和参数来自已确认设计，不为凑模板添加电容。其他数量参照同一排列原则定制。

parts.ldo 提供真实符号及 pins:{vin,vout,en,gnd,nc:[]}；parts.inputCapacitors / outputCapacitors 是各自器件数组，电容 pins 使用 top/bottom。references 使用 ldo、inputCapacitors、outputCapacitors，nets 使用 input/output/ground。位号由主入口统一分配。长型号、不同尺寸或方向需调整空间；代码会拒绝不支持的引脚排列。

这只改善原理图表达。容量、ESR、耐压和使能条件需按选定器件要求确定；PCB 上是否就近、回流是否合理仍需在 PCB 阶段落实。

# 五针 SWD 调试排针

[参考代码](../../assets/drawing-patterns/swd-header.mjs) · [实际 KiCad 预览](../../assets/drawing-patterns/swd-header.png)

以单排五针项目自定义接口展示 VTREF、SWDIO、GND、SWCLK、NRST。示例脚序为 1 VTREF、2 SWDIO、3 GND、4 SWCLK、5 NRST；这是项目约定，不是标准 Cortex 10 针接口，也不保证与现有调试器插头直接兼容。

调用时传入 `pinoutConfirmed: true`。parts.header.pins 为 vtref、swdio、ground、swclk、reset 到实际脚号的映射，references.header 分配位号；nets 使用相同角色键。返回所有针脚的 ports，供主入口组合。

本例 VTREF_3V3 是目标电压参考网络。集成到 MCU 工程时将 nets.vtref 映射到目标 I/O 供电域（如 +3V3），不能把独立标签名留成悬空参考。VTREF 用于调试器感知目标电平，不默认当成调试器对目标板的供电输出。另有供电针的调试器需分别核实，避免倒灌。

是否加信号电阻、上下拉、ESD、NRST 外围，以及线缆长度和接口方向由 MCU 和调试器要求决定。依据：[SEGGER 接口与 VTref 定义](https://www.segger.com/products/debug-probes/j-link/technology/interface-description/)。

所有单元沿用 `place({region, at, parts, references, nets, ...})`，返回 reservedBounds、ports 和 connect()。先放置，再由主入口统一 connect；电源标签最后按现有流程转成官方电源符号。复制 geometry.mjs；MOSFET 单元还需 dcdc-geometry.mjs。保留 50 mil 栅格，长型号按实际属性边界加大空间，不能互换物理引脚以适配画法。

维护生成器为 generate-systems.mjs，使用固定官方参考符号并先保存维护方案。参考图只验证画法和连接，不能替代真实器件选型、完整电气设计及 PCB 验证。来源查阅日期：2026-10-26。

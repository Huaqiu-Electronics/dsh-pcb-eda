# MCU 最小系统（内部 RC）

[参考代码](../../assets/drawing-patterns/mcu-minimum.mjs) · [实际 KiCad 预览](../../assets/drawing-patterns/mcu-minimum.png)

以 STM32F030F4Px 的 TSSOP20 符号演示：VDD/VDDA 及其去耦在上，地在下，复位与启动配置在左，UART 和 SWD 信号在右。复位上拉与复位电容在 NRST 节点上下竖向对齐，BOOT 下拉位于 BOOT0 下方，全部以短正交导线直接接回 MCU，避免用同名标签把紧邻外围拆成孤立支路。两个去耦电容直接接在同一供电母线上；实际 PCB 分别靠近对应电源引脚。

适用前提：已确认内部 RC 满足功能和时钟精度需求、BOOT0 拉低从 Flash 启动。调用时显式传入 `internalRcConfirmed: true`、`bootLowConfirmed: true`。需要外部无源晶振时改用 [带晶振版本](mcu-external-crystal.md)；其他启动模式、其他 MCU 的 VCAP/电源域不能套用本接法。

`parts.mcu.pins` 包含 supply/ground 数组、signals 角色到物理引脚的映射及 unused 数组；signals 为 reset、boot、tx、rx、swdio、swclk。其他 parts 为 decoupling 数组、resetResistor、resetCapacitor、bootResistor（电容/电阻 top/bottom）；references 使用相同键，nets 为 supply、ground 和上述信号角色。

本例物理引脚：16 VDD、5 VDDA、15 VSS、4 NRST、1 BOOT0、17 PA9/TX、18 PA10/RX、19 PA13/SWDIO、20 PA14/SWCLK。未使用 GPIO 仅在此独立示例中标 NC；正式设计按需求使用，并核实复用功能和固件配置。100n 为去耦示例，复位 RC 和 BOOT 电阻以待选参数显示，系统储能/模拟电源滤波与其他外围按实际电源及手册补全。

依据：[ST 数据手册](https://www.st.com/resource/en/datasheet/stm32f030f4.pdf) 与 [ST AN4325 硬件开发指南](https://www.st.com/resource/en/application_note/an4325-getting-started-with-stm32f030xx-and-stm32f070xx-series-hardware-development-stmicroelectronics.pdf)。

所有单元沿用 `place({region, at, parts, references, nets, ...})`，返回 reservedBounds、ports 和 connect()。先放置，再由主入口统一 connect；电源标签最后按现有流程转成官方电源符号。复制 geometry.mjs；MOSFET 单元还需 dcdc-geometry.mjs。保留 50 mil 栅格，长型号按实际属性边界加大空间，不能互换物理引脚以适配画法。

维护生成器为 generate-systems.mjs，使用固定官方参考符号并先保存维护方案。参考图只验证画法和连接，不能替代真实器件选型、完整电气设计及 PCB 验证。来源查阅日期：2026-10-26。

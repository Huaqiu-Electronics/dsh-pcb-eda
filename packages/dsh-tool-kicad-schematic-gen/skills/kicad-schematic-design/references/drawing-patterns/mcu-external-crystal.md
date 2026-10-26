# MCU 最小系统（外部无源晶振）

[参考入口代码](../../assets/drawing-patterns/mcu-external-crystal.mjs) · [共用布局代码](../../assets/drawing-patterns/mcu-minimum.mjs) · [实际 KiCad 预览](../../assets/drawing-patterns/mcu-external-crystal.png)

在 [内部 RC 版本](mcu-minimum.md) 的供电、复位、BOOT 和调试电路基础上，启用 PF0/OSC_IN 与 PF1/OSC_OUT，通过 OSC_IN、OSC_OUT 两组同名标签连接一只无源晶体和两只对地负载电容。MCU 引脚与晶体两端均使用 3.81 mm 短引线标签（左侧文字向外对齐），取消两根跨区长线。晶体位于 MCU 左下方；复位及 BOOT 外围仍紧邻对应引脚直接连线。

调用此入口须传入 `externalCrystalConfirmed: true`、`bootLowConfirmed: true`，不传 internalRcConfirmed:true。parts.mcu.pins.oscillator 为 `{input:'2', output:'3'}`（仅针对本例 STM32F030F4Px），并从 unused 中移除这两个引脚。新增 parts.crystal（left/right）、parts.loadCapacitors（两个 top/bottom 电容），references.crystal 和 references.loadCapacitors 分配位号。nets 另需 oscillatorInput、oscillatorOutput 两个独立网络名，本例分别为 OSC_IN、OSC_OUT；多组振荡器应使用各自独立的名称。其余 parts、references、nets 同内部时钟版本。复制入口时同时复制 mcu-minimum.mjs 和 geometry.mjs。

XTAL_SEL、CL1_SEL、CL2_SEL 是待选参数。根据 MCU 振荡器要求及所选晶体手册核实频率、负载电容、ESR、驱动功率和启动裕量，并考虑寄生电容；不能默认套用固定晶振频率或两只固定电容。是否需要串联/并联电阻或其他振荡器外围，以具体器件指导为准。有源振荡器和旁路时钟不能使用本双电容晶体接法。PCB 上晶体及负载电容应靠近振荡引脚，走线短且远离开关噪声；图上的紧凑程度不替代 PCB 时钟布局检查。

维护：generate-systems.mjs 生成五个范例，render.mjs 的 --systems 渲染对应图片。保留 50 mil 栅格，按真实符号尺寸调整空间，不互换物理引脚。依据：[ST STM32F030 数据手册](https://www.st.com/resource/en/datasheet/stm32f030f4.pdf) 与 [ST AN4325 硬件指南](https://www.st.com/resource/en/application_note/an4325-getting-started-with-stm32f030xx-and-stm32f070xx-series-hardware-development-stmicroelectronics.pdf)。

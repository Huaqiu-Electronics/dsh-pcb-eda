# 电源指示 LED

电源在上，限流电阻、LED 共竖直轴，地在下；位号和数值水平放在右侧。适用于已确认的电源指示支路，不自动适用于 GPIO 高/低有效驱动。

parts.resistor.pins 为 top/bottom，parts.led.pins 为 anode/cathode；angle 必须使这些角色在图上由上到下排列。value 与 footprint 来自实际器件，电阻取值需按电源、LED 参数和目标电流确认。

[代码](../../assets/drawing-patterns/led-power-indicator.mjs) · [参考图](../../assets/drawing-patterns/led-power-indicator.png)。长型号需增大右侧预留空间，不缩小文字。

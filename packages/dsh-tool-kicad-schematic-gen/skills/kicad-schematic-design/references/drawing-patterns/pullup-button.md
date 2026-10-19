# 上拉按键

电源、上拉电阻、按键、地沿竖轴排列；信号由电阻与按键之间的节点向右引出，分支显式加连接点。按键属性放右侧，与上拉属性对齐。

按键实际触点应在图上上下排列，不使用横放按键加回绕线来替代。复位带电容或多个启动支路并排时，先读 [复位与启动画法](reset-enable.md)：电容位于节点右下方、地向下；不把同一 RC 拓扑自动套到 BOOT。

parts.resistor 和 parts.button 都提供 pins.top/bottom；angle 对应实际竖向引脚。仅用于已确认的有效低输入，阻值、输入容限和消抖由设计决定。不把它自动解释为任意芯片的启动或复位电路；本例不自动添加 RC。

[代码](../../assets/drawing-patterns/pullup-button.mjs) · [参考图](../../assets/drawing-patterns/pullup-button.png)。返回 signal 为按键上端的真实引脚。

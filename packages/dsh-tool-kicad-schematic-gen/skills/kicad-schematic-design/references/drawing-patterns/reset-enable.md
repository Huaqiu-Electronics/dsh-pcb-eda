# 复位 RC 与启动按键

仅适用于已确认的有效低、上拉及按下接地电路；复位和BOOT按各自芯片要求选择，不自动给BOOT增加电容或推断参数。

| 选用画法 | 必要输入与限制 | 代码／图片 |
| --- | --- | --- |
| reset-rc | activeLowRcConfirmed:true；parts及references含resistor/button/capacitor，pins.top/bottom为核实的物理脚号；nets为supply/ground/signal | [代码](../../assets/drawing-patterns/reset-rc.mjs)／[图](../../assets/drawing-patterns/reset-rc.png) |
| pullup-button | parts及references含resistor/button，pins.top/bottom；nets为supply/ground/signal；不添加RC，消抖和输入容限由方案确认 | [代码](../../assets/drawing-patterns/pullup-button.mjs)／[图](../../assets/drawing-patterns/pullup-button.png) |

均与geometry.mjs一起复制。返回signal为真实reference/pin、reservedBounds为预留估计，connect完成内部接线；位号由主入口分配。

```text
 电源             电源
  │                │
 上拉             上拉
  │                │
  ●──●── EN        ●── BOOT
  │  │             │
 按键 电容         按键
  │  │             │
 GND GND          GND
```

- 电阻、节点、按键沿竖轴，电容在节点右下方且信号在上、地在下；EN水平引出，地符号默认向下。避免横放按键加长回绕线，或把RC外围分散成孤立标签支路。
- RESET/EN与BOOT并排时，电源、上拉、节点、按键和地尽量成行；不为对齐改网络或型号。位号/数值水平，避开导线、触点和标签。
- 四脚按键先核实内部触点和旋转后的真实pin；示例top/bottom不代表通用物理脚序，不能互换脚号来套布局。电容值、充放电时序、启动采样及配置来自实际芯片要求。

共用栅格、两阶段调用和预览约定见 [画法索引](../drawing-patterns.md)；读取器选择任一画法只返回本说明一次，仍分别返回选中的代码和图片。

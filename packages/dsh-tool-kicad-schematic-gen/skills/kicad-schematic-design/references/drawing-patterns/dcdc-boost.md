# 异步 Boost 升压

适用于已核实内部低侧开关、外接整流二极管和输出反馈分压的异步 Boost。参考 [代码](../../assets/drawing-patterns/dcdc-boost.mjs) 与 [实际生成图](../../assets/drawing-patterns/dcdc-boost.png)。

顶部主功率流从左到右：VIN → 电感 → SW 节点 → 二极管 → VOUT。二极管阳极接 SW、阴极接 VOUT；控制器放在电感下方，输入电容在左，输出电容和反馈分压在右。反馈中点与控制器 FB 使用同一独立网络标签；SW 与 VOUT 必须分开。

维护示例使用官方 KiCad TPS61040DBV 符号：5 VIN、4 EN、2 GND、1 SW、3 FB。示例将 EN 接 VIN；使用前必须确认 `boostTopologyConfirmed: true` 和 `enableToVinConfirmed: true`。电气依据：[TI TPS61040 数据手册](https://www.ti.com/lit/ds/symlink/tps61040.pdf)（查阅于 2026-10-26）。

`parts` 包含 controller（pins: vin/sw/gnd/fb/en）、inductor、diode（left/right，其中二极管 left=阳极、right=阴极）、inputCapacitor、outputCapacitor（top/bottom）、feedback.upper/lower（top/bottom）；`references` 使用对应键。`nets` 包含 input、output、ground、feedback，feedback 必须是本转换器独立的网络名。

复制此单元时同时复制 geometry.mjs 和 dcdc-geometry.mjs。遵循统一 place/connect 接口和 50 mil 栅格，按真实符号角色映射调整方向，不能互换物理引脚套图。

图中 L_SEL、D_SEL、C_IN、C_OUT、R_HIGH、R_LOW 是待设计参数，电压标签仅演示布局，不构成完整 BOM。正式方案按手册核实输入范围、输出电流、纹波、电感饱和电流、二极管额定值、电容容量/ESR、反馈比例、环路稳定性和散热。实际器件要求的补偿、前馈、去耦、软启动或其他外围应另行补全。本画法不直接适用同步 Boost、Buck-Boost 或隔离拓扑；PCB 开关电流环路仍需单独设计。

布局默认采用紧凑间距：反馈上下电阻中心相距 17.78 mm，主功率支路及输入输出电容靠近所属节点，地母线在最低器件引脚下方 5.08 mm。长型号或更大符号需要按实际边界增大间距，保持属性和网络标签清晰。

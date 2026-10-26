# USB Type-C USB 2.0 设备端接口

[参考代码](../../assets/drawing-patterns/usb-c-device.mjs) · [实际 KiCad 预览](../../assets/drawing-patterns/usb-c-device.png)

仅演示 USB 2.0 UFP/sink 插座基础接法：CC1、CC2 各自经独立 5.1kΩ 下拉接地；A6/B6 合并为 D+，A7/B7 合并为 D−，两组保持分离。多个 VBUS/GND 脚在官方符号中为叠放引脚，必须保留完整引脚定义。

调用时传入 `ufpSinkConfirmed: true`、`shieldToGroundConfirmed: true`；本例明确选择屏蔽壳直连地。若产品采用机壳地、RC 耦合等策略，需要单独调整。两个 Rd 不能共用，CC1 和 CC2 不能短接。

`parts.connector.pins` 包含 vbus/ground/dp/dm 数组、cc1、cc2、shield、unused；parts.rd 为两个电阻（top/bottom），references.connector 和 references.rd 分配位号。nets 包含 vbus、ground、cc1、cc2、dp、dm，并保持 CC 与数据网络名各自独立。

本例使用 USB_C_Receptacle_USB2.0_16P：CC1=A5、CC2=B5、D+=A6/B6、D−=A7/B7，SBU1/A8 和 SBU2/B8 标 NC。正式器件需核实封装焊盘与叠放脚映射。本例不包含完整 ESD/过流/反灌保护、VBUS 检测和 USB PHY；按器件及系统要求补全。ESD 器件靠接口、数据线保持差分布线，串联电阻是否需要由 PHY 手册决定。

此画法不适用于主机/source、DRP、PD 协商或 USB 3.x；固定 Rd 不代表可以任意取用供电电流。依据：[Microchip CC 电阻说明](https://onlinedocs.microchip.com/oxy/GUID-DAF68E19-EB64-4E93-83DB-9E883647B776-en-US-1/GUID-02E3AD6F-2676-4B83-9D2E-31D93E162FA3.html)。

所有单元沿用 `place({region, at, parts, references, nets, ...})`，返回 reservedBounds、ports 和 connect()。先放置，再由主入口统一 connect；电源标签最后按现有流程转成官方电源符号。复制 geometry.mjs；MOSFET 单元还需 dcdc-geometry.mjs。保留 50 mil 栅格，长型号按实际属性边界加大空间，不能互换物理引脚以适配画法。

维护生成器为 generate-systems.mjs，使用固定官方参考符号并先保存维护方案。参考图只验证画法和连接，不能替代真实器件选型、完整电气设计及 PCB 验证。来源查阅日期：2026-10-26。

# N-MOSFET 低侧感性负载开关

[参考代码](../../assets/drawing-patterns/mosfet-low-side.mjs) · [实际 KiCad 预览](../../assets/drawing-patterns/mosfet-low-side.png)

控制输入经栅极串联电阻进入 G，G 对地加下拉；S 接地，D 接负载低端，负载高端接电源。续流二极管跨接负载：阴极接正电源，阳极接 D。负载接头位于上方，驱动在左、续流支路在右。

传入 `inductiveLoadConfirmed: true` 表示已核实本例的感性负载与续流接法。纯阻性负载可定制移除续流支路；要求快速释放的线圈可能需要其他钳位方案，不能默认照搬普通二极管。

`parts` 包含 mosfet（gate/drain/source）、load（supply/low）、gateResistor（left/right）、pulldown（top/bottom）、diode（cathode/anode）；references 使用相同键。nets 为 supply、ground、control、loadLow。横向栅极电阻采用与 DC-DC 共用的水平属性布局。

维护图使用官方通用 Q_NMOS，G/D/S 是角色标识，不是可直接交付的器件物理脚号。正式项目必须换成真实导入模型并核实封装引脚。NMOS_SEL、R_GATE、R_PD、D_SEL 均需选型：核实实际驱动电压下的 RDS(on)、VDS/VGS 额定值、栅电荷、负载电流、SOA、散热及二极管的反向电压和续流能力；逻辑地与负载回流也需规划。

续流与释放速度的取舍参见 [TI 感性负载退磁说明](https://www.ti.com/document-viewer/lit/html/snvaa45)。

所有单元沿用 `place({region, at, parts, references, nets, ...})`，返回 reservedBounds、ports 和 connect()。先放置，再由主入口统一 connect；电源标签最后按现有流程转成官方电源符号。复制 geometry.mjs；MOSFET 单元还需 dcdc-geometry.mjs。保留 50 mil 栅格，长型号按实际属性边界加大空间，不能互换物理引脚以适配画法。

维护生成器为 generate-systems.mjs，使用固定官方参考符号并先保存维护方案。参考图只验证画法和连接，不能替代真实器件选型、完整电气设计及 PCB 验证。来源查阅日期：2026-10-26。

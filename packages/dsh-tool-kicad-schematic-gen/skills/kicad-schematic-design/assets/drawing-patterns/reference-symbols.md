# 参考符号来源与风格约定

`reference-symbols.kicad_sym` 固定使用 KiCad 官方 kicad-symbols 9.0.0 的未改写符号定义，保留继承所需的父定义。只组合到一个离线维护库，不重新手画电容、开关、电源或 GND，不修改符号几何和物理引脚。原有范例同样使用 KiCad 标准符号风格。

包含 Device:R/C/Crystal、Switch:SW_Push、power:GND/+3V3/+5V、Regulator_Linear:AMS1117-3.3 及其 AP1117-15 父定义。维护代码按真实物理脚号使用 AMS1117：3=VIN、2=VOUT、1=GND。实际生产器件仍以精确型号、手册、封装及导入模型为准。

## 上游与校验

查询日期：2026-10-26。以下哈希针对完整上游源文件，库内仅摘录所列定义。

- [Device.kicad_sym](https://gitlab.com/kicad/libraries/kicad-symbols/-/raw/9.0.0/Device.kicad_sym)：SHA-256 `972f851ebf7c10dfe97eefd5d847406154b18ee6158013bd19165477d6364abd`。
- [Switch.kicad_sym](https://gitlab.com/kicad/libraries/kicad-symbols/-/raw/9.0.0/Switch.kicad_sym)：SHA-256 `a93607f7bb68bce50996f458d7be86e1e187ac661877548a5119f8b890748fef`。
- [power.kicad_sym](https://gitlab.com/kicad/libraries/kicad-symbols/-/raw/9.0.0/power.kicad_sym)：SHA-256 `541c49bdad55134b5f6379e80c6d18f165c1d9e98ca7df36ad6ec2a316a6d11b`。
- [Regulator_Linear.kicad_sym](https://gitlab.com/kicad/libraries/kicad-symbols/-/raw/9.0.0/Regulator_Linear.kicad_sym)：SHA-256 `c6d132304523affbe7eac675d586d52951ea306ef85dacd7d8a3a2ce3b0f8814`。

符号子集采用上游 [KiCad Libraries License](LICENSE.kicad-symbols.md)，即 CC BY-SA 4.0 及其设计文件例外；署名归 KiCad Libraries / KiCad community。上游符号本身未改写，本目录的新布局脚本负责器件位置、属性及线路。

## 代码与图片约定

所有局部单元沿用 `place({region, at, parts, references, nets, ...})`，返回 `reservedBounds`、`ports`、`connect()`；共用 geometry.mjs 和两阶段 place/connect。示例使用两空格缩进、标准 import/解构空格和分行条件，不把拓扑写成压缩的一行。

所有效果图由对应脚本保存真实 KiCad 原理图，再用同一个 render.mjs 导出 SVG、按统一 12 px/mm 栅格化；背景、颜色、字体、线型由同一 KiCad 导出器决定。电源上箭头、GND 下三角、器件符号和位号/数值位置保持同一约定。图中 RC/电容等参数仅供文字布局演示，不代表通用取值建议。

正式模型的角度、引脚角色或尺寸不符合范例时调整布局并复核；不能为套图互换物理引脚。

DC-DC 另采用 [Regulator_Switching.kicad_sym](https://gitlab.com/kicad/libraries/kicad-symbols/-/raw/9.0.0/Regulator_Switching.kicad_sym)，SHA-256 `33b2bb318421f55821bdd7ac322fffdd878a3cfd086e7f9773165e5144845397`。子集保留 LM2596S-ADJ、TPS61040DBV 及其继承父符号，并包含 Device 的电感和肖特基二极管及其父符号；定义未改写。

## MCU 与接口补充符号

- [MCU_ST_STM32F0.kicad_sym](https://gitlab.com/kicad/libraries/kicad-symbols/-/raw/9.0.0/MCU_ST_STM32F0.kicad_sym)：SHA-256 `749a362b52e85de40e87cf286e6676437470012ca7644b45e8e3838f017b70bd`。
- [Connector.kicad_sym](https://gitlab.com/kicad/libraries/kicad-symbols/-/raw/9.0.0/Connector.kicad_sym)：SHA-256 `f3820e341582909b9489769c3b32dcf613e205057a8b2b66f889cdb0b1b0473a`。
- [Connector_Generic.kicad_sym](https://gitlab.com/kicad/libraries/kicad-symbols/-/raw/9.0.0/Connector_Generic.kicad_sym)：SHA-256 `c44a0a561694b37a58027539b4e215067f64b5789cd7855bc001890dc484d51b`。

新增 STM32F030F4Px、USB_C_Receptacle_USB2.0_16P、Conn_01x05、Conn_01x02，并从已有 Device 库加入 Q_NMOS。保持官方定义未改写；Q_NMOS 的字母脚号只用于拓扑画法，正式交付使用实际器件物理脚号。

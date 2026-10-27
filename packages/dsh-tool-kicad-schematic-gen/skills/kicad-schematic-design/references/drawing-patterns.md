# 局部电路画法

新增局部电路或排列标签时，按下表选已确认拓扑。首次采用该画法，须在编写局部脚本前读完整代码、直接依赖及一张对应参考图；同项目同版本已读内容沿用，不每轮重复读取。已有清楚布局的复用模块保持原图。

## 选定后直接读取

```text
node <patternReaderPath> usb-c-device reset-rc
```

patternReaderPath 由技能运行时提供，对应 [read-patterns.mjs](../scripts/read-patterns.mjs)。默认返回所选说明、完整源码与去重后的依赖内容，含绝对路径；再逐个用 read_image 读取 readImagesNext 中尚未看过的PNG。入口只读资源，不执行代码、不生成工程，也不会自动把图片传给模型。只列ID用 `--list`，不代表已经读取内容。输出被截断时按画法分批读，不假称完整阅读。图片确实缺失或读图工具失败时记录具体原因，依据代码和实际预览继续，不伪称已看图。

用一行记录“本次局部电路→画法ID→实际器件/引脚适配”，放现有方案或脚本即可，不另建审计表。拓扑和符号兼容时复制所选电路代码及依赖，调用 place/connect；标签直接用运行时 attachPinLabels，无需复制可选封装。需要自定义时记录具体差异并沿用已读布局原则。库接口帮助组织文件和绘图，不能代替这些局部代码与图片。参考符号文件仅提供符号，也不能算已采用画法。

常用ID：usb-c-device、ldo-three-pin、ldo-fixed-on、reset-rc、pullup-button、decoupling-bank、led-power-indicator、label-sides、label-vertical；其它ID与下表代码文件名一致。reset-rc/pullup-button 自动附复位与启动布局说明。MCU例子绑定STM32F030，ESP32等其它芯片应选适用外围单元，不直接照搬整套系统。无匹配画法时按方案自定义，说明缺口，不读取无关范例。

## 画法选择

| 画法 | 适用条件 | 说明与参考代码 |
| --- | --- | --- |
| MCU 最小系统（内部 RC） | 按对应文档核实器件、模式与接口脚序 | [说明](drawing-patterns/mcu-minimum.md) · [代码](../assets/drawing-patterns/mcu-minimum.mjs) |
| MCU 最小系统（外部晶振） | 已确认外部无源晶体、负载电容与振荡引脚 | [说明](drawing-patterns/mcu-external-crystal.md) · [代码](../assets/drawing-patterns/mcu-external-crystal.mjs) |
| USB Type-C USB 2.0 设备端接口 | 按对应文档核实器件、模式与接口脚序 | [说明](drawing-patterns/usb-c-device.md) · [代码](../assets/drawing-patterns/usb-c-device.mjs) |
| N-MOSFET 低侧感性负载开关 | 按对应文档核实器件、模式与接口脚序 | [说明](drawing-patterns/mosfet-low-side.md) · [代码](../assets/drawing-patterns/mosfet-low-side.mjs) |
| 五针 SWD 调试排针 | 按对应文档核实器件、模式与接口脚序 | [说明](drawing-patterns/swd-header.md) · [代码](../assets/drawing-patterns/swd-header.mjs) |
| 电源指示 LED | 已确定电源经限流电阻、LED 接地 | [LED](drawing-patterns/led-power-indicator.md) · [代码](../assets/drawing-patterns/led-power-indicator.mjs) |
| 上拉按键 | 已确定上拉、按下接地的有效低输入 | [按键](drawing-patterns/pullup-button.md) · [代码](../assets/drawing-patterns/pullup-button.mjs) |
| 复位/使能 RC 与启动支路 | 按已确认接法区分带电容复位与普通 BOOT | [布局与现有代码用法](drawing-patterns/reset-enable.md) · [RC 代码](../assets/drawing-patterns/reset-rc.mjs) |
| 去耦电容组 | 已确定同一电源域各电容并联接地 | [电容组](drawing-patterns/decoupling-bank.md) · [代码](../assets/drawing-patterns/decoupling-bank.mjs) |
| 三脚固定输出 LDO | 适用于已核实 VIN/VOUT/GND 三种引脚角色、没有 EN 的固定输出稳压器 | [说明](drawing-patterns/ldo-three-pin.md) · [代码](../assets/drawing-patterns/ldo-three-pin.mjs) |
| 复位/使能 RC | 仅适用于已核实的有效低信号、上拉电阻、对地按键和对地电容 | [说明](drawing-patterns/reset-rc.md) · [代码](../assets/drawing-patterns/reset-rc.mjs) |
| I²C 双线上拉 | 仅适用于已核实的同一电压域 SDA/SCL 上拉 | [说明](drawing-patterns/i2c-pullups.md) · [代码](../assets/drawing-patterns/i2c-pullups.mjs) |
| 无源晶振与负载电容 | 仅适用于芯片确认使用外部无源晶振、且需要外部负载电容的接法 | [说明](drawing-patterns/crystal-load.md) · [代码](../assets/drawing-patterns/crystal-load.mjs) |
| 异步 Buck 降压 | 已核实异步拓扑、使能接法及外部反馈 | [说明](drawing-patterns/dcdc-buck.md) · [代码](../assets/drawing-patterns/dcdc-buck.mjs) |
| 异步 Boost 升压 | 已核实异步拓扑、使能接法及外部反馈 | [说明](drawing-patterns/dcdc-boost.md) · [代码](../assets/drawing-patterns/dcdc-boost.mjs) |
| LDO 与输入/输出电容 | 已确认固定输出、EN 接 VIN，左右各两个电容 | [LDO](drawing-patterns/ldo-fixed-on.md) · [代码](../assets/drawing-patterns/ldo-fixed-on.mjs) |

信号标签按侧排列用 [标签对齐](drawing-patterns/label-alignment.md)，不需要读取无关拓扑。

## 调用约定

这些是可复制的 ESM 范例，不是新工具或 builder 公共 API。复制所选 mjs 与共用的 [geometry.mjs](../assets/drawing-patterns/geometry.mjs) 到项目同一目录，从功能模块中 import `place`。

```js
const led = place({ region, at: [10, 12], parts,
  references: { resistor: 'R7', led: 'D1' },
  nets: { supply: '+3V3', ground: 'GND' } });
// 所有单元放置完成后，由主入口统一调用。
led.connect();
```

`parts` 使用实际导入器件的 `{libraryPath,libId,footprint,value,angle,pins}`；footprint 对应导入返回的 footprintId。pins 是经核实、在所选 angle 下成立的角色映射，具体见单元说明。代码使用真实 pin 坐标，并检查竖向排列，不支持的符号方向直接报错；按真实模型调整 angle/位置，不能为套画法互换物理引脚。示例自带的本地符号仅为可复现演示，不替代项目器件搜索、导入与封装交付。

编号由主入口分配。at 是 region 内的局部内容原点，需避开标题。返回 `ports`（reference/pin）、`reservedBounds`（局部预留范围）、`connect()`；预留范围不是测量结果，长型号或不同尺寸符号需增大间距与区域。单元不创建框或保存文件；同一单元 connect 只调用一次。

## 组合与检查

局部单元置于所属功能框内，共享位号并统一 connect，不各自建框/保存。电源与地最后按 [电源流程](power-symbols.md) 转换；分支显式 junction。参数和网络来自实际方案，不照抄示例数值或互换物理脚号。LDO 输入/输出电容及其它外围靠近所属引脚，不用通用电容组替代芯片外围布局。

reservedBounds 是预留估计，不是实际测量或自动装箱；长型号和不同符号尺寸需扩大空间。拓扑不匹配则定制画法，不强套范例。预览与停止条件统一按 [布局交付](layout-delivery.md)。

仅维护随包参考代码或图片时读取 [维护说明](drawing-patterns/maintenance.md)。正常生成不加载维护生成器。DC-DC 单元还依赖 dcdc-geometry.mjs，复制时与 geometry.mjs 一并保留。

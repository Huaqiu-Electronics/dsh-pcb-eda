# 局部电路画法

新增 LED、按键、去耦支路或安排信号标签时，按下表选择已确认拓扑对应的范例。只读所需代码；不熟悉效果时再看图片，不加载全部范例或每轮重复读图。复用模块已有清楚布局时保留原图。

| 画法 | 适用条件 | 说明与参考代码 | 效果 |
| --- | --- | --- | --- |
| MCU 最小系统（内部 RC） | 按对应文档核实器件、模式与接口脚序 | [说明](drawing-patterns/mcu-minimum.md) · [代码](../assets/drawing-patterns/mcu-minimum.mjs) | [图片](../assets/drawing-patterns/mcu-minimum.png) |
| MCU 最小系统（外部晶振） | 已确认外部无源晶体、负载电容与振荡引脚 | [说明](drawing-patterns/mcu-external-crystal.md) · [代码](../assets/drawing-patterns/mcu-external-crystal.mjs) | [图片](../assets/drawing-patterns/mcu-external-crystal.png) |
| USB Type-C USB 2.0 设备端接口 | 按对应文档核实器件、模式与接口脚序 | [说明](drawing-patterns/usb-c-device.md) · [代码](../assets/drawing-patterns/usb-c-device.mjs) | [图片](../assets/drawing-patterns/usb-c-device.png) |
| N-MOSFET 低侧感性负载开关 | 按对应文档核实器件、模式与接口脚序 | [说明](drawing-patterns/mosfet-low-side.md) · [代码](../assets/drawing-patterns/mosfet-low-side.mjs) | [图片](../assets/drawing-patterns/mosfet-low-side.png) |
| 五针 SWD 调试排针 | 按对应文档核实器件、模式与接口脚序 | [说明](drawing-patterns/swd-header.md) · [代码](../assets/drawing-patterns/swd-header.mjs) | [图片](../assets/drawing-patterns/swd-header.png) |
| 电源指示 LED | 已确定电源经限流电阻、LED 接地 | [LED](drawing-patterns/led-power-indicator.md) · [代码](../assets/drawing-patterns/led-power-indicator.mjs) | [图片](../assets/drawing-patterns/led-power-indicator.png) |
| 上拉按键 | 已确定上拉、按下接地的有效低输入 | [按键](drawing-patterns/pullup-button.md) · [代码](../assets/drawing-patterns/pullup-button.mjs) | [图片](../assets/drawing-patterns/pullup-button.png) |
| 复位/使能 RC 与启动支路 | 按已确认接法区分带电容复位与普通 BOOT | [布局与现有代码用法](drawing-patterns/reset-enable.md) · [RC 代码](../assets/drawing-patterns/reset-rc.mjs) | 文档内通用示意，不绑定芯片型号或取值 |
| 去耦电容组 | 已确定同一电源域各电容并联接地 | [电容组](drawing-patterns/decoupling-bank.md) · [代码](../assets/drawing-patterns/decoupling-bank.mjs) | [图片](../assets/drawing-patterns/decoupling-bank.png) |
| 三脚固定输出 LDO | 适用于已核实 VIN/VOUT/GND 三种引脚角色、没有 EN 的固定输出稳压器 | [说明](drawing-patterns/ldo-three-pin.md) · [代码](../assets/drawing-patterns/ldo-three-pin.mjs) | [图片](../assets/drawing-patterns/ldo-three-pin.png) |
| 复位/使能 RC | 仅适用于已核实的有效低信号、上拉电阻、对地按键和对地电容 | [说明](drawing-patterns/reset-rc.md) · [代码](../assets/drawing-patterns/reset-rc.mjs) | [图片](../assets/drawing-patterns/reset-rc.png) |
| I²C 双线上拉 | 仅适用于已核实的同一电压域 SDA/SCL 上拉 | [说明](drawing-patterns/i2c-pullups.md) · [代码](../assets/drawing-patterns/i2c-pullups.mjs) | [图片](../assets/drawing-patterns/i2c-pullups.png) |
| 无源晶振与负载电容 | 仅适用于芯片确认使用外部无源晶振、且需要外部负载电容的接法 | [说明](drawing-patterns/crystal-load.md) · [代码](../assets/drawing-patterns/crystal-load.mjs) | [图片](../assets/drawing-patterns/crystal-load.png) |
| 异步 Buck 降压 | 已核实异步拓扑、使能接法及外部反馈 | [说明](drawing-patterns/dcdc-buck.md) · [代码](../assets/drawing-patterns/dcdc-buck.mjs) | [图片](../assets/drawing-patterns/dcdc-buck.png) |
| 异步 Boost 升压 | 已核实异步拓扑、使能接法及外部反馈 | [说明](drawing-patterns/dcdc-boost.md) · [代码](../assets/drawing-patterns/dcdc-boost.mjs) | [图片](../assets/drawing-patterns/dcdc-boost.png) |
| LDO 与输入/输出电容 | 已确认固定输出、EN 接 VIN，左右各两个电容 | [LDO](drawing-patterns/ldo-fixed-on.md) · [代码](../assets/drawing-patterns/ldo-fixed-on.mjs) | [图片](../assets/drawing-patterns/ldo-fixed-on.png) |

左右/上下信号标签：[说明与短代码](drawing-patterns/label-alignment.md)。视觉目标使用用户提供的 [左右图](../assets/drawing-patterns/reference-label-sides.png) 和 [上下图](../assets/drawing-patterns/reference-label-vertical.png)；对应实现效果见 [左右生成图](../assets/drawing-patterns/label-sides.png)、[上下生成图](../assets/drawing-patterns/label-vertical.png)。同侧按组调用 attachPinLabels，不采用随机长短引线。

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

供电和地先用网络标签交给主入口，最后按现有电源流程统一转换标准电源符号。内部优先短直接连线，跨单元按实际可读性选导线或标签。避免直接照抄范例中的电阻值、电容值及网络名；LED 驱动方式、复位/启动配置、LDO 使能与稳定性条件需另行确认，特定画法不代表通用电气模板。LDO 优先把输入电容画在 VIN 旁、输出电容画在 VOUT 旁，用母线直接连接；通用去耦组不替代所属器件的外围布局。

## 布局与检查

先在功能模块内组合局部单元，再安排整页；不同单元留出属性和标签空间，不给每个小支路套框。当前 region 仍需预先规划 origin/size，根据 reservedBounds 和真实预览调整，不具备自动装箱能力。直接相接的分支显式标 junction，保持水平文字、统一属性位置和正交线段。

按 [布局修复与交付停止条件](layout-delivery.md) 集中修正明确遮挡、越框和无法辨认的问题；简单项目首版后默认只做一次集中布局修复，达标即交付，额外修复要有具体阻塞缺陷。轻微不对称或可读文字的偏移偏好不触发重建。预览只说明表达效果，不代表电气或 PCB 验证。若符号尺寸/拓扑明显不匹配，保留相同可读性原则并定制绘图，不强套范例。

维护参考图时设置运行时提供的 KICAD_SYMBOL_DIR / KICAD_CLI_PATH，先运行 [generate.mjs](../assets/drawing-patterns/generate.mjs) 生成唯一输出目录，再运行 [render.mjs](../assets/drawing-patterns/render.mjs) 将对应代码的实际图纸导出为 PNG：

```text
node <assets>/drawing-patterns/generate.mjs <唯一输出目录>
node <assets>/drawing-patterns/render.mjs <唯一输出目录> <assets>/drawing-patterns
```

这两个脚本仅供维护参考资源；正常设计继续用现有预览工具，不复制维护渲染器。共享初始化只在维护脚本中，不复制到每个单元。

补充范例的维护生成器：[generate-supplement.mjs](../assets/drawing-patterns/generate-supplement.mjs)，使用随包固定的 KiCad 官方参考符号子集并先保存维护方案，不依赖系统标准符号库。执行 `node <assets>/drawing-patterns/generate-supplement.mjs <唯一输出目录>`，再执行 `node <assets>/drawing-patterns/render.mjs <唯一输出目录> <assets>/drawing-patterns --supplement` 生成对应四张图片。参考模型和示例参数仅用于验证画法，正式项目仍从真实导入模型建立 pin 角色。

风格与来源统一见 [参考符号来源与风格约定](../assets/drawing-patterns/reference-symbols.md)。新增代码和原有代码共用 geometry.mjs、place/connect 接口与渲染器；避免另外手画简化符号导致参考图外观不一致。

DC-DC 维护生成使用 `generate-supplement.mjs <唯一输出目录> --dcdc`，渲染使用 `render.mjs <唯一输出目录> <assets>/drawing-patterns --dcdc`。复制 DC-DC 单元时同时复制 dcdc-geometry.mjs 和 geometry.mjs。

MCU、Type-C、MOSFET 与 SWD 范例维护：执行 [generate-systems.mjs](../assets/drawing-patterns/generate-systems.mjs) `<唯一输出目录>`，再用 render.mjs `<唯一输出目录> <assets>/drawing-patterns --systems` 生成五张实际图片。各单元参数和模式限制见对应说明。

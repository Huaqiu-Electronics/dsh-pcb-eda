# 参考画法维护

仅修改或重新生成随包参考资源时读取；正常电路设计不执行这些命令。生成输出使用工作区，核对图片后再显式更新资源。

维护参考图时设置运行时提供的 KICAD_SYMBOL_DIR / KICAD_CLI_PATH，先运行 [generate.mjs](../../assets/drawing-patterns/generate.mjs) 生成唯一输出目录，再运行 [render.mjs](../../assets/drawing-patterns/render.mjs) 将对应代码的实际图纸导出为 PNG：

```text
node <assets>/drawing-patterns/generate.mjs <唯一输出目录>
node <assets>/drawing-patterns/render.mjs <唯一输出目录> <工作区PNG输出目录>
```

这两个脚本仅供维护参考资源；正常设计继续用现有预览工具，不复制维护渲染器。下面各渲染命令的 PNG 输出同样使用工作区目录，不写插件安装目录。共享初始化只在维护脚本中，不复制到每个单元。

补充范例的维护生成器：[generate-supplement.mjs](../../assets/drawing-patterns/generate-supplement.mjs)，使用随包固定的 KiCad 官方参考符号子集并先保存维护方案，不依赖系统标准符号库。执行 `node <assets>/drawing-patterns/generate-supplement.mjs <唯一输出目录>`，再执行 `node <assets>/drawing-patterns/render.mjs <唯一输出目录> <工作区PNG输出目录> --supplement` 生成对应四张图片。参考模型和示例参数仅用于验证画法，正式项目仍从真实导入模型建立 pin 角色。

风格与来源统一见 [参考符号来源与风格约定](../../assets/drawing-patterns/reference-symbols.md)。新增代码和原有代码共用 geometry.mjs、place/connect 接口与渲染器；避免另外手画简化符号导致参考图外观不一致。

DC-DC 维护生成使用 `generate-supplement.mjs <唯一输出目录> --dcdc`，渲染使用 `render.mjs <唯一输出目录> <工作区PNG输出目录> --dcdc`。复制 DC-DC 单元时同时复制 dcdc-geometry.mjs 和 geometry.mjs。

MCU、Type-C、MOSFET 与 SWD 范例维护：执行 [generate-systems.mjs](../../assets/drawing-patterns/generate-systems.mjs) `<唯一输出目录>`，再用 render.mjs `<唯一输出目录> <工作区PNG输出目录> --systems` 生成五张实际图片。各单元参数和模式限制见对应说明。

# 按功能框拆分生成脚本

一个模块对应一个功能框，所有模块写入主入口创建的同一个 Schematic。模块文件是模型编写电路的组织方式；实际连接、器件和布局仍由模型设计。

```text
scripts/
├─ design.mjs             # 页面、布局表、公共引用编号、跨模块连接、保存
├─ modules/
│  ├─ power.mjs
│  ├─ mcu.mjs
│  └─ buttons-buzzer.mjs
└─ shared/parts.mjs       # 工具返回或本地库确认的符号路径、libId、引脚编号
```

## 调用与坐标

模块导出 `place({region, parts, allocateReference, nets, bounds})`，放置全部内部器件并返回 `{ports, bounds, connect}`。`ports` 使用 `{reference, pin}` 表示真实实例引脚；不猜测端口坐标。`connect()` 只负责内部布线、标签和标记。主入口先完成所有 place，再调用所有 connect，最后用 sch.pin / sch.wire 全局坐标连接模块。模块内部用 region.pin / region.wire 相对坐标；不要混用全局点和局部点。

主入口预建 region，名称、说明、origin、size 集中放在布局表。bounds 返回同一布局表中的 origin/size，表示预留区域，不重新扫描电路计算包围框。改变某个 origin 并重跑可以整体移动该框及内部电路。使用明确网络标签时，主入口给两端传入同一网络名；同页局部标签也会互连，内部网络必须用模块前缀避免意外合并。跨区导线在主入口显式规划正交折点。

编号分配器仅由主入口创建一次，模块间共享。范例按稳定模块顺序分配 R1/R2；设计开始反复迭代后，把已分配的角色到编号写入共用表，添加器件时只分配新编号，避免新增模块改变已有编号。多 unit 器件分配一次引用，各 unit 复用；不要由每个模块从 R1/U1 重新计数。

## 可运行范例

复制 [modular-design](../assets/modular-design/design.mjs) 所在整个目录到项目的 scripts/。范例含两个电阻功能框，展示统一引用、分两阶段生成、模块端口和主入口跨区连线。它是接口示例，实际工程须替换器件、网络和布局。范例采用本机 Device:R 与现有 builder.js，不需要新增模型工具。

```powershell
node <设计目录>/scripts/design.mjs <设计目录>/.candidate/<唯一run-id>
```

模块自身不保存单独的 .kicad_sch，也不拼接多个文件的符号缓存或 UUID；由共用 Schematic 统一处理。入口一次生成整图，脚本拆分主要减少模型读取和局部修改的范围，不提供增量文件生成或自动布线。

## 局部修改

只改对应模块的器件、内部连接或布局表的该区域。重新运行入口并查看工具返回的对应区域预览；必要时查看跨区连接，交付前查看全图。不要每次重新阅读全部模块、重写符号解析器、生成端点审计脚本或创建 revN 工程。编辑文件查询外框时用 `types:["rectangle"]`，region/frame 是生成接口概念，不是可查询对象类型。

## 功能框内的小电路

LED、按键、去耦等可组合 [局部画法](drawing-patterns.md) 到同一个功能模块，不为每条支路新建 region。其 reservedBounds 是 region 内的预留范围，与本页功能模块的 bounds 布局表不是同一字段；不能当作精确测量或自动打包结果。主入口分配位号，模块内调用各单元 place，统一 connect；跨单元通过真实 ports 或已确认网络连接。先留出属性和标签空间，再依据实际预览调整区域大小。

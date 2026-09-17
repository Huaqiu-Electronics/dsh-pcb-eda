---
name: kicad-ipc
description: "通过 KiCad IPC API 和官方 kicad-python 在打开的 PCB 中检查、新建、修改或删除对象；适用于 PCB 自动化、外部布线结果导入和插件开发，不用于直接编辑 .kicad_pcb 文件。"
---

# KiCad IPC PCB

使用 KiCad 的 IPC API 与 `kicad-python` 作为 PCB 读写的默认且优先接口。目标是让 KiCad 自己维护对象、UUID、连通性、撤销历史和磁盘保存；不要把 `.kicad_pcb` 当作可直接改写的中间格式。

## 本技能与工具的配合

安装 `@huaqiu/dsh-kicad` 后，本技能与下面这些工具一起可用，无需单独安装技能。

工具是**可执行接口**：它们负责连接 KiCad、传参、提交事务并把 KiCad 的返回原样带回来。本技能是**操作准则**：什么时候该用、先读什么、如何验证、什么时候必须停下来问用户。

| 工具 | 作用 |
| --- | --- |
| `kicad_ipc_diagnose` | 只读：检查连接、API 版本和当前 PCB。任何 KiCad 操作前先跑它。 |
| `kicad_ipc_verify_live` | 在一个被 drop 的事务里跑完整 CRUD 冒烟测试，不落盘。 |
| `kicad_pcb_create_track` / `create_via` / `create_copper_zone` | 在**已存在的网络**上新建走线、过孔、未填充铜区。 |
| `kicad_pcb_add_footprint_from_template` | 克隆板上已有封装作为模板，新增一个封装。 |
| `kicad_pcb_move_rotate_footprint` | 按 reference 移动/旋转一个封装。 |
| `kicad_pcb_update_selected_track_width` | 改当前选中走线的线宽。 |
| `kicad_pcb_refill_zones` | 等待铺铜填充完成。 |
| `kicad_pcb_remove_selected_items` | 删除当前选中对象（必须显式 `confirm`）。 |

工具的返回信封统一为 `{ ok, script, effect, output }` 或 `{ ok, error: { kind, message } }`。`effect` 说明该操作对板子做了什么：`read` 只读、`probe` 改了但事务被丢弃、`mutate` 已提交。

**工具返回 `ok: true` 不等于改动已达成用户意图。** 每次重要改动后仍要重新读取受影响的状态确认（见下文的“读取 → 校验 → 变更 → 验证 → 保存”）。

需要工具没覆盖的操作时，读取并复制 [scripts/](scripts/) 内的模板改参数运行；本目录下的脚本就是这些工具的实现。

## 基本边界

- 不要直接解析后改写、拼接或格式化 `.kicad_pcb`（包括把 `get_as_string()` 的结果改后写回）。它只可用于只读诊断或用户明确要求的导出。
- 不要用 `pcbnew` / SWIG API（如 `import pcbnew`、`pcbnew.GetBoard()`、`BOARD.Add()`、`SaveBoard()`）来新建或修改 PCB。它是与 KiCad 内部实现紧耦合的旧接口，KiCad 11 已移除。
- 不要绕过 SDK 直接构造或发送 Protobuf 请求；使用 `kipy` 的公开对象、属性及 `Board` 方法。不要依赖内部 `proto` 字段作为业务接口。
- 不要假定 IPC API 覆盖所有 PCB 功能。仅当缺少所需公开接口时退回 `pcbnew` 作为默认替代方案。
- 任何会删除、覆写、移动大量对象、改变层叠或保存到磁盘的操作，先确定用户给出的精确作用域。禁止用“全部走线”“所有对象”一类模糊范围作默认选择。

## 连接与版本路由

1. 确认目标是 KiCad 9.0+，并使用官方包 `kicad-python`（Python 模块为 `kipy`）。先以 `KiCad()` 连接、调用 `check_version()`，再通过 `get_board()` 取得当前 PCB。
2. KiCad 9/10 只能连接到启用 API 服务的运行中 GUI；由 KiCad 启动的 IPC 插件会提供 `KICAD_API_SOCKET` 和 `KICAD_API_TOKEN`。不要猜测、硬编码或扫描其他 KiCad 实例的连接端点。
3. KiCad 11 可使用 `KiCad(headless=True, file_path=...)` / `kicad-cli api-server` 处理无头任务。此前版本不可把 IPC SDK 当作脱离 GUI 的板文件库。
4. 若 KiCad 已打开但连接不到服务器，先判定不是 GUI 正忙：提示用户在 **偏好设置 → 插件** 中启用 KiCad API 服务，并在变更后重启 PCB Editor，再重新运行脚本。不要扫描命名管道、猜测 token 或以文件编辑替代连接。
5. 在 DSH 中运行外部 KiCad 交互前，确认当前沙盒权限是 **Full Access**。非 Full Access 的沙盒可能禁止访问 KiCad 的 Windows 命名管道，即使 GUI 已打开也无法连接；停止操作并提示用户以 Full Access 重新运行或提升当前任务权限。权限不足不是可重试的连接故障。
6. 在一个任务中只维护一个连接。GUI 正忙时 API 会返回忙或超时：有限次数地重试短暂、幂等的读取；对写入操作，重读对象状态后再决定是否重试，绝不盲目重复。

详细版本差异、连接方式、公开 CRUD 调用和最小代码模式见 [references/ipc-pcb-workflows.md](references/ipc-pcb-workflows.md)。需要可直接改参数运行的常用操作时，读取并复制 [scripts/](scripts/) 内的对应模板；先执行 `diagnose_ipc_connection.py` 排除 API 与 DSH 权限问题。

## PCB 对象工作流

对每一次实际修改，遵守“读取 → 校验 → 变更 → 验证 → 保存”的流程：

1. **读取并定位。** 使用 `get_nets()`、`get_footprints()`、`get_pads()`、`get_tracks()`、`get_vias()`、`get_zones()` 或版本支持时的 `get_items_by_id()`。按网络名、封装 reference、焊盘号、层和位置等稳定语义定位；在写入前重新获取目标对象，保留其 KiCad UUID。
2. **预校验。** 解析并检查单位、坐标、层、线宽/孔径、网络存在性、目标数量及锁定状态。所有长度换算为 SDK 所用的纳米整数（优先 `from_mm()`）；铜对象只能落在启用的铜层上。不要凭空建立网络来掩盖网名不匹配，应先从原理图/网表把网络同步到板中。
3. **成组变更。** 多对象操作以 `begin_commit()` 包裹；成功后 `push_commit(commit, message)`，异常或验证失败则 `drop_commit(commit)`。这样用户在 KiCad 中只看到一个可撤销步骤。
4. **写入。** 用 `create_items()` 新建，用从板上新鲜读取的对象配合 `update_items()` 修改，用 `remove_items()` / `remove_items_by_id()` 删除。`update_items()` 会以传入对象的全部属性更新同 UUID 对象，所以不可用手工重建的简化对象覆盖既有对象。
5. **验证与持久化。** 检索 SDK 返回的创建/更新对象以确认 UUID、数目和被 KiCad 约束后的参数；必要时调用 `refill_zones()` 并运行目标版本有公开接口支持的检查。只有任务要求将改动落盘且用户授权时，调用 `board.save()`；禁止自己写文件。

## 新建和修改时的选择

- 新建走线、圆弧走线和过孔时，实例化相应 `kipy.board_types` 对象，设置公开的 `start` / `end` / `mid` / `position`、`width`、`layer`、`net` 和过孔公开属性，然后将完整对象交给 `create_items()`。使用 `create_items()` 的返回值继续后续操作，不要自行生成 UUID。
- 新建图形、文本、尺寸、区域或封装时，同样使用 SDK 的对应 wrapper 和 `create_items()`；区域创建后按需要在同一事务完成 `refill_zones()`。对于 API 尚不能创建的复杂对象，明确报告能力缺口。
- 修改已有对象时，先按 UUID 或稳定语义重新读取，再只调整所需公开属性，最后批量 `update_items()`。移动或旋转封装使用 `position` 与 `orientation` 的公开属性；不要通过编辑封装/板的 S 表达式来间接修改。
- 当目标版本提供 `Item.clone()` 时，新增与现有封装相同的封装应从用户指定的板上模板封装 `clone()`，设置新的 reference 和位置后交给 `create_items()`。不要复制私有 `proto` 或 UUID。若用户要求“从库直接放置”而 SDK 没有对应公开 API，应报告该能力缺口，而不是读写板文件。
- 新建铜区先校验外形闭合、网络、层和作用域，通过 `create_items()` 创建。铺铜填充使用 `refill_zones()`，并在填充后重新读取区域；填充和保存应由用户明确请求，不能把填充失败用文件编辑掩盖。
- 删除前报告将被删除的精确对象数和选择条件。批量删除自动布线时，只删除用户明确界定的网络、区域或由工具拥有的对象；默认保留用户手工走线。

## 外部 SES 布线结果导入

SES 是外部工具的输入，不是可直接合并进 `.kicad_pcb` 的补丁。始终采用“解析 → 映射 → 校验 → IPC 写入”的路径：

1. 只读解析 SES，转换为内部、单位明确的布线计划：每段包含网络名、起止坐标、层、线宽；每个过孔包含网络名、位置、尺寸、钻孔和层对。保留源记录编号，便于诊断；解析阶段不触碰 PCB。
2. 从当前板通过 IPC 取得网络、焊盘、启用层和既有走线。将 SES 网名映射到现有 `Net`，将层映射到当前板的有效铜层；任何未知网络、无效层、尺寸缺失或单位不确定均停止写入并报告。
3. 先构建所有 `Track` / `ArcTrack` / `Via` wrapper 并进行数量、端点、层与网络完整性校验。必要时先预览计划和替换范围。
4. 只在用户指定的替换范围内，事务性地删除旧的同范围自动布线，再以 `create_items()` 批量创建导入对象。不得调用 `pcbnew.ImportSpecctraSES()`，不得修改板文件文本，也不得把 SES 片段复制进文件。
5. 推送事务后，重新读取相关网络的走线和过孔，比较计划数与实际数；按需填充区域、执行可用的检查，并在需要持久化时调用 `board.save()`。保存失败或验证不通过时保留诊断，不以文件编辑补救。

若任务只是审阅、转换或预览 SES，停在计划阶段，不修改 PCB。

# KiCad IPC PCB 工作流参考

仅在需要实施、调试或审查具体 IPC 脚本时阅读本文件。以目标环境实际安装的 `kicad-python` 文档和版本为准；不要从本参考推断未列出的 API 一定可用。

## 版本与连接

- IPC API 从 KiCad 9.0 起提供。KiCad 9/10 通过运行中 PCB Editor 的 IPC 服务工作；KiCad 11 增加 `kicad-cli` 无头 API 服务。
- `kicad-python` 是官方 Python 绑定，入口是 `from kipy import KiCad`。由 KiCad 启动的插件应让 `KiCad()` 使用它提供的 `KICAD_API_SOCKET` 和 `KICAD_API_TOKEN`；不要自行伪造凭据。
- 首次连接后调用 `kicad.check_version()`。如果失败，停止并报告本机 KiCad 与 Python 包版本不匹配，而不是继续尝试写入。
- 若连接报错而 KiCad GUI 已打开，首先请用户在 **偏好设置 → 插件** 中启用 API 服务，重启 PCB Editor 后再试。KiCad 未启用 API 时，不存在可供脚本连接的服务端；`KICAD_API_SOCKET`、扫描命名管道或重试不能修复此配置。
- 在 DSH 运行时，IPC 客户端需要 **Full Access** 才能访问 KiCad 的 Windows 命名管道。若当前权限不是 Full Access，先请求用户在 DSH 中提升权限或重新在 Full Access 任务中执行；不应把这类权限拒绝描述为 KiCad 未运行或不断重试。

```python
from kipy import KiCad

kicad = KiCad(timeout_ms=5000)
if not kicad.check_version():
    raise RuntimeError("kicad-python 与已连接的 KiCad API 版本不匹配")
board = kicad.get_board()
```

运行任何修改脚本之前，可先执行 [../scripts/diagnose_ipc_connection.py](../scripts/diagnose_ipc_connection.py)。它只诊断 Python 包、连接、版本和打开的 PCB，不会修改或保存板文件。

## 公开 CRUD 速查

| 目标 | 首选调用 | 要点 |
| --- | --- | --- |
| 查询 | `board.get_nets()`、`get_footprints()`、`get_pads()`、`get_tracks()`、`get_vias()`、`get_zones()`、`get_items_by_id()` | 写入前重读目标；按 UUID 或稳定语义定位。 |
| 新建 | `board.create_items(item_or_items)` | 返回由 KiCad 创建的实际对象及其 UUID。 |
| 更新 | `board.update_items(item_or_items)` | 目标必须已存在，按 UUID 匹配；传入的是完整对象状态。 |
| 删除 | `board.remove_items(items)` 或 `remove_items_by_id(ids)` | 只传入已审核的精确范围。 |
| 原子撤销 | `begin_commit()` → 写操作 → `push_commit()`；失败则 `drop_commit()` | 一项用户意图应对应一个 KiCad 撤销步骤。 |
| 保存 | `board.save()` | 仅在任务允许持久化时调用，绝不手写 PCB 文件。 |

`create_items()`、`update_items()` 与 `remove_items()` 来自所有文档编辑器共有的公开命令接口；不要替换为底层 Protobuf 请求。

## 创建一条走线的最小模式

下面示例强调调用形状，坐标和线宽均使用纳米整数。实际任务应先验证目标网络、层、空间、规则与作用域。

```python
from kipy.board_types import BoardLayer, Track
from kipy.geometry import Vector2
from kipy.util import from_mm

nets = {net.name: net for net in board.get_nets()}
net = nets["GND"]  # 缺失时应报错，不要新建替代网络

track = Track()
track.start = Vector2.from_xy(from_mm(10), from_mm(20))
track.end = Vector2.from_xy(from_mm(20), from_mm(20))
track.width = from_mm(0.25)
track.layer = BoardLayer.BL_F_Cu
track.net = net

commit = board.begin_commit()
try:
    created_track, = board.create_items(track)
    # 在此读取 created_track 并验证返回的实际属性
    board.push_commit(commit, "Add GND track")
except Exception:
    board.drop_commit(commit)
    raise
```

创建圆弧走线、过孔、图形、文本、区域和封装遵循同一结构：使用相应的 `kipy.board_types` wrapper，设置公开属性，并通过 `create_items()` 发送。不要手动设置 `id` 或 `parent`。

## 修改和删除的最小模式

对已存在对象，读取最新对象后再改属性，避免用一个缺失未知字段的临时 wrapper 覆盖当前板状态。

```python
target = board.get_items_by_id(existing_id)[0]
target.width = from_mm(0.30)

commit = board.begin_commit()
try:
    updated_target, = board.update_items(target)
    if updated_target.width != from_mm(0.30):
        raise RuntimeError("KiCad 未接受预期线宽")
    board.push_commit(commit, "Widen selected track")
except Exception:
    board.drop_commit(commit)
    raise
```

删除时首先从同样的、可审计的条件得到 `targets`，展示数量与网络/层范围，再在事务中调用 `board.remove_items(targets)`。如果某个目标没有稳定身份或范围不清，停止并请求澄清。

## SES 导入的实现检查表

- 解析器仅将 SES 转成中性记录；它不能写 `.kicad_pcb`，也不能调用 `pcbnew`。
- 每条记录必须有网络名、明确单位的坐标、铜层和几何尺寸；过孔还要有孔径与层对。拒绝静默默认。
- 对每个网名在 `board.get_nets()` 返回结果中精确匹配；对每层确认它是当前板启用的铜层。目标版本支持时可用 `get_layer_by_name()`；否则使用已验证的层枚举映射。
- 将计划记录生成 `Track` / `ArcTrack` / `Via` 对象列表，在任何写入前检查列表非空、数量、端点、层和网络。
- "替换" 不是默认行为：只有用户指定网络、区域或其他可精确表达的范围，才删除旧自动布线。对混合有人工作业的网络，默认只导入新增路线或要求用户选择。
- 写入使用一个 commit；成功后重新调用 `get_tracks()` / `get_vias()` 或按 UUID 取回对象进行核验。区域受影响时，调用 `refill_zones()` 并等待完成。

## 常见失败处理

- KiCad 已打开但连接失败：先确认当前打开的是 PCB Editor，而非仅项目管理器；接着让用户在 **偏好设置 → 插件** 启用 API 服务并重启 PCB Editor。若运行在 DSH，还要确认任务为 **Full Access**。只有这两项都成立后，才把错误作为普通连接问题诊断。
- `AS_BUSY`、超时或 GUI 交互阻塞：不要并发开新连接。对读取进行有上限的退避重试；对写入先重新获取相关对象，确认未出现部分成功，再谨慎处理。
- API 未实现或目标 KiCad 版本不支持：说明所需能力、版本和不执行的原因。可建议升级 KiCad 或改变用户工作流，但不要直接改板文件作为偷偷的后备方案。
- SDK 返回的值被 KiCad 约束或钳制：以返回对象为准；若不满足要求，撤销事务或在明确许可下重新规划，不要假定请求值已生效。

## 可复用脚本模板

这些脚本位于 [../scripts](../scripts)，均只使用 `kipy` 公共接口，且所有会修改板的模板都使用 KiCad commit。复制整个 `scripts` 目录，或将其放在同一目录下运行，以便脚本导入 `kipy_common.py`。

| 脚本 | 用途 | 写入范围 |
| --- | --- | --- |
| `diagnose_ipc_connection.py` | 检查 `kipy`、连接、版本与当前 PCB；输出 API 设置和 DSH Full Access 提示 | 无 |
| `create_track.py` | 在指定已有网络和层上创建一条直线走线 | 新建一条 track |
| `create_via.py` | 在指定已有网络上创建一个通孔 via | 新建一个 via |
| `update_selected_track_width.py` | 修改 KiCad 当前选中直线/圆弧走线的线宽 | 当前选择中的 track/arc track |
| `remove_selected_items.py` | 删除 KiCad 当前选中对象，须显式 `--yes` | 当前选择 |
| `move_rotate_footprint.py` | 按 reference 移动和旋转一个封装 | 一个既有封装 |
| `add_footprint_from_board_template.py` | 用板上指定封装的公开 `clone()` 创建新封装 | 新建一个封装 |
| `create_copper_zone.py` | 在已有网络的指定铜层建立封闭铜区 | 新建一个未填充区域 |
| `refill_zones.py` | 等待当前 PCB 的已有铜区填充完成 | 已有区域的填充结果 |
| `verify_live_ipc.py` | 在未推送 commit 中进行真实 IPC 烟测并丢弃改动 | 无持久化改动 |

模板只提供结构，不会替用户决定网络、层、尺寸或删除范围。执行它们仍须获得与实际 PCB 修改相符的授权。

### 移动、旋转与新增封装

- 通过 `get_footprints()` 按精确 reference 找到唯一封装，修改 `position` 和 `orientation`，再调用 `update_items()`；不要修改 footprint 子对象的绝对坐标来模拟整体变换。
- `Item.clone()`（`kicad-python` 0.8.0 起）会清除顶层对象 ID，适合用完整的板上封装作为模板，再由 `create_items()` 生成新 UUID。脚本仍要求新 reference 在板内唯一。
- 当前 SDK 版本未提供“按 footprint library nickname/名称取出定义并直接放置”的通用公开 API。`add_footprint_from_board_template.py` 因而有意只支持板上模板克隆；不要用私有 `proto`、`pcbnew` 或 S 表达式来伪造库放置。

### 新建与填充铜区

- `create_copper_zone.py` 只建立区域，默认不填充，便于用户先审阅外形和网络；随后按用户意图运行 `refill_zones.py`。
- KiCad 10.0.6 / `kicad-python` 0.8.0 的公开 `refill_zones()` 接口作用于当前板全部区域，不接受区域 ID 参数。不要把只在更新版本中出现的参数传给这一版本。
- 填充可能耗时；使用 `block=True` 和有上限的等待时间。填充完成不等于持久化，仍仅在用户要求后调用 `board.save()`。

### 真实环境验证

`verify_live_ipc.py` 适用于已启用 IPC 的测试 PCB：它创建和更新临时对象、测试移动旋转、克隆封装、创建铜区并删除临时走线，但所有变化都在同一个未推送的 KiCad commit 内以 `drop_commit()` 丢弃，且从不调用 `save()`。它不应用于含有用户未保存 GUI 改动的板，因为测试脚本无法判定或保护那些改动。

## 官方资料

- KiCad IPC API for add-on developers: <https://dev-docs.kicad.org/en/apis-and-binding/ipc-api/for-addon-developers/>
- `kicad-python` API documentation: <https://docs.kicad.org/kicad-python-main/>
- Official `kicad-python` source and examples: <https://gitlab.com/kicad/code/kicad-python>
- Shared editor CRUD implementation: <https://gitlab.com/kicad/code/kicad-python/-/raw/main/kipy/editor.py>

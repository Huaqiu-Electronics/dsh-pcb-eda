# FreeRouting 2.5.0 源码构建

[English](README.md) | [简体中文](README.zh-CN.md)

随包引擎基于官方 `v2.5.0`，提交 `b647a2f824cfbc54bc4dcaee71b03b7cd945eb76`，本地补丁标识为 `dsh-freerouting-2.5.0-1`。运行时为完整 Eclipse Temurin Java 25 Windows x64 JRE。内测用户无需安装系统 Java；开发构建需要完整 JDK 25。

`upstream-2.5.0-source.zip` 包含固定提交的完整应用源码、资源、Gradle 构建与包装器、官方测试源码和本次往返测试所需的原始输入。`source.lock.json` 记录提交、源码归档哈希和修复文件哈希；本轮 JAR 哈希与上游测试状态记录在生成的 `bundled/freerouting.build.json`。上游采用 GPL-3.0，许可证保留在 `LICENSE`。Java 运行时自己的许可证保留在 `bundled/jre/legal`。

`src/` 只包含三个修改后的应用源码文件；构建时覆盖到官方源码中。`reviewed-changes.patch` 记录已有上游文件的差异，新模块完整源码见 `src/app/freerouting/io/specctra/SesTracePath.java`。`tests/upstream/` 更新官方测试因模块拆分和最终输出参数而变化的调用。旧的恢复源码和基于原 JAR 替换类的构建方式已经移除。

## 修复范围

- `SesTracePath` 负责走线坐标输出。保留原来的焊盘和过孔端点吸附；吸附使非零线段塌缩时，使用原始端点在 1 nm 网格输出。真实点状铜对象保留两个相同端点，不删铜、不人为延长。无法表示的非零线段拒绝输出。
- `SesWriter` 委托上述模块输出走线，保留其余官方 SES 写入行为。
- `RoutingJobSchedulerActionThread` 只发布完整的当前结果。最终导出失败时清除旧输出，返回失败。任务过期或取消后不会被改报为成功；监控线程在任务或工作线程结束后退出。
- 官方调度器已有「没有新任务开始就退出内层循环，再等待 250 ms」的处理。本次没有再复制旧的调度器补丁。

TypeScript 使用官方 `GET /jobs/{id}/settings` 获取合并后的默认值和板子规则，修改时限与优化开关后再提交。KiCad 导出轮数为 0 时，明确规范化为至少一轮；其他规则保留。首份过程结果未生成时，官方 `204 No Content` 表示继续等待；格式错误的成功响应仍拒绝。指定或跳过网络缺少已验证的官方筛选能力，因此在任务开始前明确拒绝。

## 从随包源码重建

在插件目录运行，将参数换成本机路径。构建输出与缓存应放在空间充足的目录。首次构建需要访问 Gradle 与 Maven 的依赖仓库。

```powershell
python engine/build.py --jdk '<JDK 25 目录>' --output '<输出 JAR 路径>' --gradle-cache '<Gradle 缓存目录>' --check
```

构建先核对源码归档与修复文件哈希，再执行完整 Gradle 应用构建。`--check` 同时运行官方调度器、任务结束状态、SES 往返和包依赖架构测试。构建日志写到输出旁边的 `.build.log`。官方构建会写入时间戳，因此不同时间构建的 JAR 哈希可能不同；发布核对使用该 JAR 对应的 `.build.json`，并核对其源码锁和上游测试状态。

## 插件回归

```powershell
$env:DSH_IPC_TEST_PYTHON = '<KiCad 10 的 bin/python.exe>'
$env:DSH_ENGINE_TEST_JDK = '<JDK 25 目录>'
pnpm run test:engine
```

检查包含真实 HTTP 过程输出变化、取消确认、一轮上限、超时状态稳定、七组坐标及 KiCad 原生导入、已完成任务的闲置 CPU/分配、最终导出失败拒绝旧预览，以及连续任务的监控线程退出。真实 KiCad 预览、最终回导、一次撤销、原铜保留和关闭编辑器回收 Java 仍需要独立的隔离编辑器验收。

规则检查发现的问题按已有内测政策报告，允许一次修复后带问题回导。几何不合法、未完成检查、原铜改变或回滚不确定不能放行。「结果已添加」与「全部布通」「规则检查通过」分别报告。

## 许可证

插件自有代码采用 [MIT 许可证](../LICENSE)。FreeRouting 引擎及其修改保留 [GPL-3.0 许可证](LICENSE)，不改为 MIT。第三方依赖保留各自许可证，详见[第三方说明](../THIRD_PARTY_NOTICES.md)。内部设计及验收文档不随源码和插件包公开。

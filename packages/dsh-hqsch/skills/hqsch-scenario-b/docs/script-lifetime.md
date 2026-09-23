# 脚本进程生命周期（强制）

> 每个脚本都必须通过 `scripts/lib/hq.ts` 的 `hqMain` / `hqMainWithProject` 进入。
> 直接写 `connect(...)` + `main().catch(() => process.exit(1))` 会泄漏 node 进程。

## 症状

跑完脚本后 `ps aux | grep tsx` 里残留一堆 node 进程；agent 重试 3 次就多 3 个；
最终机器变卡、端口/内存被吃光，而 agent 看到的只是"命令没返回"。

## 根因

`connect()` 内部用 `createGrpcTransport`。HTTP/2 stream 打开期间，会话管理器会
`ref()` Node 事件循环。若某个 RPC 迟迟不返回：

1. `await` 永不 settle；
2. stream 不关闭 → 事件循环无法排空；
3. node 进程永远不退出。

`docs/rpc-availability.md` 明确记录过"部分 RPC 历史上阻塞数分钟后才返回 clean
unimplemented"，而它同时又叮嘱"不要用超时反推未实现"——两者叠加，agent 就会
无限等下去，再重试，再泄漏一个进程。

### 为什么 `finally { client.close() }` 救不了

`await` 不 settle 时，控制流根本到不了 `finally`。必须先让 `await` 一定会 settle，
清理才有意义。`EditorClient.close()` 的官方注释也只保证"测试进程能退出"，
不保证"卡住的 await 能被唤醒"。

## `scripts/lib/hq.ts` 做什么

| 机制 | 作用 |
| --- | --- |
| 每个 RPC 注入 `AbortSignal` 超时 | 让 `await` 一定会 settle（默认 30s） |
| 硬看门狗 | 无论如何进程都会在 N ms 内终止（默认 180s，退出码 124） |
| `finally { client.close() }` | 释放 HTTP/2 连接 |
| `process.exitCode` + 冲刷宽限 | 保证 stdout/stderr 完整输出，不会被 `process.exit()` 截断 |

超时由客户端级代理注入，所以**调用点不用改**——
`client.kernel.getSnapshot({ context })` 依旧能写，底层已经带 deadline。
这一点是刻意的：靠 agent 记得给每个 RPC 传 `{ signal }` 是不可靠的。

## 用法

```typescript
import { hqMain, hqMainWithProject, waitForRegistered } from "./lib/hq.js";

// 只需要连接
hqMain(async (client) => { /* ... */ });

// 需要活动工程（绝大多数 Flow A/B/C 脚本）
hqMainWithProject(async ({ client, projectId, projectContext: ctx }) => {
  // ...
  await waitForRegistered(client, ctx, newIds);   // 放置后等注册
});
```

**不要**再写：

```typescript
const client = await connect({ instanceId: process.env.HQ_INSTANCE_ID });
// ...
main().catch((e) => { console.error(e); process.exit(1); });
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HQ_INSTANCE_ID` | — | 多开编辑器时指定实例；**未设时不要传 `undefined`**，否则绕过自动发现 |
| `HQ_RPC_TIMEOUT_MS` | 30000 | 单个 RPC 超时 |
| `HQ_HARD_TIMEOUT_MS` | 180000 | 整个脚本硬上限 |

## 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 脚本抛错（stderr 有 `❌` 前缀） |
| `124` | 硬看门狗触发 —— 说明有 RPC 卡死且 deadline 未生效，需排查而非调大超时 |

看到 124 **不要**简单调大 `HQ_HARD_TIMEOUT_MS`：那只是把泄漏时间拉长。
应该查是哪个 RPC 卡住，并把它加入 `docs/rpc-availability.md` 的禁建表。

## 顺带修掉的两个坑（同一批改动）

- `GetPageOccupancy` 在 **`client.patternLayout`** 上，不在 `canvasOps`；
  响应字段是 **`items[].objectId`**，没有 `objectIds`。旧写法
  `(occ.objectIds ?? [])` 恒为空 → 轮询第一次就"通过"。用 `waitForRegistered()`。
- `GetSnapshotResponse` 的实体在 **`snapshot` 内层**：
  `snap.snapshot.symbolInstances`，不是 `snap.symbolInstances`
  （后者恒为 `undefined`，会静默打印 0）。

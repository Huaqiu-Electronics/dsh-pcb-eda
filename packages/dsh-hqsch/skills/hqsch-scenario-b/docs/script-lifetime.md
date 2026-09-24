# 脚本进程生命周期（强制）

> 每个脚本都必须通过 `scripts/lib/hq.ts` 的 `hqMain` / `hqMainWithProject` 进入。
> 直接写 `connect(...)` + `main().catch(() => process.exit(1))` 会泄漏 node 进程。

## 症状

跑完脚本后 `ps aux | grep tsx` 里残留一堆 node 进程；agent 重试 3 次就多 3 个；
最终机器变卡、端口/内存被吃光，而 agent 看到的只是"命令没返回"。

## 根因（历史）

`connect()` 内部用 `createGrpcTransport`。HTTP/2 stream 打开期间，会话管理器会
`ref()` Node 事件循环。若某个 RPC 迟迟不返回：

1. `await` 永不 settle；
2. stream 不关闭 → 事件循环无法排空；
3. node 进程永远不退出。

`docs/rpc-availability.md` 明确记录过"部分 RPC 历史上阻塞数分钟后才返回 clean
unimplemented"，而它同时又叮嘱"不要用超时反推未实现"——两者叠加，agent 就会
无限等下去，再重试，再泄漏一个进程。

### 现在已由库层面修复

`@huaqiu/huaqiu-client >= 0.1.9` 在传输层把 `ConnectOptions.timeoutMs` 注入底层的
Connect 传输（unary 与 stream 都覆盖）。超时的 RPC 会以 `deadline_exceeded` 被拒绝、
其 HTTP/2 stream 被释放，于是 `await` 一定会 settle，`finally` 里的
`client.close()` 因此可达，进程**自然退出**。

因此本外壳**不再**需要客户端代理注入 `AbortSignal`、绝对看门狗或强制
`process.exit()`。它只把 `HQ_RPC_TIMEOUT_MS` / `rpcTimeoutMs` 透传给 `connect()`，
并负责下面"本外壳真正负责的部分"。

### `finally { client.close() }` 的作用

它是正常的生命周期清理（释放 HTTP/2 连接），不是超时恢复机制——
超时恢复已由库的 per-RPC deadline 完成。

## `scripts/lib/hq.ts` 做什么

| 机制 | 作用 |
| --- | --- |
| `connect({ timeoutMs })` | 把单 RPC 超时透传给库（库层面兜底，覆盖 unary/stream） |
| `try / finally { client.close() }` | 正常生命周期清理，释放 HTTP/2 连接 |
| `waitForRegistered` / `waitForRemoved` | 放置/删除后轮询页面占用，避免误判就绪 |
| `naturalCompare` / `pinNumber` 等 | 与超时无关的易错点辅助函数 |

调用点写法不变——`client.kernel.getSnapshot({ context })` 依旧能写；超时由库统一兜底，
不依赖 agent 记得给每个 RPC 传 `{ signal }`。

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
| `HQ_RPC_TIMEOUT_MS` | 30000 | 单个 RPC 超时，透传给 `connect({ timeoutMs })` |

## 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 脚本抛错（stderr 有 `❌` 前缀） |

进程现在依赖 Node 自然退出（冲刷完 stdout/stderr 后）；不再有看门狗强杀
（退出码 124）。若脚本卡死无响应，应排查是哪个 RPC 卡住、把它加入
`docs/rpc-availability.md` 的禁建表，而不是调大超时。

## 顺带修掉的两个坑（同一批改动）

- `GetPageOccupancy` 在 **`client.patternLayout`** 上，不在 `canvasOps`；
  响应字段是 **`items[].objectId`**，没有 `objectIds`。旧写法
  `(occ.objectIds ?? [])` 恒为空 → 轮询第一次就"通过"。用 `waitForRegistered()`。
- `GetSnapshotResponse` 的实体在 **`snapshot` 内层**：
  `snap.snapshot.symbolInstances`，不是 `snap.symbolInstances`
  （后者恒为 `undefined`，会静默打印 0）。

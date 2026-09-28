/**
 * scripts/lib/hq.ts —— Scenario B 所有脚本的统一运行时外壳（强制使用）
 *
 * ── 为什么必须有这一层 ───────────────────────────────────────────
 * 连接 HQ EDA 的脚本必须统一从这里进出，原因有两个，二者独立：
 *
 *  1. **RPC 超时 / 永生进程**（已由 `@huaqiu/huaqiu-client` 在库层面解决）
 *     `connect()` 内部用 `createGrpcTransport`，HTTP/2 stream 打开期间会
 *     `ref()` Node 事件循环。若某个 RPC 迟迟不返回，`await` 永不 settle、
 *     stream 不关闭，事件循环无法排空 —— node 进程变成"永生进程"。
 *
 *     这个根因现在由客户端库 `@huaqiu/huaqiu-client@>=0.1.9` 在传输层修复：
 *     `connect({ timeoutMs })` 会把 per-RPC 截止时间注入底层的 Connect
 *     传输（unary 与 stream 都覆盖）。超时的 RPC 会被 `deadline_exceeded`
 *     拒绝、其 HTTP/2 stream 被释放，`await` 于是一定会 settle，`finally`
 *     里的 `client.close()` 因此可达，进程自然退出。
 *
 *     本外壳只需把 `HQ_RPC_TIMEOUT_MS` / `rpcTimeoutMs` 透传给 `connect()`
 *     即可，**不再需要**客户端代理注入 `AbortSignal`、绝对看门狗或强制
 *     `process.exit()`。那些是库修复到位之前的临时兜底，现已移除。
 *
 *  2. **确定性清理与易错轮询**（本外壳真正负责的部分，与超时无关）
 *     - `finally { client.close() }`：无论成功失败都释放 HTTP/2 连接，
 *       这是正常的生命周期安全网，不是超时恢复机制。
 *     - `waitForRegistered()` / `waitForRemoved()`：放置/删除后轮询页面
 *       占用，避免误判"已就绪"导致 `OBJECT_NOT_FOUND` / 假 `PARTIAL`。
 *       其中 `GetPageOccupancy` 在 `client.patternLayout` 上、响应字段是
 *       `items[].objectId`（没有 `objectIds`）——这是独立修过的坑。
 *
 * ── 用法 ───────────────────────────────────────────────────────
 *   import { hqMain, hqMainWithProject } from "./lib/hq.js";
 *
 *   hqMain(async (client) => { ... });                 // 只需连接
 *   hqMainWithProject(async ({ client, projectContext }) => { ... });  // 还需要活动工程
 *
 * 禁止再直接写 `connect(...)` + `main().catch(e => process.exit(1))`，
 * 那会绕过统一的 `finally` 清理。
 *
 * 环境变量：
 *   HQ_INSTANCE_ID        多开编辑器时指定实例
 *   HQ_RPC_TIMEOUT_MS     单个 RPC 超时（默认 30000）；透传给 `connect()`
 */

import { connect, type EditorClient } from "@huaqiu/huaqiu-client";

export type { EditorClient };

/** 单个 RPC 的默认超时（毫秒）。透传给 `connect({ timeoutMs })`，由库层面兜底。 */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export type ProjectContext = ReturnType<EditorClient["createProjectContext"]>;
export type EditorContext = ReturnType<EditorClient["createEditorContext"]>;

export interface HqOptions {
  /** 多开 HQ EDA 时指定实例；未设则走自动发现。 */
  instanceId?: string;
  /** 直连指定 gRPC endpoint（测试 / 远程调试用）；未设则走本地注册表发现。 */
  grpcEndpoint?: string;
  /** 覆盖单 RPC 超时（毫秒）；透传给 `connect({ timeoutMs })`。 */
  rpcTimeoutMs?: number;
}

export interface HqProjectSession {
  /** 连接后的客户端（超时由库层面按 `connect({ timeoutMs })` 兜底）。 */
  client: EditorClient;
  projectId: string;
  projectContext: ProjectContext;
  editorContext: EditorContext;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 连接 → 执行 → 关闭。Scenario B 脚本的唯一入口。 */
export async function hqMain(
  fn: (client: EditorClient) => Promise<void>,
  options: HqOptions = {},
): Promise<void> {
  const rpcTimeoutMs = options.rpcTimeoutMs ?? positiveIntEnv("HQ_RPC_TIMEOUT_MS", DEFAULT_RPC_TIMEOUT_MS);
  const instanceId = options.instanceId ?? process.env.HQ_INSTANCE_ID;

  // 只在真的有值时传 instanceId——传 undefined 会绕过自动发现逻辑。
  // timeoutMs 透传给库；per-RPC 截止由 `@huaqiu/huaqiu-client` 在传输层执行。
  const connectOptions: { instanceId?: string; grpcEndpoint?: string; timeoutMs: number } = {
    timeoutMs: rpcTimeoutMs,
  };
  if (options.grpcEndpoint) connectOptions.grpcEndpoint = options.grpcEndpoint;
  else if (instanceId) connectOptions.instanceId = instanceId;

  let client: EditorClient | undefined;
  let exitCode = 0;

  try {
    client = await connect(connectOptions);
    await fn(client);
  } catch (e) {
    exitCode = 1;
    console.error("❌", e instanceof Error ? e.message : e);
  } finally {
    // 正常生命周期清理：释放 HTTP/2 连接，让事件循环自然排空。
    // 不是超时恢复机制 —— 超时已由库的 per-RPC deadline 处理。
    try {
      client?.close();
    } catch {
      // 关闭失败无所谓，连接已经要没了
    }
  }

  // 让 Node 自然退出（冲刷 stdout/stderr 后），不强制 process.exit。
  process.exitCode = exitCode;
}

/** `hqMain` + 取活动工程并建好 ProjectContext。Flow A/B/C 绝大多数脚本用这个。 */
export async function hqMainWithProject(
  fn: (session: HqProjectSession) => Promise<void>,
  options: HqOptions = {},
): Promise<void> {
  return hqMain(async (client) => {
    const editorContext = client.createEditorContext();
    const active = await client.project.getActiveProject({ context: editorContext });
    const projectId = active.project?.projectId;
    if (!projectId) throw new Error("请先在 HQ EDA 中打开原理图工程");
    await fn({
      client,
      projectId,
      projectContext: client.createProjectContext(projectId),
      editorContext,
    });
  }, options);
}

/**
 * 自然序比较，用于引脚号排序。
 *
 * 禁止用 `Number(a) - Number(b)`：位号引脚常是 "A5"/"CC1" 这类字母前缀，
 * `Number("A5")` 得到 NaN，排序直接失去意义。
 */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const pa = String(a).match(re) ?? [];
  const pb = String(b).match(re) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 把引脚号解析为 RPC 需要的数字。
 *
 * `pinNum1` 只接受数字，而原理图上引脚号可能是 "A5"/"CC1"。硬规则：不要对
 * 非纯数字引脚做 `Number()` —— 那会静默产生 NaN 并连错脚。这里显式抛错，
 * 让调用方改用 pinName 路径。
 */
export function pinNumber(pin: string | undefined, label = "PIN"): number {
  const s = String(pin ?? "").trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(
      `${label}="${s}" 不是纯数字引脚号，无法用于 pinNum（autoConnect）。` +
        `字母前缀引脚请改用 pinName 路径，或先在快照中确认引脚编号。`,
    );
  }
  return Number(s);
}

/** 轮询用 sleep。 */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────────────────────────────────────────────
 * 对象注册等待（放置后的关键步骤）
 * ────────────────────────────────────────────────────────────────
 * 两个易错点，都已在旧版脚本/文档中出现过：
 *   1. `GetPageOccupancy` 属于 **PatternLayoutService**（`client.patternLayout`），
 *      不在 `canvasOps` 上。
 *   2. 响应字段是 **`items: PageOccupancyItem[]`**（每项 `objectId`/`objType`/
 *      `designator`/`bbox`），**没有** `objectIds` 这个字段。
 *      读 `occ.objectIds ?? []` 恒为空 → 轮询第一次就"通过"，随后 apply
 *      报 `OBJECT_NOT_FOUND` 或假 `PARTIAL`。
 * ──────────────────────────────────────────────────────────────── */

async function occupancyIds(client: EditorClient, ctx: ProjectContext): Promise<Set<string>> {
  const occ = await client.patternLayout.getPageOccupancy({ context: ctx });
  const items = (occ as unknown as { items?: Array<{ objectId?: bigint | string }> }).items ?? [];
  return new Set(items.map((it) => String(it.objectId)));
}

export interface PollOptions {
  /** 最长等待时间，默认 15000ms。超时抛错，不静默放过。 */
  timeoutMs?: number;
  /** 轮询间隔，默认 300ms。 */
  intervalMs?: number;
  /** 日志前缀。 */
  label?: string;
}

/** 等到所有 objectId 都出现在页面上（放置后立即调用，再 apply pattern）。 */
export async function waitForRegistered(
  client: EditorClient,
  ctx: ProjectContext,
  objectIds: Array<string | bigint>,
  options: PollOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 300;
  const wanted = objectIds.map(String);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const present = await occupancyIds(client, ctx);
    const missing = wanted.filter((id) => !present.has(id));
    if (missing.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `${options.label ?? "waitForRegistered"}: ${timeoutMs}ms 内未注册完成，仍缺 ${missing.length} 个对象 ` +
          `(${missing.slice(0, 5).join(", ")}). 继续 apply 会得到 OBJECT_NOT_FOUND 或假 PARTIAL。`,
      );
    }
    await sleep(intervalMs);
  }
}

/** 等到指定 objectId 全部从页面上消失（删除后调用）。 */
export async function waitForRemoved(
  client: EditorClient,
  ctx: ProjectContext,
  objectIds: Array<string | bigint>,
  options: PollOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 300;
  const wanted = new Set(objectIds.map(String));
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const present = await occupancyIds(client, ctx);
    const still = [...wanted].filter((id) => present.has(id));
    if (still.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `${options.label ?? "waitForRemoved"}: ${timeoutMs}ms 后对象仍存在 (${still.slice(0, 5).join(", ")})`,
      );
    }
    await sleep(intervalMs);
  }
}

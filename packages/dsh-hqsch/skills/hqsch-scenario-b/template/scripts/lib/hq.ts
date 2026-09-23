/**
 * scripts/lib/hq.ts —— Scenario B 所有脚本的统一运行时外壳（强制使用）
 *
 * ── 为什么必须有这一层（改动前请读完）────────────────────────────
 * `connect()` 内部使用 `createGrpcTransport`，它在 HTTP/2 stream 打开期间会
 * `ref()` Node 事件循环。若某个 RPC 迟迟不返回（docs/rpc-availability.md 记录了
 * "历史上阻塞数分钟后才返回 clean unimplemented" 的情况），`await` 永不 settle、
 * stream 不关闭，事件循环无法排空 —— node 进程变成"永生进程"。agent 每次重试
 * （最多 3 次）都会再泄漏一个进程。
 *
 * 关键陷阱：**把 `client.close()` 写进 `finally` 救不了**。`await` 不 settle 时
 * `finally` 根本不会执行。必须先让 `await` 一定会 settle，再谈清理。
 *
 * 因此本外壳同时做三件事：
 *   1. 每个 RPC 注入 `AbortSignal` 超时 → `await` 一定会 settle；
 *   2. 硬看门狗（hard watchdog）→ 无论发生什么，进程都能在 N 毫秒内终止；
 *   3. `finally` 中 `client.close()`，并给 stdout 留出冲刷时间后退出。
 *
 * ── 用法 ───────────────────────────────────────────────────────
 *   import { hqMain, hqMainWithProject } from "./lib/hq.js";
 *
 *   hqMain(async (client) => { ... });                 // 只需连接
 *   hqMainWithProject(async ({ client, projectContext }) => { ... });  // 还需要活动工程
 *
 * 禁止再直接写 `connect(...)` + `main().catch(e => process.exit(1))`，
 * 那正是进程泄漏的来源。
 *
 * 环境变量：
 *   HQ_INSTANCE_ID        多开编辑器时指定实例
 *   HQ_RPC_TIMEOUT_MS     单个 RPC 超时（默认 30000）
 *   HQ_HARD_TIMEOUT_MS    整个脚本硬超时（默认 180000）
 */

import { connect, type EditorClient } from "@huaqiu/huaqiu-client";

export type { EditorClient };

/** 单个 RPC 的默认超时。超过即抛 DeadlineExceeded，而不是无限等待。 */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;
/** 整个脚本的硬上限。到点强制退出，杜绝进程堆积。 */
export const DEFAULT_HARD_TIMEOUT_MS = 180_000;
/** 退出前留给 stdout/stderr 冲刷的宽限期。 */
const FLUSH_GRACE_MS = 3_000;

export type ProjectContext = ReturnType<EditorClient["createProjectContext"]>;
export type EditorContext = ReturnType<EditorClient["createEditorContext"]>;

export interface HqOptions {
  /** 多开 HQ EDA 时指定实例；未设则走自动发现。 */
  instanceId?: string;
  /** 直连指定 gRPC endpoint（测试 / 远程调试用）；未设则走本地注册表发现。 */
  grpcEndpoint?: string;
  /** 覆盖单 RPC 超时（毫秒）。 */
  rpcTimeoutMs?: number;
  /** 覆盖硬看门狗（毫秒）。 */
  hardTimeoutMs?: number;
}

export interface HqProjectSession {
  /** 已注入 RPC 超时代理的客户端（务必用这个，不要用裸 connect 的结果）。 */
  client: EditorClient;
  projectId: string;
  projectContext: ProjectContext;
  editorContext: EditorContext;
}

type AnyFn = (...args: any[]) => any;
type CallOptions = { signal?: AbortSignal; timeoutMs?: number; [k: string]: unknown };

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * EditorClient 上属于 gRPC-CONNECT 服务的命名空间。
 * 只有这些需要注入 deadline；`parts`（part-search，HTTP）与 `info`/`sessionId`
 * 等普通字段不在此列。
 */
const RPC_NAMESPACES = new Set<string>([
  "discovery",
  "capability",
  "context",
  "project",
  "kernel",
  "graph",
  "selection",
  "canvasOps",
  "componentPlace",
  "objPlace",
  "patternLayout",
  "interactivePlace",
  "erc",
  "edaBom",
  "netList",
  "runtime",
  "transaction",
  "event",
  "find",
  "import",
  "export",
]);

/**
 * 给单个服务命名空间套一层代理：每次调用都自动补上 `signal`。
 *
 * 这样调用点无需改动——`client.kernel.getSnapshot({ context })` 依然写得出来，
 * 但底层已经带上了超时。这一点很重要：agent 生成的脚本不可能记得给每个 RPC
 * 手动传 options，必须由外壳兜住。
 */
function withDeadline<T extends object>(service: T, timeoutMs: number): T {
  return new Proxy(service, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value !== "function") return value;

      const fn = value as AnyFn;
      return (request?: unknown, callOptions?: CallOptions) => {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort(new Error(`RPC 超时 ${timeoutMs}ms`));
        }, timeoutMs);
        const call = Promise.resolve(
          fn.call(target, request, { signal: controller.signal, ...(callOptions ?? {}) }),
        );
        // 无论成功失败都清掉计时器，避免无谓地挂住事件循环。
        return call.finally(() => clearTimeout(timer));
      };
    },
  });
}

/** 客户端级代理：方法绑定回原对象，RPC 命名空间则换成带 deadline 的版本。 */
function withDeadlineClient(client: EditorClient, timeoutMs: number): EditorClient {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof prop === "string" && RPC_NAMESPACES.has(prop) && typeof value === "object" && value !== null) {
        return withDeadline(value as object, timeoutMs);
      }
      return typeof value === "function" ? (value as AnyFn).bind(target) : value;
    },
  }) as EditorClient;
}

/**
 * 退出：先设 exitCode 让 stdout/stderr 有机会冲刷干净；
 * 若仍有句柄吊住事件循环，兜底强杀。绝不让进程"安静地永远活着"。
 */
function finish(code: number): void {
  process.exitCode = code;
  const grace = setTimeout(() => process.exit(code), FLUSH_GRACE_MS);
  (grace as unknown as { unref?: () => void }).unref?.();
}

/** 连接 → 执行 → 关闭 → 退出。Scenario B 脚本的唯一入口。 */
export async function hqMain(
  fn: (client: EditorClient) => Promise<void>,
  options: HqOptions = {},
): Promise<void> {
  const rpcTimeoutMs = options.rpcTimeoutMs ?? positiveIntEnv("HQ_RPC_TIMEOUT_MS", DEFAULT_RPC_TIMEOUT_MS);
  const hardTimeoutMs = options.hardTimeoutMs ?? positiveIntEnv("HQ_HARD_TIMEOUT_MS", DEFAULT_HARD_TIMEOUT_MS);
  const instanceId = options.instanceId ?? process.env.HQ_INSTANCE_ID;

  // 硬看门狗：故意不 unref——即使 await 永不 settle、且没有任何 ref 住的句柄
  // （那种情况下 Node 会静默退出、脚本像"成功"一样消失），也要让它变成一次
  // 响亮的 exit 124。
  const watchdog = setTimeout(() => {
    console.error(
      `\n⏱  硬看门狗触发（${hardTimeoutMs}ms）：强制终止进程。\n` +
        `   常见原因：某个 RPC 未返回且 deadline 未生效。调大 HQ_HARD_TIMEOUT_MS 只能掩盖问题。`,
    );
    process.exit(124);
  }, hardTimeoutMs);

  let client: EditorClient | undefined;
  let exitCode = 0;

  try {
    // 只在真的有值时传 instanceId——传 undefined 会绕过自动发现逻辑。
    const connectOptions: { instanceId?: string; grpcEndpoint?: string } = {};
    if (options.grpcEndpoint) connectOptions.grpcEndpoint = options.grpcEndpoint;
    else if (instanceId) connectOptions.instanceId = instanceId;
    client = await connect(connectOptions);
    await fn(withDeadlineClient(client, rpcTimeoutMs));
  } catch (e) {
    exitCode = 1;
    console.error("❌", e instanceof Error ? e.message : e);
  } finally {
    clearTimeout(watchdog);
    try {
      client?.close();
    } catch {
      // 关闭失败无所谓，连接已经要没了
    }
  }

  finish(exitCode);
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

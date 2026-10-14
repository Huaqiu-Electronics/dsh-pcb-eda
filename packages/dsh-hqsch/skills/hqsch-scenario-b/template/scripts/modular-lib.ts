/**
 * Scenario B · 模块化布局公共库
 *
 * - 活动页引脚：优先 getObjectJsonById → PortInstScalar（勿依赖陈旧 snapshot）
 * - ext 坐标 Y 向下；PAGE_TOP 默认 1400，应与 page_box.max.y 一致（P0 后读取）
 */
import { connect, toJsonString } from "@huaqiu/huaqiu-client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export let PAGE_TOP = 1400;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** P4a 模块框 / PlaceText — GetSnapshot 与 occupancy 列不出，必须 place 时登记（见 docs/decoration-objects.md） */
export type DecorationKind = "rect" | "text";
export interface DecorationEntry {
  kind: DecorationKind;
  objectId: bigint;
  moduleKey?: string;
  label?: string;
}

const decorationLedger: DecorationEntry[] = [];

export function recordDecoration(entry: DecorationEntry) {
  decorationLedger.push(entry);
  console.log(
    `  ✓ 装饰已登记 ${entry.kind} id=${entry.objectId}${entry.moduleKey ? ` [${entry.moduleKey}]` : ""}${entry.label ? ` ${entry.label}` : ""}`,
  );
}

export function decorationObjectIds(filter?: { moduleKey?: string; kind?: DecorationKind }): bigint[] {
  return decorationLedger
    .filter((e) => (filter?.moduleKey ? e.moduleKey === filter.moduleKey : true))
    .filter((e) => (filter?.kind ? e.kind === filter.kind : true))
    .map((e) => e.objectId);
}

export function clearDecorationLedger() {
  decorationLedger.length = 0;
}

const DEFAULT_LEDGER = resolve(
  dirname(fileURLToPath(import.meta.url)), "..", "artifacts", "decoration-ledger.json",
);

/** 账本文件路径（可用 DECORATION_LEDGER 覆盖） */
export function ledgerPath(): string {
  return process.env.DECORATION_LEDGER ?? DEFAULT_LEDGER;
}

/** 落盘装饰账本：下次任务（新进程）仍能按 moduleKey 精确删框/字 */
export function saveDecorationLedger(file = ledgerPath()): number {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const rows = decorationLedger.map((e) => ({
      kind: e.kind, objectId: String(e.objectId), moduleKey: e.moduleKey ?? null, label: e.label ?? null,
    }));
    writeFileSync(file, JSON.stringify(rows, null, 2) + "\n", "utf8");
    return rows.length;
  } catch (e) {
    console.warn(`  ! 装饰账本写入失败: ${String(e)}`);
    return 0;
  }
}

/** 读回账本（合并到内存账本，返回条数） */
export function loadDecorationLedger(file = ledgerPath()): number {
  try {
    if (!existsSync(file)) return 0;
    const rows = JSON.parse(readFileSync(file, "utf8")) as Array<{
      kind: DecorationKind; objectId: string; moduleKey?: string | null; label?: string | null;
    }>;
    for (const r of rows) {
      const id = BigInt(r.objectId);
      const dup = decorationLedger.some(
        (e) => e.kind === r.kind && e.objectId === id && e.moduleKey === (r.moduleKey ?? undefined),
      );
      if (!dup) {
        decorationLedger.push({
          kind: r.kind, objectId: id,
          moduleKey: r.moduleKey ?? undefined, label: r.label ?? undefined,
        });
      }
    }
    return rows.length;
  } catch (e) {
    console.warn(`  ! 装饰账本读取失败: ${String(e)}`);
    return 0;
  }
}

/** 只删指定 moduleKey 的框/标题（流程 C 单模块修补用；勿用 prepareP4aDecorations） */
export async function deleteModuleDecorations(client: C, ctx: P, moduleKey: string): Promise<number> {
  const ids = decorationObjectIds({ moduleKey });
  if (!ids.length) return 0;
  await client.canvasOps.deleteObjectsByIds({ context: ctx, objectIds: ids } as any);
  await sleep(300);
  for (let i = decorationLedger.length - 1; i >= 0; i--) {
    if (decorationLedger[i].moduleKey === moduleKey) decorationLedger.splice(i, 1);
  }
  return ids.length;
}

/**
 * 删除活动页全部模块框 / PlaceText（occupancy 列不出，清页或重跑 P4a 必调）。
 *
 * 三级降级：
 *   1. RPC `listPageDecorations`（引擎与客户端都实现时）
 *   2. 本地装饰账本（同进程内 place 过，或 loadDecorationLedger 读回）
 *   3. `selectAll` + `getSelectedObjectsJson` 按字段特征筛选（跨进程兜底）
 */
export async function deleteAllPageDecorations(client: C, ctx: P): Promise<number> {
  let ids: bigint[] = [];
  try {
    if (typeof (client.canvasOps as any).listPageDecorations === "function") {
      const items = await listPageDecorations(client, ctx);
      ids = items.map((it) => BigInt(it.objectId)).filter((id) => id > 0n);
    }
  } catch {
    ids = [];
  }
  if (!ids.length) ids = decorationObjectIds();
  if (!ids.length) {
    try {
      ids = await enumeratePageDecorationIds(client, ctx);
      if (ids.length) console.log(`  · listPageDecorations 不可用，已用 selectAll 兜底识别 ${ids.length} 个装饰`);
    } catch { /* 保持空 */ }
  }
  if (!ids.length) return 0;
  await client.canvasOps.deleteObjectsByIds({ context: ctx, objectIds: ids } as any);
  await sleep(300);
  return ids.length;
}

/**
 * selectAll + getSelectedObjectsJson 枚举活动页装饰图元 id（跨进程兜底）。
 * 判别：自由字 = 有 locX/locY + Text 且无位号/引线特征；矩形 = 有 x1..y2 + fillStyle 且无 Text。
 * 绝不返回器件位号（prop_name / deviceDesignator）或网络别名（typeOrigin / sx）。
 */
async function enumeratePageDecorationIds(client: C, ctx: P): Promise<bigint[]> {
  const c: any = client.canvasOps;
  await c.clearAllSel({ context: ctx } as any).catch(() => {});
  await c.selectAll({ context: ctx } as any);
  await sleep(700);
  const sel: any = await c.getSelectedObjectsJson({ context: ctx } as any);
  await c.clearAllSel({ context: ctx } as any).catch(() => {});
  const objs: any[] = (sel.jsonList ?? [])
    .map((o: any) => {
      if (o && typeof o === "object") return o;
      if (typeof o === "string" && o.trim()) { try { return JSON.parse(o); } catch { return null; } }
      return null;
    })
    .filter(Boolean);
  const out: bigint[] = [];
  for (const j of objs) {
    if (j.dbId == null) continue;
    const isRef = j.prop_name != null || j.deviceDesignator != null;
    const isWireish = j.typeOrigin != null || (j.sx != null && j.ex != null);
    const hasText = typeof j.Text === "string" && j.Text.length > 0;
    const isText = hasText && j.locX != null && j.locY != null && !isRef && !isWireish;
    const isRect = j.x1 != null && j.y1 != null && j.x2 != null && j.y2 != null
      && j.fillStyle != null && !hasText && !isWireish && !isRef;
    if (isText || isRect) out.push(BigInt(j.dbId));
  }
  return out;
}

/**
 * 仅删器件与导线（不含 rect/text）。
 * 刚连接时 `getPageOccupancy` 可能异步返回 **空快照**，导致上一版遗留器件漏删，
 * 因此要求 **连续两轮为空** 才判定干净。
 */
export async function clearElectricalOnActivePage(client: C, ctx: P, maxRounds = 10): Promise<number> {
  let consecutiveEmpty = 0;
  for (let round = 0; round < maxRounds; round++) {
    const ids = new Set<string>();
    const occ: any = await client.patternLayout.getPageOccupancy({ context: ctx, includeWires: true });
    for (const it of occ.items ?? []) ids.add(String(it.objectId));
    const wires: any = await client.canvasOps.listWireSegments({ context: ctx } as any);
    for (const w of wires.wires ?? []) ids.add(String(w.objectId));
    if (!ids.size) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty >= 2) return round;
      await sleep(700);
      continue;
    }
    consecutiveEmpty = 0;
    await client.canvasOps.deleteObjectsByIds({
      context: ctx,
      objectIds: [...ids].map((x) => BigInt(x)),
    } as any);
    await sleep(600);
  }
  throw new Error("清页（器件/导线）未干净，请手动检查活动页");
}

/** 器件+导线+装饰+账本；模块化整页重画前使用 */
export async function clearActivePageFull(client: C, ctx: P): Promise<void> {
  const rounds = await clearElectricalOnActivePage(client, ctx);
  const deco = await deleteAllPageDecorations(client, ctx);
  clearDecorationLedger();
  if (rounds === 0 && deco === 0) console.log("  活动页已空");
  else console.log(`  清页完成（器件/线 ${rounds} 轮，装饰 ${deco} 个）`);
}

export interface ExtBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function snapExt(v: number, step = 20) {
  return Math.round(v / step) * step;
}

/** 模块电路外包框 + 四周略放大（默认 40 ext，mod 20） */
export function padUnionBox(b: ExtBox, pad: number, snap = 20): ExtBox {
  return {
    x1: snapExt(b.x1 - pad, snap),
    y1: snapExt(b.y1 - pad, snap),
    x2: snapExt(b.x2 + pad, snap),
    y2: snapExt(b.y2 + pad, snap),
  };
}

// ─── 紧凑布局预算（见 docs/modular-layout-compact.md）─────────────

/** 全部坐标吸附基准；框边、标题、器件关键点都用它的整数倍 */
export const EXT_GRID = 20;
/** 模块框到内容的外扩（P4a padUnionBox 默认值） */
export const FRAME_PAD = 40;
/** 框到内容的最小净距，低于此值视为「框切内容」 */
export const MIN_CONTENT_CLEARANCE = 20;
/** 相邻模块框之间的标签走廊：跨模块只走 NetAlias，这段空间留给 stub 与网络名 */
export const LABEL_CORRIDOR = 60;
/** 页边距（page_box 到最外侧模块框） */
export const PAGE_MARGIN = 80;

export const boxW = (b: ExtBox) => b.x2 - b.x1;
export const boxH = (b: ExtBox) => b.y2 - b.y1;
export const boxArea = (b: ExtBox) => Math.max(0, boxW(b)) * Math.max(0, boxH(b));

/** 两框最近净距（重叠返回 0） */
export function gapBetweenBoxes(a: ExtBox, b: ExtBox) {
  const dx = Math.max(0, a.x1 - b.x2, b.x1 - a.x2);
  const dy = Math.max(0, a.y1 - b.y2, b.y1 - a.y2);
  return dx && dy ? Math.round(Math.hypot(dx, dy)) : dx + dy;
}

export function boxContains(outer: ExtBox, inner: ExtBox) {
  return inner.x1 >= outer.x1 && inner.y1 >= outer.y1 && inner.x2 <= outer.x2 && inner.y2 <= outer.y2;
}

export function boxesOverlap(a: ExtBox, b: ExtBox) {
  return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

/** 宏观区位带：top=电源/输入，left=调试/下载，center=主控，right=接口/指示，bottom=辅助 */
export type ZoneBand = "top" | "left" | "center" | "right" | "bottom";

export interface ModuleSpec {
  key: string;
  title: string;
  refs: string[];
  band: ZoneBand;
  /** 预估内容尺寸（ext）；缺省用 estimateModuleBox(refs.length) */
  w?: number;
  h?: number;
}

/**
 * 按器件数量粗估模块内容尺寸（ext）。
 * 只用于 P0 估页；P1 放完后应以 unionModuleBBox 的真实 bbox 为准。
 */
export function estimateModuleBox(refCount: number, opts?: { wide?: boolean }) {
  const perRow = opts?.wide ? 4 : 3;
  const cols = Math.min(refCount, perRow) || 1;
  const rows = Math.ceil(refCount / perRow) || 1;
  return {
    w: snapExt(120 + cols * 90),
    h: snapExt(120 + rows * 90),
  };
}

/**
 * 从模块清单反推「页面 + 各模块槽位」，模块之间只留 LABEL_CORRIDOR。
 *
 * 排版：top 带一行 → 中间行（left | center | right）→ bottom 带一行；
 * 每带内部左→右紧排，带整体水平居中，全部吸附 EXT_GRID。
 * 目的：替代「固定大页 + 固定 500×400 槽」导致的模块相距过远。
 */
export function planCompactZones(
  specs: ModuleSpec[],
  opts?: { corridor?: number; margin?: number; framePad?: number; minPageW?: number; minPageH?: number },
): { pageW: number; pageH: number; zones: Record<string, ExtBox> } {
  const corridor = opts?.corridor ?? LABEL_CORRIDOR;
  const margin = opts?.margin ?? PAGE_MARGIN;
  const framePad = opts?.framePad ?? FRAME_PAD;

  const sized = specs.map((s) => {
    const est = estimateModuleBox(s.refs.length);
    // 框会在内容四周外扩 framePad，标题还要占框上方一行
    return {
      spec: s,
      w: snapExt((s.w ?? est.w) + framePad * 2),
      h: snapExt((s.h ?? est.h) + framePad * 2 + EXT_GRID * 2),
    };
  });
  const pick = (band: ZoneBand) => sized.filter((s) => s.spec.band === band);

  const rowW = (items: typeof sized) =>
    items.reduce((sum, it, i) => sum + it.w + (i ? corridor : 0), 0);
  const rowH = (items: typeof sized) => items.reduce((m, it) => Math.max(m, it.h), 0);

  const top = pick("top");
  const mid = [...pick("left"), ...pick("center"), ...pick("right")];
  const bottom = pick("bottom");
  const rows = [top, mid, bottom].filter((r) => r.length);

  const contentW = Math.max(...rows.map(rowW), 0);
  const contentH = rows.reduce((sum, r, i) => sum + rowH(r) + (i ? corridor : 0), 0);

  const pageW = Math.max(opts?.minPageW ?? 0, snapExt(contentW + margin * 2));
  const pageH = Math.max(opts?.minPageH ?? 0, snapExt(contentH + margin * 2));

  const zones: Record<string, ExtBox> = {};
  let y = snapExt((pageH - contentH) / 2);
  for (const row of rows) {
    let x = snapExt((pageW - rowW(row)) / 2);
    const h = rowH(row);
    for (const it of row) {
      zones[it.spec.key] = { x1: x, y1: y, x2: snapExt(x + it.w), y2: snapExt(y + h) };
      x = snapExt(x + it.w + corridor);
    }
    y = snapExt(y + h + corridor);
  }
  return { pageW, pageH, zones };
}

/** 槽内锚点：距槽左上角的偏移（已吸附 EXT_GRID） */
export function atZone(zone: ExtBox, dx: number, dy: number) {
  return { x: snapExt(zone.x1 + dx), y: snapExt(zone.y1 + dy) };
}

/**
 * 按位号 union 器件 bbox；可选并入槽位内的匿名符号（如 +5V/GND）。
 * 无匹配器件时返回 null（勿用整槽位大框占位）。
 */
export function unionModuleBBox(
  map: Map<string, { id: bigint; bbox: { min: { x: unknown; y: unknown }; max: { x: unknown; y: unknown } } }>,
  refs: string[],
  opts?: { slot?: ExtBox; includeAnonymousInSlot?: boolean },
): ExtBox | null {
  const boxes: ExtBox[] = [];
  for (const [ref, v] of map) {
    const byRef = refs.some((r) => ref === r || ref.startsWith(`${r}#`));
    let inSlot = false;
    if (opts?.slot && opts.includeAnonymousInSlot) {
      const cx = (Number(v.bbox.min.x) + Number(v.bbox.max.x)) / 2;
      const cy = (Number(v.bbox.min.y) + Number(v.bbox.max.y)) / 2;
      const s = opts.slot;
      inSlot = cx >= s.x1 && cx <= s.x2 && cy >= s.y1 && cy <= s.y2;
    }
    if (!byRef && !inSlot) continue;
    boxes.push({
      x1: Number(v.bbox.min.x),
      y1: Number(v.bbox.min.y),
      x2: Number(v.bbox.max.x),
      y2: Number(v.bbox.max.y),
    });
  }
  if (!boxes.length) return null;
  return boxes.reduce(
    (u, b) => ({
      x1: Math.min(u.x1, b.x1),
      y1: Math.min(u.y1, b.y1),
      x2: Math.max(u.x2, b.x2),
      y2: Math.max(u.y2, b.y2),
    }),
    boxes[0],
  );
}

/** P4a 前：删掉页上旧框/字，避免重跑叠框 */
export async function prepareP4aDecorations(client: C, ctx: P) {
  const n = await deleteAllPageDecorations(client, ctx);
  clearDecorationLedger();
  if (n) console.log(`  已清除旧装饰 ${n} 个`);
}

/** P4a：一次调用完成模块框 + 中文标题 + 账本（避免只 placeRect 漏 placeText） */
export interface ModuleFrameBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export async function placeModuleFrameAndTitle(
  client: C,
  ctx: P,
  opts: {
    box: ModuleFrameBox;
    title: string;
    moduleKey?: string;
    titleDy?: number;
    titleOffsetX?: number;
    fontSize?: number;
  },
): Promise<{ rectId: bigint; textId: bigint }> {
  const { box, title, moduleKey, titleDy = 24, titleOffsetX = 20, fontSize = 11 } = opts;
  let rectId = 0n;
  let textId = 0n;

  const rr: any = await client.objPlace.placeRect({
    context: ctx,
    box: {
      min: { x: BigInt(box.x1), y: BigInt(box.y1) },
      max: { x: BigInt(box.x2), y: BigInt(box.y2) },
    },
    snapToGrid: true,
  } as any);
  rectId = BigInt(rr.objectId ?? 0);
  if (rectId > 0n) {
    recordDecoration({ kind: "rect", objectId: rectId, moduleKey, label: title });
  }

  const tr: any = await client.objPlace.placeText({
    context: ctx,
    localPos: { x: BigInt(box.x1 + titleOffsetX), y: BigInt(box.y1 - titleDy) },
    text: title,
    fontSize,
  } as any);
  textId = BigInt(tr.objectId ?? 0);
  if (textId > 0n) {
    recordDecoration({ kind: "text", objectId: textId, moduleKey, label: title });
  }

  return { rectId, textId };
}

/**
 * 活动页模块框 / 自由文本（含用户手动画的）；box 为 ext 坐标 Y 向下。
 * 部分客户端构建尚未生成该方法，故走 any 调用；调用方应先判存在或 try/catch。
 */
export async function listPageDecorations(client: C, ctx: P) {
  const resp: any = await (client.canvasOps as any).listPageDecorations({ context: ctx } as any);
  return (resp.items ?? []) as Array<{
    objectId: bigint;
    kind: number | string;
    box?: { min?: { x?: bigint; y?: bigint }; max?: { x?: bigint; y?: bigint } };
    text?: string;
  }>;
}

export type C = Awaited<ReturnType<typeof connect>>;
export type P = ReturnType<C["createProjectContext"]>;

export interface ExtPt { x: number; y: number }
export interface PinInfo { num: string; name: string; ext: ExtPt }

/** 用活动页 page_box.max.y 刷新 PAGE_TOP（导入方无法直接给 PAGE_TOP 赋值，须调此函数）。 */
export async function refreshPageTop(client: C, ctx: P) {
  try {
    const occ: any = await client.patternLayout.getPageOccupancy({ context: ctx, includeWires: false });
    const py = Number(occ.pageBox?.max?.y);
    if (py > 0) PAGE_TOP = py;
  } catch { /* keep default */ }
}

/**
 * 旧入口，仅为兼容保留。新脚本用 `hqMainWithProject`（`./lib/hq.js`）+ `refreshPageTop`
 * （per-RPC 截止时间 + 确定性 close），见 `docs/script-lifetime.md`。
 * 若仍调用本函数，调用方必须在 `finally` 里 `client.close()`。
 */
export async function openCtx() {
  const client = await connect({
    timeoutMs: Number(process.env.HQ_RPC_TIMEOUT_MS) || 30_000,
    ...(process.env.HQ_INSTANCE_ID ? { instanceId: process.env.HQ_INSTANCE_ID } : {}),
  });
  const active: any = await client.project.getActiveProject({ context: client.createEditorContext() });
  const projectId = active.project?.projectId;
  if (!projectId) throw new Error("请先在 HQ EDA 中打开原理图工程");
  const ctx = client.createProjectContext(projectId);
  await refreshPageTop(client, ctx);
  return { client, ctx, projectId: projectId as string };
}

export async function objJson(client: C, ctx: P, id: bigint) {
  const o: any = await client.canvasOps.getObjectJsonById({ context: ctx, objectId: id } as any);
  return JSON.parse(String(o.json ?? "{}"));
}

export async function occupancyMap(client: C, ctx: P) {
  const occ: any = await client.patternLayout.getPageOccupancy({ context: ctx, includeWires: false });
  const map = new Map<string, { id: bigint; bbox: any }>();
  const seen = new Map<string, number>();
  for (const it of occ.items ?? []) {
    const id = BigInt(String(it.objectId));
    let ref = String(it.objectId);
    try { const j = await objJson(client, ctx, id); ref = j.Reference ?? j.PartValue ?? ref; } catch { /* ignore */ }
    const n = (seen.get(ref) ?? 0) + 1;
    seen.set(ref, n);
    map.set(n === 1 ? ref : `${ref}#${n}`, { id, bbox: it.bbox });
  }
  return { map, pageBox: occ.pageBox, count: (occ.items ?? []).length };
}

export async function pinsOf(client: C, ctx: P, id: bigint): Promise<PinInfo[]> {
  const j = await objJson(client, ctx, id);
  const locX = Number(j.locX), locY = Number(j.locY);
  return (j.PortInstScalar ?? []).map((p: any) => ({
    num: String(p.PinNumber),
    name: String(p.PinName),
    ext: { x: Math.round(locX + Number(p.ex)), y: Math.round(PAGE_TOP - (locY - Number(p.ey))) },
  }));
}

export function idOf(map: Map<string, { id: bigint }>, ref: string): bigint {
  const e = map.get(ref);
  if (!e) throw new Error(`器件未找到: ${ref}`);
  return e.id;
}

export async function searchAndPlace(
  client: C, ctx: P, queries: string[], mpnPreferred: string | undefined,
  ref: string, value: string, x: number, y: number,
) {
  const qs = [mpnPreferred, ...queries].filter(Boolean) as string[];
  let hit: any; let models: any; let lastErr = "";
  for (const q of qs) {
    let page: any;
    try {
      page = await client.parts.searchParts({ query: q, requirements: { symbol: true, footprint: true }, pageSize: 30 });
    } catch (e) { lastErr = String(e); continue; }
    const cands = (page.items ?? []).filter((i: any) => i.hasSymbol && i.hasFootprint && i.manufacturer?.id);
    const ordered = mpnPreferred
      ? [...cands].sort((a: any, b: any) => (a.mpn === mpnPreferred ? -1 : b.mpn === mpnPreferred ? 1 : 0))
      : cands;
    for (const c of ordered) {
      try {
        const m = await client.parts.getEdaModels({ manufacturerId: c.manufacturer.id, mpn: c.mpn });
        if (m.symbol?.url) { hit = c; models = m; break; }
      } catch { /* next */ }
    }
    if (models) break;
  }
  if (!models?.symbol?.url || !hit) throw new Error(`part-search 无可用 symbol: ${queries[0]} ${lastErr}`);

  const res: any = await client.componentPlace.placeKicadSymbol({
    context: ctx,
    localPos: { x: BigInt(Math.round(x)), y: BigInt(Math.round(y)) },
    component: {
      componentName: `${ref}_${hit.mpn}`,
      symbolResource: { uri: models.symbol.url },
      footprintResources: models.footprint?.url
        ? [{ uri: models.footprint.url, models: models.model3d?.url ? [{ uri: models.model3d.url }] : [] }]
        : [],
      attributes: [
        { name: "Reference", value: ref },
        { name: "Value", value },
        { name: "Footprint", value: models.footprint?.fileName ?? hit.package ?? "" },
        { name: "MPN", value: hit.mpn },
      ],
    },
  } as any);
  if (!res.success || !res.objectId) throw new Error(`PlaceKicadSymbol 失败 ${ref}: ${toJsonString(res)}`);
  const id = BigInt(String(res.objectId));
  await setRefValue(client, ctx, id, ref, value);
  return { id, mpn: hit.mpn };
}

export async function waitForIds(client: C, ctx: P, ids: bigint[], label: string) {
  for (let i = 0; i < 60; i++) {
    const occ: any = await client.patternLayout.getPageOccupancy({ context: ctx, includeWires: false });
    const set = new Set((occ.items ?? []).map((o: any) => String(o.objectId)));
    if (!ids.some((id) => !set.has(String(id)))) { console.log(`  ✓ ${label} 已注册 (${i + 1} 轮)`); return true; }
    await sleep(300);
  }
  console.log(`  ! ${label} 未全部注册，继续`);
  return false;
}

export const manhattan = (a: ExtPt, b: ExtPt) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * 水平母线 + 中点网络别名：去耦并联排（拓扑 B）等「一条轨带多个器件」的画法。
 * 两端 x 取该排最外侧器件脚，y 取轨高度；随后各器件脚用 autoConnect 接到轨上。
 */
export async function placeHorizontalRail(
  client: C, ctx: P, net: string, x1: number, x2: number, y: number,
): Promise<{ wireObjectId: bigint; aliasObjectId: bigint }> {
  const w: any = await client.objPlace.placeWire({
    context: ctx,
    geometry: {
      start: { x: BigInt(Math.round(x1)), y: BigInt(Math.round(y)) },
      end: { x: BigInt(Math.round(x2)), y: BigInt(Math.round(y)) },
    },
    snapToGrid: true,
  } as any);
  await sleep(300);
  const a: any = await client.objPlace.placeNetAliasAt({
    context: ctx,
    localPos: { x: BigInt(Math.round((x1 + x2) / 2)), y: BigInt(Math.round(y)) },
    netName: net, attachObjectId: 0n, snapToGrid: true,
  } as any);
  await sleep(300);
  return { wireObjectId: w.lineObjectId ?? 0n, aliasObjectId: a.objectId ?? 0n };
}

// ─── 流程 C：模块级外科手术（禁止整页重画）─────────────────────

/**
 * 模块爆炸半径：该模块 refs 的器件 id + 落在这些器件附近的导线 id。
 *
 * 导线归属靠 **端点落在器件 bbox（外扩 pad）内** 判定：`listWireSegments().wires`
 * 只有几何与 `netName`，没有「属于哪个器件」。pad 默认 40 ext ≈ pin stub 伸出量。
 * 注意导线 y 是画布向上坐标，需 `PAGE_TOP - y` 换成 ext（Y 向下）。
 */
export async function moduleBlastRadius(
  client: C, ctx: P, refs: string[], pad = 40,
): Promise<{ partIds: bigint[]; partRefs: string[]; wireIds: bigint[]; bbox: ExtBox | null }> {
  const { map } = await occupancyMap(client, ctx);
  const partIds: bigint[] = [];
  const partRefs: string[] = [];
  const boxes: ExtBox[] = [];
  for (const [ref, v] of map) {
    if (!refs.some((r) => ref === r || ref.startsWith(`${r}#`))) continue;
    partIds.push(v.id);
    partRefs.push(ref);
    boxes.push({
      x1: Number(v.bbox.min.x), y1: Number(v.bbox.min.y),
      x2: Number(v.bbox.max.x), y2: Number(v.bbox.max.y),
    });
  }
  const bbox = boxes.length
    ? boxes.reduce((u, b) => ({
      x1: Math.min(u.x1, b.x1), y1: Math.min(u.y1, b.y1),
      x2: Math.max(u.x2, b.x2), y2: Math.max(u.y2, b.y2),
    }))
    : null;

  const wireIds: bigint[] = [];
  if (bbox) {
    const zone: ExtBox = { x1: bbox.x1 - pad, y1: bbox.y1 - pad, x2: bbox.x2 + pad, y2: bbox.y2 + pad };
    const wires: any = await client.canvasOps.listWireSegments({ context: ctx } as any);
    for (const w of wires.wires ?? []) {
      const pts = [
        { x: Number(w.start?.x), y: PAGE_TOP - Number(w.start?.y) },
        { x: Number(w.end?.x), y: PAGE_TOP - Number(w.end?.y) },
      ];
      if (!pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
      if (pts.some((p) => p.x >= zone.x1 && p.x <= zone.x2 && p.y >= zone.y1 && p.y <= zone.y2)) {
        wireIds.push(BigInt(String(w.objectId)));
      }
    }
  }
  return { partIds, partRefs, wireIds, bbox };
}

/** 删除模块爆炸半径内的器件 + 导线（**不含装饰**；框/字用 deleteModuleDecorations） */
export async function deleteModuleBlastRadius(
  client: C, ctx: P, refs: string[], pad = 40,
): Promise<{ partIds: bigint[]; wireIds: bigint[] }> {
  const r = await moduleBlastRadius(client, ctx, refs, pad);
  const ids = [...r.partIds, ...r.wireIds];
  if (ids.length) {
    await client.canvasOps.deleteObjectsByIds({ context: ctx, objectIds: ids } as any);
    await sleep(600);
  }
  return { partIds: r.partIds, wireIds: r.wireIds };
}

/**
 * 平移一批对象到目标 ext 位移。`MoveObjectsByIds` 用 **窗口像素** 坐标，
 * 比例随缩放变化，所以先用 1 个参考对象标定 px→ext，再按比例整批下发，
 * 最后按残差迭代最多 `maxIters` 轮。
 */
export async function moveExtBatch(
  client: C, ctx: P, ids: bigint[], dxExt: number, dyExt: number,
  maxIters = 3,
): Promise<{ ok: boolean; actual: { dx: number; dy: number } }> {
  if (!ids.length || (dxExt === 0 && dyExt === 0)) return { ok: true, actual: { dx: 0, dy: 0 } };
  const probeId = ids[0];

  const bboxById = async (id: bigint): Promise<{ x1: number; y1: number } | null> => {
    const { map } = await occupancyMap(client, ctx);
    for (const [, v] of map) {
      if (v.id === id) return { x1: Number(v.bbox.min.x), y1: Number(v.bbox.min.y) };
    }
    return null;
  };

  const start = await bboxById(probeId);
  if (!start) return { ok: false, actual: { dx: 0, dy: 0 } };

  const probeWin = 100;
  const calib: any = await client.canvasOps.moveObjectsByIds({
    context: ctx, objectIds: [probeId],
    windowX: probeWin, windowY: probeWin, prevWindowX: 0, prevWindowY: 0,
  } as any).catch(() => null);
  if (!calib || (calib.value !== true && calib.success !== true)) {
    return { ok: false, actual: { dx: 0, dy: 0 } };
  }
  await sleep(700);
  const afterCalib = await bboxById(probeId);
  if (!afterCalib) return { ok: false, actual: { dx: 0, dy: 0 } };
  const pxPerExtX = (afterCalib.x1 - start.x1) / probeWin;
  const pxPerExtY = (afterCalib.y1 - start.y1) / probeWin;
  if (!Number.isFinite(pxPerExtX) || !Number.isFinite(pxPerExtY)
    || Math.abs(pxPerExtX) < 1e-6 || Math.abs(pxPerExtY) < 1e-6) {
    return { ok: false, actual: { dx: afterCalib.x1 - start.x1, dy: afterCalib.y1 - start.y1 } };
  }
  // 标定本身已移动 probe，计入残差
  let movedX = afterCalib.x1 - start.x1;
  let movedY = afterCalib.y1 - start.y1;

  for (let i = 0; i < maxIters; i++) {
    const remX = dxExt - movedX;
    const remY = dyExt - movedY;
    if (Math.abs(remX) < 4 && Math.abs(remY) < 4) break;
    const wx = Math.round(remX / pxPerExtX);
    const wy = Math.round(remY / pxPerExtY);
    if (wx === 0 && wy === 0) break;
    const r: any = await client.canvasOps.moveObjectsByIds({
      context: ctx, objectIds: ids,
      windowX: wx, windowY: wy, prevWindowX: 0, prevWindowY: 0,
    } as any).catch(() => null);
    if (!r || (r.value !== true && r.success !== true)) break;
    await sleep(700);
    const now = await bboxById(probeId);
    if (!now) break;
    movedX = now.x1 - start.x1;
    movedY = now.y1 - start.y1;
  }
  return { ok: true, actual: { dx: movedX, dy: movedY } };
}

export const toJson = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));

export async function setRefValue(client: C, ctx: P, objectId: bigint, ref: string, value: string) {
  await client.canvasOps.setObjectProperty({ context: ctx, objectId, propKey: "Part Reference", propValue: ref, op: 1, commitUndo: true });
  await client.canvasOps.setObjectProperty({ context: ctx, objectId, propKey: "Value", propValue: value, op: 1, commitUndo: true });
}

/** 活动页网络列表（Connect-ES 响应形状） */
export async function activePageNets(client: C, ctx: P) {
  const resp: any = await client.netList.getActivePageNetList({ context: ctx } as any);
  return (resp.result?.value?.nets ?? resp.result?.netlist?.nets ?? []) as Array<{
    name: string;
    pinReferences?: Array<{ referenceDesignator: string; pinNumber: string }>;
  }>;
}

function netlistFingerprint(
  nets: Array<{ name: string; pinReferences?: Array<{ referenceDesignator: string; pinNumber: string }> }>,
) {
  const sorted = [...nets].sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(
    sorted.map((n) => ({
      name: n.name,
      pins: (n.pinReferences ?? [])
        .map((p) => `${p.referenceDesignator}:${p.pinNumber}`)
        .sort(),
    })),
  );
}

/** 写操作后轮询 netlist，连续两轮指纹相同视为稳定（见 docs/troubleshooting-power-nets.md） */
export async function waitForNetlistStable(
  client: C,
  ctx: P,
  opts: { expectNetNames?: string[]; maxRounds?: number; intervalMs?: number; label?: string } = {},
) {
  const { expectNetNames, maxRounds = 24, intervalMs = 400, label = "netlist" } = opts;
  let prev = "";
  let lastNets: Awaited<ReturnType<typeof activePageNets>> = [];
  for (let i = 0; i < maxRounds; i++) {
    lastNets = await activePageNets(client, ctx);
    if (expectNetNames?.length) {
      const names = new Set(lastNets.map((n) => n.name));
      if (!expectNetNames.every((n) => names.has(n))) {
        prev = "";
        await sleep(intervalMs);
        continue;
      }
    }
    const fp = netlistFingerprint(lastNets);
    if (fp === prev) {
      console.log(`  ✓ ${label} 已稳定 (${i + 1} 轮, ${lastNets.length} nets)`);
      return { nets: lastNets, stable: true as const };
    }
    prev = fp;
    await sleep(intervalMs);
  }
  console.log(`  ! ${label} 未在 ${maxRounds} 轮内稳定，使用最后一次结果`);
  return { nets: lastNets, stable: false as const };
}

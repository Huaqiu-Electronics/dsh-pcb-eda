/**
 * Scenario B · 模块化布局公共库
 *
 * - 活动页引脚：优先 getObjectJsonById → PortInstScalar（勿依赖陈旧 snapshot）
 * - ext 坐标 Y 向下：ext.y = PAGE_TOP − 画布原始 y。PAGE_TOP 是页面上边在画布里的原始 y
 *   （setPageSize 的 rbY），**不是** page_box.max.y —— page_box 会被归一化成 [0,0]-[W,H]。
 *   一律用 calibratePageTop 按已有对象标定；改页用 setPageExt（保持上边不动）。
 */
import { connect, toJsonString } from "@huaqiu/huaqiu-client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 空页时使用的页面上边原始 y（pattern 引擎按此锚点校验 anchor 是否在页内） */
export const PAGE_TOP_ANCHOR = 1400;
export let PAGE_TOP = PAGE_TOP_ANCHOR;
/** listWireSegments 是否直接返回 ext 坐标；null = 尚未标定，按端点命中率猜 */
let WIRE_RPC_IS_EXT: boolean | null = null;
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
  const objs = await selectAllJson(client, ctx);
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

/** selectAll + getSelectedObjectsJson：活动页全部对象的原始 JSON（坐标为画布原始值，Y 向上） */
export async function selectAllJson(client: C, ctx: P): Promise<any[]> {
  const c: any = client.canvasOps;
  await c.clearAllSel({ context: ctx } as any).catch(() => {});
  await c.selectAll({ context: ctx } as any);
  await sleep(700);
  const sel: any = await c.getSelectedObjectsJson({ context: ctx } as any);
  await c.clearAllSel({ context: ctx } as any).catch(() => {});
  return (sel.jsonList ?? [])
    .map((o: any) => {
      if (o && typeof o === "object") return o;
      if (typeof o === "string" && o.trim()) { try { return JSON.parse(o); } catch { return null; } }
      return null;
    })
    .filter(Boolean);
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

/** 模块框密度下限（%）：P4a 网格拉框与 layout-audit 共用 */
export const MODULE_DENSITY_LOW = 35;
/** 器件数不超过此值的模块不参与密度判据（P4a 不退回紧框，审计只提示不报警） */
export const SMALL_MODULE_PARTS = 4;
/** 器件数不超过此值的电路块不单独成模块，须 `attachTo` 并入相连的功能模块 */
export const MERGE_MAX_PARTS = 3;
/** 框内左上角标题带高度（ext） */
export const TITLE_BAND = 40;
/** 框内左下角说明带高度（ext，仅 note 非空时预留） */
export const NOTE_BAND = 40;

/** 网格占用率（%）：box 内按 cell 划格，被 items 覆盖的格子比例 */
export function gridOccupancy(box: ExtBox, items: ExtBox[], cell = EXT_GRID) {
  const cols = Math.max(1, Math.ceil(boxW(box) / cell));
  const rows = Math.max(1, Math.ceil(boxH(box) / cell));
  const grid = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (const it of items) {
    const cx1 = Math.max(0, Math.floor((it.x1 - box.x1) / cell));
    const cx2 = Math.min(cols - 1, Math.floor((it.x2 - 1 - box.x1) / cell));
    const cy1 = Math.max(0, Math.floor((it.y1 - box.y1) / cell));
    const cy2 = Math.min(rows - 1, Math.floor((it.y2 - 1 - box.y1) / cell));
    for (let y = cy1; y <= cy2; y++) for (let x = cx1; x <= cx2; x++) grid[y][x] = 1;
  }
  let used = 0;
  for (const row of grid) for (const c of row) used += c;
  return { pct: (used / (cols * rows)) * 100, grid, cols, rows };
}

/** 旧版行布局（layout: "rows"）的区位带 */
export type ZoneBand = "top" | "left" | "center" | "right" | "bottom";

export type PlanLayout = "grid" | "rows";

export interface ModuleSpec {
  key: string;
  /** 功能电路名，画在框内左上角 */
  title: string;
  refs: string[];
  /** 必要的设计说明（一行），画在框内左下角 */
  note?: string;
  /** 小电路块（≤ MERGE_MAX_PARTS 个器件）并入的目标模块 key；由 mergeSmallModules 处理 */
  attachTo?: string;
  /** grid：列号（从 0 起）。主控所在列可以是任意列 */
  col?: number;
  /** grid：列内自上而下的顺序；缺省按清单出现顺序 */
  order?: number;
  /** grid：同列同 group 的模块并排成一层（如复位 + 晶振） */
  group?: string;
  /** grid：底部整宽模块，从 col 起跨 span 列；不参与列内堆叠 */
  span?: number;
  /** rows：区位带（仅 layout: "rows" 使用） */
  band?: ZoneBand;
  /** 内容尺寸（ext）；缺省用 estimateModuleBox(refs.length)。P3.5 收拢时由真实 union 覆盖 */
  w?: number;
  h?: number;
}

export interface CompactPlan {
  layout: PlanLayout;
  pageW: number;
  pageH: number;
  /** 内容放置区（含 framePad），P1 用 atZone 取锚点；位于 cell 内居中 */
  zones: Record<string, ExtBox>;
  /** 网格单元 = P4a 画框位置；同层同顶同底、同列同左同右，单元之间隔 corridor */
  cells: Record<string, ExtBox>;
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

export interface PlanOptions {
  layout?: PlanLayout;
  corridor?: number;
  margin?: number;
  framePad?: number;
  minPageW?: number;
  minPageH?: number;
}

const floorGrid = (v: number) => Math.floor(v / EXT_GRID) * EXT_GRID;

/** 把 total（20 的倍数）拆成 n 份 20 的倍数，余数给前几份 */
function splitExtra(total: number, n: number): number[] {
  if (n <= 0) return [];
  const steps = Math.max(0, Math.round(total / EXT_GRID));
  const base = Math.floor(steps / n);
  const rem = steps - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < rem ? 1 : 0)) * EXT_GRID);
}

/** 内容区在单元内居中（向下取整到网格，不越出单元） */
function centerIn(cell: ExtBox, w: number, h: number): ExtBox {
  const x1 = cell.x1 + floorGrid(Math.max(0, boxW(cell) - w) / 2);
  const y1 = cell.y1 + floorGrid(Math.max(0, boxH(cell) - h) / 2);
  return { x1, y1, x2: x1 + w, y2: y1 + h };
}

/**
 * 从模块清单反推「页面 + 各模块槽位」，模块之间只留 LABEL_CORRIDOR。
 *
 * layout "grid"（默认）：规整网格。
 *   - 每个模块属于一列（col），列内按 order 自上而下堆叠；同列同 group 的模块并排成一层。
 *   - 列宽 = 列内最宽层；网格高 = 最高列；较矮列把余量分摊到各层，所有列顶底对齐。
 *   - 层内并排模块把列宽余量分摊到各自单元，同层同顶同底、同列同左同右。
 *   - 带 span 的模块放在网格下方一行，从 col 起跨 span 列。
 *   主控所在列不限，按与之相连的引脚就近给外围模块选列。
 * layout "rows"：旧版 top / (left|center|right) / bottom 三行平铺，仅为兼容保留。
 */
export function planCompactZones(specs: ModuleSpec[], opts?: PlanOptions): CompactPlan {
  const layout = opts?.layout ?? "grid";
  return layout === "rows" ? planRows(specs, opts) : planGrid(specs, opts);
}

/**
 * 把 ≤ MERGE_MAX_PARTS 个器件的小电路块并入 `attachTo` 指定的功能模块（refs 合并、尺寸放大）。
 * 小块未给 attachTo 时抛错：两三个器件不单独成框，先想清楚它服务哪个功能电路
 * （如复位/BOOT/指示灯 → 主控，CC 下拉/ESD → USB 接口，输入输出电容 → 稳压）。
 * 返回新清单，P0 / P3.5 / P4a 都用它。
 */
export function mergeSmallModules(specs: ModuleSpec[], opts?: { maxParts?: number }): ModuleSpec[] {
  const maxParts = opts?.maxParts ?? MERGE_MAX_PARTS;
  const out = specs.map((s) => ({ ...s, refs: [...s.refs] }));
  const byKey = new Map(out.map((s) => [s.key, s]));
  const targets = new Set(out.map((s) => s.attachTo).filter(Boolean));
  // 被并入的宿主、显式给 w/h 的多脚器件模块（主控等）不算小块
  const orphans = out.filter((s) => s.refs.length <= maxParts && !s.attachTo
    && !targets.has(s.key) && s.w == null && s.h == null);
  if (orphans.length) {
    throw new Error(
      `mergeSmallModules: 小电路块 ${orphans.map((s) => `${s.key}(${s.refs.length} 件)`).join(", ")} `
      + "需指定 attachTo（并入与之相连的功能模块），不要单独成模块",
    );
  }
  const resolve = (key: string, seen = new Set<string>()): ModuleSpec => {
    const t = byKey.get(key);
    if (!t) throw new Error(`mergeSmallModules: attachTo 目标不存在: ${key}`);
    if (!t.attachTo) return t;
    if (seen.has(key)) throw new Error(`mergeSmallModules: attachTo 成环: ${key}`);
    seen.add(key);
    return resolve(t.attachTo, seen);
  };
  // 显式尺寸的宿主：小块在宿主旁竖向叠成一列（宽取最宽小块，高取累加）
  const side = new Map<ModuleSpec, { w: number; h: number }>();
  for (const s of out) {
    if (!s.attachTo) continue;
    const t = resolve(s.attachTo);
    t.refs.push(...s.refs);
    const est = estimateModuleBox(s.refs.length);
    const acc = side.get(t) ?? { w: 0, h: 0 };
    acc.w = Math.max(acc.w, s.w ?? est.w);
    acc.h += s.h ?? est.h;
    side.set(t, acc);
  }
  for (const [t, acc] of side) {
    if (t.w == null && t.h == null) continue;
    t.w = (t.w ?? 0) + acc.w;
    t.h = Math.max(t.h ?? 0, acc.h);
  }
  return out.filter((s) => !s.attachTo);
}

const bandTop = (_s: ModuleSpec) => TITLE_BAND;
const bandBottom = (s: ModuleSpec) => (s.note ? NOTE_BAND : 0);

/** 单元扣掉标题带 / 说明带后的内容区 */
function cellInner(cell: ExtBox, s: ModuleSpec): ExtBox {
  return { x1: cell.x1, y1: cell.y1 + bandTop(s), x2: cell.x2, y2: cell.y2 - bandBottom(s) };
}

function sizeSpecs(specs: ModuleSpec[], framePad: number, titleRows: number) {
  return specs.map((s, idx) => {
    const est = estimateModuleBox(s.refs.length);
    const cw = snapExt((s.w ?? est.w) + framePad * 2);
    const ch = snapExt((s.h ?? est.h) + framePad * 2);
    return {
      spec: s,
      idx,
      /** 内容区（不含标题/说明带） */
      cw,
      ch,
      w: cw,
      h: ch + EXT_GRID * titleRows + bandTop(s) + bandBottom(s),
    };
  });
}

/** 框 = 内容外包 + framePad，上方留标题带、下方留说明带（框内写字，不压器件） */
export function frameAroundContent(bbox: ExtBox, s: Pick<ModuleSpec, "note">, framePad = FRAME_PAD): ExtBox {
  const b = padUnionBox(bbox, framePad);
  return { x1: b.x1, y1: b.y1 - TITLE_BAND, x2: b.x2, y2: b.y2 + (s.note ? NOTE_BAND : 0) };
}

function planGrid(specs: ModuleSpec[], opts?: PlanOptions): CompactPlan {
  const corridor = opts?.corridor ?? LABEL_CORRIDOR;
  const margin = opts?.margin ?? PAGE_MARGIN;
  const framePad = opts?.framePad ?? FRAME_PAD;
  // 标题 / 说明写在框内左上 / 左下，单元高度已含 TITLE_BAND / NOTE_BAND
  const sized = sizeSpecs(specs, framePad, 0);
  type Item = (typeof sized)[number];

  const stacked = sized.filter((s) => !s.spec.span);
  const spanning = sized.filter((s) => s.spec.span);

  const colIds = [...new Set(stacked.map((s) => s.spec.col ?? 0))].sort((a, b) => a - b);
  const maxCol = Math.max(0, ...colIds, ...spanning.map((s) => (s.spec.col ?? 0) + (s.spec.span ?? 1) - 1));

  interface Layer { items: Item[]; w: number; h: number; ord: number }
  const columns = new Map<number, Layer[]>();
  for (const c of colIds) {
    const inCol = stacked.filter((s) => (s.spec.col ?? 0) === c);
    const layers: Layer[] = [];
    const byGroup = new Map<string, Layer>();
    for (const it of inCol) {
      const ord = it.spec.order ?? it.idx;
      const g = it.spec.group;
      const layer = g ? byGroup.get(g) : undefined;
      if (layer) {
        layer.items.push(it);
        layer.ord = Math.min(layer.ord, ord);
      } else {
        const l: Layer = { items: [it], w: 0, h: 0, ord };
        layers.push(l);
        if (g) byGroup.set(g, l);
      }
    }
    for (const l of layers) {
      l.items.sort((a, b) => (a.spec.order ?? a.idx) - (b.spec.order ?? b.idx));
      l.w = l.items.reduce((s, it, i) => s + it.w + (i ? corridor : 0), 0);
      l.h = Math.max(...l.items.map((it) => it.h));
    }
    layers.sort((a, b) => a.ord - b.ord);
    columns.set(c, layers);
  }

  // 列宽：没有堆叠模块、只被 span 覆盖的列宽度记 0，由 span 模块撑开
  const colW = new Map<number, number>();
  for (let c = 0; c <= maxCol; c++) {
    colW.set(c, Math.max(0, ...(columns.get(c) ?? []).map((l) => l.w)));
  }
  for (const it of spanning) {
    const c0 = it.spec.col ?? 0;
    const n = it.spec.span ?? 1;
    const cols = Array.from({ length: n }, (_, i) => c0 + i);
    const have = cols.reduce((s, c, i) => s + (colW.get(c) ?? 0) + (i ? corridor : 0), 0);
    if (it.w > have) {
      const extra = splitExtra(it.w - have, n);
      cols.forEach((c, i) => colW.set(c, (colW.get(c) ?? 0) + extra[i]));
    }
  }

  const colHeight = (layers: Layer[]) => layers.reduce((s, l, i) => s + l.h + (i ? corridor : 0), 0);
  const gridH = Math.max(0, ...[...columns.values()].map(colHeight));
  const bottomH = spanning.length ? Math.max(...spanning.map((s) => s.h)) : 0;

  const usedCols = Array.from({ length: maxCol + 1 }, (_, c) => c).filter((c) => (colW.get(c) ?? 0) > 0);
  const contentW = usedCols.reduce((s, c, i) => s + (colW.get(c) ?? 0) + (i ? corridor : 0), 0);
  const contentH = gridH + (spanning.length ? (gridH ? corridor : 0) + bottomH : 0);

  const pageW = Math.max(opts?.minPageW ?? 0, snapExt(contentW + margin * 2));
  const pageH = Math.max(opts?.minPageH ?? 0, snapExt(contentH + margin * 2));
  const x0 = floorGrid((pageW - contentW) / 2);
  const y0 = floorGrid((pageH - contentH) / 2);

  const colX = new Map<number, number>();
  let cx = x0;
  for (const c of usedCols) {
    colX.set(c, cx);
    cx += (colW.get(c) ?? 0) + corridor;
  }

  const zones: Record<string, ExtBox> = {};
  const cells: Record<string, ExtBox> = {};

  for (const [c, layers] of columns) {
    const x = colX.get(c) ?? x0;
    const w = colW.get(c) ?? 0;
    const extraH = splitExtra(gridH - colHeight(layers), layers.length);
    let y = y0;
    layers.forEach((l, li) => {
      const h = l.h + extraH[li];
      const extraW = splitExtra(w - l.w, l.items.length);
      let lx = x;
      l.items.forEach((it, ii) => {
        const cw = it.w + extraW[ii];
        const cell = { x1: lx, y1: y, x2: lx + cw, y2: y + h };
        cells[it.spec.key] = cell;
        zones[it.spec.key] = centerIn(cellInner(cell, it.spec), it.cw, it.ch);
        lx += cw + corridor;
      });
      y += h + corridor;
    });
  }

  const by = y0 + (gridH ? gridH + corridor : 0);
  for (const it of spanning) {
    const c0 = it.spec.col ?? 0;
    const cols = Array.from({ length: it.spec.span ?? 1 }, (_, i) => c0 + i).filter((c) => colX.has(c));
    if (!cols.length) continue;
    const x1 = colX.get(cols[0])!;
    const last = cols[cols.length - 1];
    const x2 = colX.get(last)! + (colW.get(last) ?? 0);
    const cell = { x1, y1: by, x2, y2: by + bottomH };
    cells[it.spec.key] = cell;
    zones[it.spec.key] = centerIn(cellInner(cell, it.spec), it.cw, it.ch);
  }

  return { layout: "grid", pageW, pageH, zones, cells };
}

function planRows(specs: ModuleSpec[], opts?: PlanOptions): CompactPlan {
  const corridor = opts?.corridor ?? LABEL_CORRIDOR;
  const margin = opts?.margin ?? PAGE_MARGIN;
  const framePad = opts?.framePad ?? FRAME_PAD;

  // 旧版行布局：除框内标题/说明带外，再多留两行
  const sized = sizeSpecs(specs, framePad, 2);
  const pick = (band: ZoneBand) => sized.filter((s) => (s.spec.band ?? "center") === band);

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
  return { layout: "rows", pageW, pageH, zones, cells: { ...zones } };
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
    const byRef = refMatches(ref, refs);
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
    /** 一行设计说明，写在框内左下角 */
    note?: string;
    /** 标题距框上边（向内） */
    titleDy?: number;
    /** 说明距框下边（向内） */
    noteDy?: number;
    titleOffsetX?: number;
    fontSize?: number;
    noteFontSize?: number;
  },
): Promise<{ rectId: bigint; textId: bigint; noteId: bigint }> {
  const {
    box, title, moduleKey, note,
    titleDy = 24, noteDy = 16, titleOffsetX = 20, fontSize = 11, noteFontSize = 9,
  } = opts;
  let rectId = 0n;
  let textId = 0n;
  let noteId = 0n;

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
    localPos: { x: BigInt(box.x1 + titleOffsetX), y: BigInt(box.y1 + titleDy) },
    text: title,
    fontSize,
  } as any);
  textId = BigInt(tr.objectId ?? 0);
  if (textId > 0n) {
    recordDecoration({ kind: "text", objectId: textId, moduleKey, label: title });
  }

  if (note) {
    const nr: any = await client.objPlace.placeText({
      context: ctx,
      localPos: { x: BigInt(box.x1 + titleOffsetX), y: BigInt(box.y2 - noteDy) },
      text: note,
      fontSize: noteFontSize,
    } as any);
    noteId = BigInt(nr.objectId ?? 0);
    if (noteId > 0n) {
      recordDecoration({ kind: "text", objectId: noteId, moduleKey, label: note });
    }
  }

  return { rectId, textId, noteId };
}

export interface GridFrameResult {
  key: string;
  mode: "grid" | "tight" | "skipped";
  /** 拉齐后框内密度（%，与 layout-audit 同算法） */
  density: number;
  box?: ExtBox;
  rectId?: bigint;
  textId?: bigint;
  noteId?: bigint;
}

/**
 * P4a（grid）：框 = 网格单元，同层同顶同底、同列同左同右，整页像一张规整表格。
 *
 * 对每个模块用 `gridOccupancy`（与 layout-audit 相同）算单元内密度：
 *   - 密度 ≥ minDensity → 画在单元上（拉齐）；
 *   - 密度 < minDensity → 报警并退回紧框（外包 + framePad），提示合并、并排或换列；
 *     器件 ≤ SMALL_MODULE_PARTS 的小模块（晶振、复位、SWD、BOOT…）本体只占几格，
 *     密度天然很低，不按密度退回，保持网格对齐；
 *   - 内容超出单元 → 报警并退回紧框（说明 P3.5 没做或之后又加了器件）；
 *   - 单元内没有对象 → 不画框（禁止空框）。
 * 默认先清全页旧框/字（整页 P4a）；流程 C 单模块修补不要用本函数。
 */
export async function placeGridFrames(
  client: C, ctx: P, specs: ModuleSpec[], plan: CompactPlan,
  opts?: { minDensity?: number; framePad?: number; clearFirst?: boolean },
): Promise<GridFrameResult[]> {
  const minDensity = opts?.minDensity ?? MODULE_DENSITY_LOW;
  const framePad = opts?.framePad ?? FRAME_PAD;
  if (opts?.clearFirst !== false) await prepareP4aDecorations(client, ctx);

  const { map } = await occupancyMap(client, ctx);
  const allRefs = specs.flatMap((s) => s.refs);
  const out: GridFrameResult[] = [];

  for (const s of specs) {
    const cell = plan.cells[s.key];
    if (!cell) continue;
    const o = await collectModuleObjects(client, ctx, s.refs, cell, { allRefs, map, skipWires: true });
    if (!o.bbox) {
      console.warn(`  ! [${s.key}] 单元内没有对象，不画框`);
      out.push({ key: s.key, mode: "skipped", density: 0 });
      continue;
    }
    if (s.refs.length <= MERGE_MAX_PARTS && s.w == null && s.h == null) {
      console.warn(`  ! [${s.key}] 只有 ${s.refs.length} 个器件，应 attachTo 并入相连的功能模块（mergeSmallModules）`);
    }
    const tight = frameAroundContent(o.bbox, s, framePad);
    const density = gridOccupancy(cell, o.boxes).pct;
    let box: ExtBox = cell;
    let mode: GridFrameResult["mode"] = "grid";
    if (!boxContains(cell, tight)) {
      console.warn(`  ! [${s.key}] 内容超出网格单元，退回紧框（先跑 repackModules）`);
      box = tight;
      mode = "tight";
    } else if (density < minDensity && s.refs.length > SMALL_MODULE_PARTS) {
      console.warn(
        `  ! [${s.key}] 拉齐后密度 ${density.toFixed(0)}% < ${minDensity}%，退回紧框；`
        + "建议与同列小模块合并、改为并排，或换到更矮的列",
      );
      box = tight;
      mode = "tight";
    }
    const r = await placeModuleFrameAndTitle(client, ctx, { box, title: s.title, note: s.note, moduleKey: s.key });
    out.push({ key: s.key, mode, density, box, rectId: r.rectId, textId: r.textId, noteId: r.noteId });
  }
  return out;
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

export async function openCtx() {
  const client = await connect(
    process.env.HQ_INSTANCE_ID ? { instanceId: process.env.HQ_INSTANCE_ID } : undefined,
  );
  const active: any = await client.project.getActiveProject({ context: client.createEditorContext() });
  const projectId = active.project?.projectId;
  if (!projectId) throw new Error("请先在 HQ EDA 中打开原理图工程");
  const ctx = client.createProjectContext(projectId);
  await calibratePageTop(client, ctx).catch(() => { /* keep default */ });
  return { client, ctx, projectId: projectId as string };
}

/**
 * getPageOccupancy 刚连接或刚写入后偶发返回 0 项（异步快照）：为空时重试几轮。
 * 真正的空页会多等约 1 s，可接受。
 */
async function occupancyItems(client: C, ctx: P): Promise<{ items: any[]; pageBox: any }> {
  let occ: any = null;
  for (let i = 0; i < 3; i++) {
    occ = await client.patternLayout.getPageOccupancy({ context: ctx, includeWires: false });
    if ((occ.items ?? []).length) break;
    await sleep(400);
  }
  return { items: occ?.items ?? [], pageBox: occ?.pageBox };
}

/**
 * 标定 PAGE_TOP（页面上边的画布原始 y），并记下 listWireSegments 是否已是 ext 坐标。
 *
 * 1. 导线：同一 id 的 selectAll 原始端点 sy 与 listWireSegments 的 y 相加即 PAGE_TOP（精确）；
 * 2. 器件：引脚 ext.y = T − (locY − ey) 必须落在 occupancy 外包内，求 T 的可行区间；
 * 3. 都没有对象（空页）→ PAGE_TOP_ANCHOR。
 * **不要**用 page_box.max.y：setPageSize 后 page_box 被归一化，与画布原始 y 差一个页高，
 * 按它算出的引脚/符号/母线会落到别的网络旁边，造成并网。
 */
export async function calibratePageTop(
  client: C, ctx: P,
): Promise<{ top: number; source: "wires" | "pins" | "anchor" }> {
  const raw = await selectAllJson(client, ctx).catch(() => [] as any[]);
  const rawWires = new Map<string, any>();
  for (const j of raw) if (j.typeOrigin != null && j.sx != null && j.dbId != null) rawWires.set(String(j.dbId), j);

  if (rawWires.size) {
    const rpc: any = await client.canvasOps.listWireSegments({ context: ctx } as any).catch(() => null);
    const votesExt = new Map<number, number>();
    let sameAsRaw = 0;
    for (const w of rpc?.wires ?? []) {
      const j = rawWires.get(String(w.objectId));
      if (!j) continue;
      const ay = Number(w.start?.y), by = Number(w.end?.y);
      const sy = Number(j.sy), ey = Number(j.ey);
      if (![ay, by, sy, ey].every(Number.isFinite)) continue;
      if ((ay === sy && by === ey) || (ay === ey && by === sy)) { sameAsRaw++; continue; }
      // 端点顺序可能相反：两端 ext.y 之和 = 2T − 两端原始 y 之和
      const t = Math.round((ay + by + sy + ey) / 2);
      votesExt.set(t, (votesExt.get(t) ?? 0) + 1);
    }
    const best = [...votesExt.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] > sameAsRaw) {
      PAGE_TOP = best[0];
      WIRE_RPC_IS_EXT = true;
      return { top: PAGE_TOP, source: "wires" };
    }
    if (sameAsRaw) WIRE_RPC_IS_EXT = false;
  }

  const { items } = await occupancyItems(client, ctx);
  let lo = -Infinity, hi = Infinity, used = 0;
  for (const it of items.slice(0, 12)) {
    let j: any;
    try { j = await objJson(client, ctx, BigInt(String(it.objectId))); } catch { continue; }
    const pins = j.PortInstScalar ?? [];
    if (!pins.length || j.locY == null) continue;
    const y1 = Number(it.bbox?.min?.y), y2 = Number(it.bbox?.max?.y);
    for (const p of pins) {
      const k = Number(j.locY) - Number(p.ey);
      lo = Math.max(lo, y1 - 2 + k);
      hi = Math.min(hi, y2 + 2 + k);
    }
    used++;
  }
  if (used && lo <= hi) {
    const pick = PAGE_TOP_ANCHOR >= lo && PAGE_TOP_ANCHOR <= hi
      ? PAGE_TOP_ANCHOR
      : Math.round((lo + hi) / 2 / EXT_GRID) * EXT_GRID;
    PAGE_TOP = pick;
    return { top: PAGE_TOP, source: "pins" };
  }
  if (!items.length && !rawWires.size) PAGE_TOP = PAGE_TOP_ANCHOR;
  return { top: PAGE_TOP, source: "anchor" };
}

/** 兼容旧脚本：等同 calibratePageTop */
export async function refreshPageTop(client: C, ctx: P) {
  await calibratePageTop(client, ctx).catch(() => { /* keep current */ });
  return PAGE_TOP;
}

/**
 * 设 Custom 页尺寸并 **保持页面上边不动**（ltY = PAGE_TOP − h，rbY = PAGE_TOP），
 * 这样已有对象的 ext 坐标不变。P0 与 P3.5 都用它，不要直接写 ltY=0 / rbY=pageH。
 *
 * **持久化**：RPC 会改当前画布上的页框；关页再开时尺寸来自工程里的 `VxPage.m_pageSizeInfo`。
 * 旧版引擎 Custom 路径未写回该字段会导致「看起来改好了、重开又变回去」——需 HQ 侧
 * `SCH_Backend_SetPageSize` 已同步 VxPage。脚本在 **P4b 结束前** 仍应 `saveProject`，否则关工程未存盘仍会丢。
 */
export async function setPageExt(
  client: C, ctx: P, w: number, h: number, opts?: { save?: boolean },
) {
  await calibratePageTop(client, ctx).catch(() => { /* keep current */ });
  const top = PAGE_TOP;
  const res: any = await client.canvasOps.setPageSize({
    context: ctx, ltX: 0, ltY: top - h, rbX: w, rbY: top,
    showBorder: true, pageSizeLabel: "Custom",
  } as never);
  await sleep(500);
  PAGE_TOP = top;
  if (opts?.save) await persistProject(client, ctx);
  return { top, w, h, success: res?.success !== false };
}

/** 将当前页（含页尺寸）写入工程文件；模块化脚本在 P4b 验收通过后调用 */
export async function persistProject(client: C, ctx: P) {
  await (client.project as any).saveProject({ context: ctx });
  await sleep(300);
}

export async function objJson(client: C, ctx: P, id: bigint) {
  const o: any = await client.canvasOps.getObjectJsonById({ context: ctx, objectId: id } as any);
  return JSON.parse(String(o.json ?? "{}"));
}

export async function occupancyMap(client: C, ctx: P) {
  const occ = await occupancyItems(client, ctx);
  const map = new Map<string, { id: bigint; bbox: any }>();
  const seen = new Map<string, number>();
  for (const it of occ.items) {
    const id = BigInt(String(it.objectId));
    let ref = String(it.objectId);
    try { const j = await objJson(client, ctx, id); ref = j.Reference ?? j.PartValue ?? ref; } catch { /* ignore */ }
    const n = (seen.get(ref) ?? 0) + 1;
    seen.set(ref, n);
    map.set(n === 1 ? ref : `${ref}#${n}`, { id, bbox: it.bbox });
  }
  return { map, pageBox: occ.pageBox, count: occ.items.length };
}

/** 位号匹配：`U2` 同时匹配多 section 的 `U2-1` / `U2-2` 与重名的 `U2#2` */
export function refMatches(ref: string, list: string[]) {
  return list.some((r) => ref === r || ref.startsWith(`${r}#`) || new RegExp(`^${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+(#\\d+)?$`).test(ref));
}

/** 去掉 section / 重名后缀，得到网表里的位号（`U2-1#2` → `U2`） */
export const baseRef = (ref: string) => ref.replace(/#\d+$/, "").replace(/-\d+$/, "");

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
 * 两端 x 取该排最外侧器件脚，y 取轨高度；各器件脚用 PlaceWire 竖线接到轨上（见 placeDecapRow）。
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

/** 异网导线之间的最小平行间距（ext）。电源符号脚距只有 10 ext，取 8。 */
export const WIRE_CLEARANCE = 8;

export interface WireCheckOpts {
  /** 这段线所属网络；给了才允许与 **同名网络** 的已有导线 T 接 / 重叠 */
  net?: string;
  /** false = 跳过冲突检查（调用方已自行检查过） */
  check?: boolean;
}

const isSameNet = (s: WireSeg, net?: string) => !!net && !!s.net && s.net === net;

/** 点落在正交线段的 **中段**（不含两端点） */
function onInterior(p: ExtPt, s: { a: ExtPt; b: ExtPt }): boolean {
  if (s.a.y === s.b.y && p.y === s.a.y) {
    return p.x > Math.min(s.a.x, s.b.x) && p.x < Math.max(s.a.x, s.b.x);
  }
  if (s.a.x === s.b.x && p.x === s.a.x) {
    return p.y > Math.min(s.a.y, s.b.y) && p.y < Math.max(s.a.y, s.b.y);
  }
  return false;
}

const spanOverlap = (a1: number, a2: number, b1: number, b2: number) =>
  Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2));

/**
 * 新导线 a→b 与已有导线的冲突，返回原因（无冲突返回 null）：
 * - 与异网导线 **共线重叠**，或平行间距 < WIRE_CLEARANCE —— 引擎会把两条线视为同一网（并网/短路）；
 * - 新线端点落在异网导线中段，或异网导线端点落在新线中段 —— 形成 T 接点，同样并网。
 * 已有导线的 net 未知（空）时按异网处理。
 */
export function wireConflict(a: ExtPt, b: ExtPt, segs: WireSeg[], net?: string): string | null {
  const nw = { a, b };
  const horiz = a.y === b.y;
  const vert = a.x === b.x;
  for (const s of segs) {
    if (isSameNet(s, net)) continue;
    const tag = `导线 ${s.id}${s.net ? `（${s.net}）` : ""}`;
    const sh = s.a.y === s.b.y;
    const sv = s.a.x === s.b.x;
    if (horiz && sh && spanOverlap(a.x, b.x, s.a.x, s.b.x) > 0) {
      const d = Math.abs(a.y - s.a.y);
      if (d < WIRE_CLEARANCE) return d === 0 ? `与${tag}共线重叠` : `与${tag}平行间距 ${d} ext < ${WIRE_CLEARANCE}`;
    }
    if (vert && sv && spanOverlap(a.y, b.y, s.a.y, s.b.y) > 0) {
      const d = Math.abs(a.x - s.a.x);
      if (d < WIRE_CLEARANCE) return d === 0 ? `与${tag}共线重叠` : `与${tag}平行间距 ${d} ext < ${WIRE_CLEARANCE}`;
    }
    if (onInterior(a, s) || onInterior(b, s)) return `端点落在${tag}中段（T 接点会并网）`;
    if (onInterior(s.a, nw) || onInterior(s.b, nw)) return `${tag}的端点落在新线中段（T 接点会并网）`;
  }
  return null;
}

async function placeWireExt(
  client: C, ctx: P, a: ExtPt, b: ExtPt, opts: WireCheckOpts = {},
): Promise<bigint> {
  if (a.x === b.x && a.y === b.y) return 0n;
  if (opts.check !== false) {
    const why = wireConflict(a, b, await listWireSegmentsExt(client, ctx), opts.net);
    if (why) {
      throw new Error(
        `PlaceWire (${a.x},${a.y})→(${b.x},${b.y}) 冲突：${why}。换拐角方向 / 挪开器件 / 改用短 stub+NetAlias；` +
        `确属同一网络就传 { net }`,
      );
    }
  }
  const w: any = await client.objPlace.placeWire({
    context: ctx,
    geometry: {
      start: { x: BigInt(Math.round(a.x)), y: BigInt(Math.round(a.y)) },
      end: { x: BigInt(Math.round(b.x)), y: BigInt(Math.round(b.y)) },
    },
    // 端点必须精确落在引脚上，不吸附
    snapToGrid: false,
  } as any);
  await sleep(150);
  return BigInt(w.lineObjectId ?? 0);
}

/** 单段 PlaceWire（ext 坐标；端点须落在引脚或已有线段端点）。下线前做冲突检查，见 `wireConflict`。 */
export async function placeWireSegmentExt(
  client: C, ctx: P, a: ExtPt, b: ExtPt, opts?: WireCheckOpts,
): Promise<bigint> {
  return placeWireExt(client, ctx, a, b, opts);
}

/**
 * 正交 L 形两段线（AI 选 cornerFirst：先横后竖 `h`，或先竖后横 `v`）。
 * 首选拐角与已有异网导线冲突时自动换另一个拐角；两个都冲突才抛错（附原因）。
 */
export async function wireOrthogonalLExt(
  client: C, ctx: P, a: ExtPt, b: ExtPt, cornerFirst: "h" | "v" = "h", opts: WireCheckOpts = {},
): Promise<bigint[]> {
  if (a.x === b.x || a.y === b.y) return [await placeWireExt(client, ctx, a, b, opts)];
  const cornerOf = (k: "h" | "v") => (k === "h" ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
  const order: Array<"h" | "v"> = cornerFirst === "h" ? ["h", "v"] : ["v", "h"];
  let corner = cornerOf(order[0]);
  if (opts.check !== false) {
    const segs = await listWireSegmentsExt(client, ctx);
    const reasons: string[] = [];
    const pick = order.find((k) => {
      const c = cornerOf(k);
      const why = wireConflict(a, c, segs, opts.net) ?? wireConflict(c, b, segs, opts.net);
      if (why) reasons.push(`拐角 ${k}: ${why}`);
      return !why;
    });
    if (!pick) {
      throw new Error(
        `L 形连线 (${a.x},${a.y})→(${b.x},${b.y}) 两个拐角都冲突：${reasons.join("；")}。` +
        `挪开器件 / 改用短 stub+NetAlias；确属同一网络就传 { net }`,
      );
    }
    corner = cornerOf(pick);
  }
  return [
    await placeWireExt(client, ctx, a, corner, { ...opts, check: false }),
    await placeWireExt(client, ctx, corner, b, { ...opts, check: false }),
  ];
}

/**
 * 两器件指定引脚之间用 PlaceWire 连通（不用 autoConnect）。
 * 电源/GND/端口符号引脚号传 `"0"`。下线前检查与异网导线的重叠 / T 接，L 形会自动换拐角。
 */
export async function connectPinsPlaceWire(
  client: C, ctx: P,
  objectId1: bigint, pin1: string | number,
  objectId2: bigint, pin2: string | number,
  opts?: { cornerFirst?: "h" | "v" } & WireCheckOpts,
): Promise<bigint[]> {
  const findPin = (pins: PinInfo[], key: string) =>
    pins.find((p) => p.num === key || p.name === key);
  const k1 = String(pin1);
  const k2 = String(pin2);
  const a = findPin(await pinsOf(client, ctx, objectId1), k1);
  const b = findPin(await pinsOf(client, ctx, objectId2), k2);
  if (!a || !b) throw new Error(`connectPinsPlaceWire: 引脚未找到 (${pin1} / ${pin2})`);
  const check: WireCheckOpts = { net: opts?.net, check: opts?.check };
  if (a.ext.x === b.ext.x || a.ext.y === b.ext.y) {
    return [await placeWireExt(client, ctx, a.ext, b.ext, check)];
  }
  return wireOrthogonalLExt(client, ctx, a.ext, b.ext, opts?.cornerFirst ?? "h", check);
}

export interface DecapRowResult {
  wireIds: bigint[];
  topRail: { x1: number; x2: number; y: number };
  bottomRail: { x1: number; x2: number; y: number };
  /** 放唯一一个电源符号的位置（上母线左端） */
  powerAnchor: ExtPt;
  /** 放唯一一个 GND 符号的位置（下母线中点） */
  groundAnchor: ExtPt;
}

/**
 * 去耦并联排（拓扑 B）的确定性画法：电容已在 P1 横排、竖放、等距（建议 80 ext）。
 *
 * 每颗电容：上脚竖短线到上母线、下脚竖短线到下母线；母线按相邻电容分段画，
 * 每个连接点都是线段端点对端点（不依赖 T 形中点连接）。
 * 返回 powerAnchor / groundAnchor：在这两处各放 **一个** 电源符号（如 +3V3）与 **一个** GND，
 * 电源/GND 符号用 `connectPinsPlaceWire` 接到最近电容脚（禁止 autoConnect）。排内不放 NetAlias。
 */
export async function placeDecapRow(
  client: C, ctx: P, capIds: bigint[], opts?: { stub?: number },
): Promise<DecapRowResult> {
  if (capIds.length < 1) throw new Error("placeDecapRow: 至少一颗电容");
  const stub = opts?.stub ?? 40;

  const caps: Array<{ x: number; top: ExtPt; bottom: ExtPt }> = [];
  for (const id of capIds) {
    const pins = await pinsOf(client, ctx, id);
    if (pins.length < 2) throw new Error(`placeDecapRow: 对象 ${id} 引脚不足 2 个`);
    const [p1, p2] = [...pins].sort((a, b) => a.ext.y - b.ext.y);
    if (Math.abs(p1.ext.x - p2.ext.x) > 2) {
      throw new Error(`placeDecapRow: 对象 ${id} 不是竖放（两脚 x 不同），请先旋转 90°`);
    }
    caps.push({ x: p1.ext.x, top: p1.ext, bottom: p2.ext });
  }
  caps.sort((a, b) => a.x - b.x);

  const topY = floorGrid(Math.min(...caps.map((c) => c.top.y)) - stub);
  const botY = Math.ceil((Math.max(...caps.map((c) => c.bottom.y)) + stub) / EXT_GRID) * EXT_GRID;

  const wireIds: bigint[] = [];
  const push = (id: bigint) => { if (id > 0n) wireIds.push(id); };
  for (const c of caps) {
    push(await placeWireExt(client, ctx, c.top, { x: c.x, y: topY }));
    push(await placeWireExt(client, ctx, c.bottom, { x: c.x, y: botY }));
  }
  for (let i = 0; i + 1 < caps.length; i++) {
    push(await placeWireExt(client, ctx, { x: caps[i].x, y: topY }, { x: caps[i + 1].x, y: topY }));
    push(await placeWireExt(client, ctx, { x: caps[i].x, y: botY }, { x: caps[i + 1].x, y: botY }));
  }

  const x1 = caps[0].x;
  const x2 = caps[caps.length - 1].x;
  const mid = caps[Math.floor((caps.length - 1) / 2)].x;
  return {
    wireIds,
    topRail: { x1, x2, y: topY },
    bottomRail: { x1, x2, y: botY },
    powerAnchor: { x: x1, y: topY },
    groundAnchor: { x: mid, y: botY },
  };
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
    if (!refMatches(ref, refs)) continue;
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

  const wireIds = bbox
    ? await wiresTouching(client, ctx, { x1: bbox.x1 - pad, y1: bbox.y1 - pad, x2: bbox.x2 + pad, y2: bbox.y2 + pad })
    : [];
  return { partIds, partRefs, wireIds, bbox };
}

export interface WireSeg { id: bigint; a: ExtPt; b: ExtPt; net?: string }

/**
 * 活动页导线段（ext，Y 向下）。
 * `listWireSegments` 的 y 方向随引擎构建可能不同：以「端点落在器件 bbox 附近」的个数
 * 判定是否需要 `PAGE_TOP - y` 翻转，避免按错误坐标系把导线归到别的模块。
 */
export async function listWireSegmentsExt(client: C, ctx: P): Promise<WireSeg[]> {
  const wires: any = await client.canvasOps.listWireSegments({ context: ctx } as any);
  const raw = (wires.wires ?? [])
    .map((w: any) => ({
      id: BigInt(String(w.objectId)),
      ax: Number(w.start?.x), ay: Number(w.start?.y),
      bx: Number(w.end?.x), by: Number(w.end?.y),
      net: String(w.netName ?? ""),
    }))
    .filter((w: any) => [w.ax, w.ay, w.bx, w.by].every(Number.isFinite));
  if (!raw.length) return [];
  if (WIRE_RPC_IS_EXT != null) {
    const flip = !WIRE_RPC_IS_EXT;
    return raw.map((w: any) => ({
      id: w.id,
      a: { x: w.ax, y: flip ? PAGE_TOP - w.ay : w.ay },
      b: { x: w.bx, y: flip ? PAGE_TOP - w.by : w.by },
      net: w.net,
    }));
  }

  const occ = await occupancyItems(client, ctx);
  const boxes: ExtBox[] = occ.items.map((it: any) => ({
    x1: Number(it.bbox?.min?.x) - 40, y1: Number(it.bbox?.min?.y) - 40,
    x2: Number(it.bbox?.max?.x) + 40, y2: Number(it.bbox?.max?.y) + 40,
  }));
  const hits = (flip: boolean) => raw.reduce((n: number, w: any) => {
    const ys = flip ? [PAGE_TOP - w.ay, PAGE_TOP - w.by] : [w.ay, w.by];
    const pts = [{ x: w.ax, y: ys[0] }, { x: w.bx, y: ys[1] }];
    return n + pts.filter((p) => boxes.some((b) => p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2)).length;
  }, 0);
  const flip = hits(true) >= hits(false);
  return raw.map((w: any) => ({
    id: w.id,
    a: { x: w.ax, y: flip ? PAGE_TOP - w.ay : w.ay },
    b: { x: w.bx, y: flip ? PAGE_TOP - w.by : w.by },
    net: w.net,
  }));
}

/** 端点落在 zone 内的导线 id */
export async function wiresTouching(client: C, ctx: P, zone: ExtBox): Promise<bigint[]> {
  const inZone = (p: ExtPt) => p.x >= zone.x1 && p.x <= zone.x2 && p.y >= zone.y1 && p.y <= zone.y2;
  return (await listWireSegmentsExt(client, ctx)).filter((w) => inZone(w.a) || inZone(w.b)).map((w) => w.id);
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

// ─── P3.5 收拢：量真实尺寸 → 重算网格 → 整体平移 ────────────────

/** getPageOccupancy 的 id → ext bbox（不逐个 getObjectJsonById，比 occupancyMap 快得多） */
export async function occupancyBoxesById(client: C, ctx: P): Promise<Map<string, ExtBox>> {
  const occ = await occupancyItems(client, ctx);
  const out = new Map<string, ExtBox>();
  for (const it of occ.items) {
    out.set(String(it.objectId), {
      x1: Number(it.bbox?.min?.x), y1: Number(it.bbox?.min?.y),
      x2: Number(it.bbox?.max?.x), y2: Number(it.bbox?.max?.y),
    });
  }
  return out;
}

const unionBoxes = (boxes: ExtBox[]): ExtBox | null => boxes.length
  ? boxes.reduce((u, b) => ({
    x1: Math.min(u.x1, b.x1), y1: Math.min(u.y1, b.y1),
    x2: Math.max(u.x2, b.x2), y2: Math.max(u.y2, b.y2),
  }))
  : null;

export interface ModuleObjects {
  /** 器件 + 匿名符号（电源/GND），均在 occupancy 中 */
  symbolIds: bigint[];
  /** 与 symbolIds 一一对应的外包 */
  boxes: ExtBox[];
  wireIds: bigint[];
  bbox: ExtBox | null;
}

/**
 * 一个模块要整体搬动的全部对象：位号器件 + 中心落在 slot 内的匿名符号（电源/GND）
 * + 端点落在内容外包（外扩 pad）内的导线。
 * `allRefs` 传全部模块的位号，避免把别的模块漂进 slot 的器件当成匿名符号收走。
 * NetAlias 不在 occupancy 里，收不到 —— 所以跨模块标签必须在收拢之后再放。
 */
export async function collectModuleObjects(
  client: C, ctx: P, refs: string[], slot: ExtBox,
  opts?: { allRefs?: string[]; pad?: number; map?: Map<string, { id: bigint; bbox: any }>; skipWires?: boolean },
): Promise<ModuleObjects> {
  const map = opts?.map ?? (await occupancyMap(client, ctx)).map;
  const all = opts?.allRefs ?? refs;
  const match = refMatches;
  const symbolIds: bigint[] = [];
  const boxes: ExtBox[] = [];
  for (const [ref, v] of map) {
    const b = {
      x1: Number(v.bbox.min.x), y1: Number(v.bbox.min.y),
      x2: Number(v.bbox.max.x), y2: Number(v.bbox.max.y),
    };
    const cx = (b.x1 + b.x2) / 2;
    const cy = (b.y1 + b.y2) / 2;
    const anonymousInSlot = !match(ref, all)
      && cx >= slot.x1 && cx <= slot.x2 && cy >= slot.y1 && cy <= slot.y2;
    if (!match(ref, refs) && !anonymousInSlot) continue;
    symbolIds.push(v.id);
    boxes.push(b);
  }
  const bbox = unionBoxes(boxes);
  const pad = opts?.pad ?? EXT_GRID;
  const wireIds = bbox && !opts?.skipWires
    ? await wiresTouching(client, ctx, { x1: bbox.x1 - pad, y1: bbox.y1 - pad, x2: bbox.x2 + pad, y2: bbox.y2 + pad })
    : [];
  return { symbolIds, boxes, wireIds, bbox };
}

// ─── 电气归属：按连通性决定「谁跟着模块走」────────────────────────
//
// 导线、电源符号、NetAlias 都是独立对象，不是器件的子对象；平移只作用于传入的 id。
// 只按几何框收集会漏掉伸出外包的 pattern 走线、电源符号和标签 —— 器件走了、线被拖着，
// 端点扫过走廊就并网。这里改为：从模块引脚出发沿导线做连通分量，分量里的一切归该模块。

const GEOM_TOL = 1.5;
const samePt = (a: ExtPt, b: ExtPt) => Math.abs(a.x - b.x) <= GEOM_TOL && Math.abs(a.y - b.y) <= GEOM_TOL;
function onSeg(p: ExtPt, a: ExtPt, b: ExtPt) {
  if (p.x < Math.min(a.x, b.x) - GEOM_TOL || p.x > Math.max(a.x, b.x) + GEOM_TOL) return false;
  if (p.y < Math.min(a.y, b.y) - GEOM_TOL || p.y > Math.max(a.y, b.y) + GEOM_TOL) return false;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return samePt(p, a);
  return Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len <= GEOM_TOL;
}
const isAutoNet = (n: string) => !n || /^N\d+$/.test(n);

export interface GraphPin { owner: string; ref: string; objectId: bigint; pinNum: string; at: ExtPt }
export interface GraphWire { id: bigint; a: ExtPt; b: ExtPt; net: string }
/** NetAlias 或电源/GND 符号 */
export interface GraphMark { id: bigint; kind: "alias" | "symbol"; name: string; pts: ExtPt[]; box: ExtBox }
export interface PageGraph {
  parts: Array<{ ref: string; id: bigint; box: ExtBox; owner: string }>;
  pins: GraphPin[];
  wires: GraphWire[];
  marks: GraphMark[];
}

/**
 * 读活动页的器件、引脚、导线、NetAlias、电源符号（全部换成 ext 坐标）。
 * owner = 模块 key；不属于任何模块的器件记为 `free:<位号>`。
 */
export async function buildPageGraph(client: C, ctx: P, specs: ModuleSpec[]): Promise<PageGraph> {
  await calibratePageTop(client, ctx);
  const raw = await selectAllJson(client, ctx);
  const T = PAGE_TOP;
  const ext = (x: unknown, y: unknown): ExtPt => ({ x: Number(x), y: T - Number(y) });
  const rawBox = (j: any): ExtBox => ({
    x1: Math.min(Number(j.x1), Number(j.x2)), y1: T - Math.max(Number(j.y1), Number(j.y2)),
    x2: Math.max(Number(j.x1), Number(j.x2)), y2: T - Math.min(Number(j.y1), Number(j.y2)),
  });

  const wires: GraphWire[] = [];
  const childAlias = new Set<string>();
  for (const j of raw) {
    if (j.typeOrigin == null || j.sx == null || j.dbId == null) continue;
    wires.push({ id: BigInt(String(j.dbId)), a: ext(j.sx, j.sy), b: ext(j.ex, j.ey), net: String(j.Name ?? "") });
    for (const a of j.Alias ?? []) if (a?.dbId != null) childAlias.add(String(a.dbId));
  }

  const marks: GraphMark[] = [];
  for (const j of raw) {
    if (j.AliasFont == null || j.name == null || j.locX == null || j.dbId == null) continue;
    if (childAlias.has(String(j.dbId))) continue;
    const at = ext(j.locX, j.locY);
    marks.push({ id: BigInt(String(j.dbId)), kind: "alias", name: String(j.name), pts: [at], box: j.x1 != null ? rawBox(j) : { x1: at.x, y1: at.y, x2: at.x, y2: at.y } });
  }

  const { map } = await occupancyMap(client, ctx);
  const occBox = new Map<string, ExtBox>();
  for (const v of map.values()) {
    occBox.set(String(v.id), {
      x1: Number(v.bbox.min.x), y1: Number(v.bbox.min.y), x2: Number(v.bbox.max.x), y2: Number(v.bbox.max.y),
    });
  }
  const symbolIds = new Set<string>();
  for (const j of raw) {
    const sid = j.dbid ?? (j.SymbolType != null ? j.dbId : null);
    if (j.SymbolType == null || sid == null) continue;
    const id = BigInt(String(sid));
    symbolIds.add(String(id));
    let pts: ExtPt[] = [];
    try { pts = (await pinsOf(client, ctx, id)).map((p) => p.ext); } catch { /* 用 loc */ }
    if (!pts.length) pts = [ext(j.locx, j.locy)];
    const p0 = pts[0];
    marks.push({
      id, kind: "symbol", name: String(j.name ?? j.symbolname ?? j.pkgName ?? ""), pts,
      box: occBox.get(String(id)) ?? { x1: p0.x - 10, y1: p0.y - 10, x2: p0.x + 10, y2: p0.y + 10 },
    });
  }

  const parts: PageGraph["parts"] = [];
  const pins: GraphPin[] = [];
  for (const [ref, v] of map) {
    if (symbolIds.has(String(v.id))) continue;
    const spec = specs.find((s) => refMatches(ref, s.refs));
    const owner = spec ? spec.key : `free:${baseRef(ref)}`;
    parts.push({ ref, id: v.id, box: occBox.get(String(v.id))!, owner });
    let ps: PinInfo[] = [];
    try { ps = await pinsOf(client, ctx, v.id); } catch { /* 无引脚 */ }
    for (const p of ps) pins.push({ owner, ref: baseRef(ref), objectId: v.id, pinNum: p.num, at: p.ext });
  }
  return { parts, pins, wires, marks };
}

type GNode = { t: "w"; w: GraphWire } | { t: "p"; p: GraphPin } | { t: "m"; m: GraphMark };

/** 连通分量（去掉 cut 里的导线后）。每个分量含导线 / 引脚 / 标记 */
function graphComponents(g: PageGraph, cut: Set<string> = new Set()) {
  const nodes: GNode[] = [
    ...g.wires.filter((w) => !cut.has(String(w.id))).map((w) => ({ t: "w" as const, w })),
    ...g.pins.map((p) => ({ t: "p" as const, p })),
    ...g.marks.filter((m) => !cut.has(String(m.id))).map((m) => ({ t: "m" as const, m })),
  ];
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (i: number, j: number) => { parent[find(i)] = find(j); };
  const ptsOf = (n: GNode): ExtPt[] => (n.t === "w" ? [n.w.a, n.w.b] : n.t === "p" ? [n.p.at] : n.m.pts);
  const touches = (u: GNode, v: GNode) => {
    if (u.t === "w" && v.t === "w") {
      return onSeg(u.w.a, v.w.a, v.w.b) || onSeg(u.w.b, v.w.a, v.w.b)
        || onSeg(v.w.a, u.w.a, u.w.b) || onSeg(v.w.b, u.w.a, u.w.b);
    }
    if (u.t === "w") return ptsOf(v).some((p) => onSeg(p, u.w.a, u.w.b));
    if (v.t === "w") return ptsOf(u).some((p) => onSeg(p, v.w.a, v.w.b));
    return ptsOf(u).some((p) => ptsOf(v).some((q) => samePt(p, q)));
  };
  const adj: number[][] = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[i].t === "p" && nodes[j].t === "p" && (nodes[i] as any).p.objectId === (nodes[j] as any).p.objectId) continue;
      if (touches(nodes[i], nodes[j])) { join(i, j); adj[i].push(j); adj[j].push(i); }
    }
  }
  const groups = new Map<number, number[]>();
  nodes.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  });
  return [...groups.values()]
    .filter((idx) => idx.length > 1 || nodes[idx[0]].t !== "p")
    .map((idx) => {
      const wires = idx.flatMap((i) => (nodes[i].t === "w" ? [(nodes[i] as any).w as GraphWire] : []));
      const pins = idx.flatMap((i) => (nodes[i].t === "p" ? [(nodes[i] as any).p as GraphPin] : []));
      const marks = idx.flatMap((i) => (nodes[i].t === "m" ? [(nodes[i] as any).m as GraphMark] : []));
      const owners = [...new Set(pins.map((p) => p.owner))];
      const name = marks.find((m) => m.kind === "alias")?.name
        ?? marks.find((m) => m.kind === "symbol" && m.name)?.name
        ?? wires.map((w) => w.net).find((n) => !isAutoNet(n))
        ?? null;
      return { idx, nodes, adj, wires, pins, marks, owners, name };
    });
}

/**
 * 跨模块分量里要剪掉的导线：从各 owner 的引脚做多源 BFS 给节点贴 owner 标签，
 * 两端标签不同的边上取导线剪掉（只剪「桥」，模块内部走线保留）。
 */
function bridgeWires(comp: ReturnType<typeof graphComponents>[number]): string[] {
  const label = new Map<number, string>();
  const queue: number[] = [];
  for (const i of comp.idx) {
    const n = comp.nodes[i];
    if (n.t === "p") { label.set(i, n.p.owner); queue.push(i); }
  }
  while (queue.length) {
    const i = queue.shift()!;
    for (const j of comp.adj[i]) {
      if (label.has(j)) continue;
      label.set(j, label.get(i)!);
      queue.push(j);
    }
  }
  const cut = new Set<string>();
  for (const i of comp.idx) {
    for (const j of comp.adj[i]) {
      if (j < i || label.get(i) === label.get(j)) continue;
      const pick = comp.nodes[i].t === "w" ? i : comp.nodes[j].t === "w" ? j : -1;
      if (pick >= 0) cut.add(String((comp.nodes[pick] as any).w.id));
    }
  }
  return [...cut];
}

/** 每个引脚 `位号.脚号` → 所在网络名与同网引脚集合（netlist 稳定后读取） */
export async function netMembership(client: C, ctx: P) {
  const { nets } = await waitForNetlistStable(client, ctx, { label: "netlist" });
  const out = new Map<string, { net: string; peers: Set<string> }>();
  for (const n of nets) {
    const peers = new Set((n.pinReferences ?? []).map((p) => `${baseRef(String(p.referenceDesignator))}.${p.pinNumber}`));
    for (const p of peers) out.set(p, { net: String(n.name), peers });
  }
  return out;
}

/** 比较前后网表：lost = 原来同网的脚分开了 / 网名丢了；shorts = 混入了原来不同网的脚 */
export function diffNetMembership(
  before: Map<string, { net: string; peers: Set<string> }>,
  after: Map<string, { net: string; peers: Set<string> }>,
  pins: string[],
) {
  const lost: Array<{ pin: string; net: string }> = [];
  const shorts: Array<{ pin: string; net: string; extra: string[] }> = [];
  for (const pin of pins) {
    const b = before.get(pin) ?? { net: "", peers: new Set([pin]) };
    const a = after.get(pin) ?? { net: "", peers: new Set([pin]) };
    const extra = [...a.peers].filter((p) => p !== pin && !b.peers.has(p));
    if (extra.length) { shorts.push({ pin, net: a.net, extra }); continue; }
    const missing = [...b.peers].some((p) => p !== pin && !a.peers.has(p));
    if (missing || (!isAutoNet(b.net) && a.net !== b.net)) lost.push({ pin, net: b.net });
  }
  return { lost, shorts };
}

let lastCheckpoint: { label: string; membership: Map<string, { net: string; peers: Set<string> }> } | null = null;

/**
 * 写操作阶段的网表检查点（电源符号 / pattern / 模块内连线 / 收拢 之后各调一次）。
 *
 * 与上一个检查点对比，若某个网络里同时出现了原先属于 **两个不同命名网络** 的引脚
 * （如 +3V3 与 GND 合成一个网）就判定为并网：默认抛错并点名是哪一阶段造成的、
 * 混进来的是哪些脚。正常连线只会把未命名的脚接进某个网，不会触发。
 * 第一次调用只记录基线。
 */
export async function checkpointNets(
  client: C, ctx: P, label: string, opts: { throwOnShort?: boolean } = {},
) {
  const membership = await netMembership(client, ctx);
  const prev = lastCheckpoint;
  lastCheckpoint = { label, membership };
  if (!prev) {
    console.log(`  ✓ 网表检查点「${label}」：基线 ${membership.size} 脚`);
    return { shorts: [] as Array<{ net: string; merged: Record<string, string[]> }> };
  }

  const shorts: Array<{ net: string; merged: Record<string, string[]> }> = [];
  const seen = new Set<Set<string>>();
  for (const [pin, cur] of membership) {
    if (seen.has(cur.peers)) continue;
    seen.add(cur.peers);
    const merged: Record<string, string[]> = {};
    for (const p of cur.peers) {
      const before = prev.membership.get(p)?.net;
      if (!before || isAutoNet(before)) continue;
      (merged[before] ??= []).push(p);
    }
    if (Object.keys(merged).length >= 2) shorts.push({ net: cur.net || pin, merged });
  }

  if (!shorts.length) {
    console.log(`  ✓ 网表检查点「${label}」：无并网（上一检查点「${prev.label}」）`);
    return { shorts };
  }
  const detail = shorts
    .map((s) => `${s.net} ← ${Object.entries(s.merged).map(([n, ps]) => `${n}[${ps.slice(0, 4).join(", ")}]`).join(" + ")}`)
    .join("；");
  const msg = `网表检查点「${label}」发现并网（「${prev.label}」之后这一阶段造成）：${detail}`;
  if (opts.throwOnShort === false) console.log(`  ! ${msg}`);
  else throw new Error(`${msg}。先用 listWireSegments 查这一阶段新下的线是否压在别的网上，不要整页重跑`);
  return { shorts };
}

/**
 * 引脚短 stub + NetAlias。stub 上限默认 40 ext（小于 60 ext 走廊）：
 * 允许伸长到 200+ ext 时，模块挤紧后 stub 会跨走廊抓到隔壁模块的线并网。
 */
export async function placeShortStubAlias(
  client: C, ctx: P, objectId: bigint, pinNum: string | number, netName: string,
  opts?: { initial?: number; max?: number },
): Promise<bigint[]> {
  const max = Math.min(opts?.max ?? LABEL_CORRIDOR - EXT_GRID, LABEL_CORRIDOR - EXT_GRID);
  const res: any = await client.objPlace.placePinStubWireAndNetAlias({
    context: ctx, objectId, pinNum: Number(pinNum), netName,
    snapToGrid: true,
    initialStubLength: BigInt(Math.min(opts?.initial ?? 20, max)),
    stubExtendStep: 10n,
    maxStubLength: BigInt(max),
  } as any);
  await sleep(150);
  const raw = res?.createdObjectIds ?? res?.objectIds ?? [];
  return (Array.isArray(raw) ? raw : []).map((x: any) => BigInt(String(x)));
}

export interface RepackResult {
  plan: CompactPlan;
  moved: Array<{ key: string; dx: number; dy: number; actual: { dx: number; dy: number } }>;
  overlaps: Array<[string, string]>;
  /** 跨模块导线被剪断后，在各侧补挂的同名标签 */
  relabeled: Array<{ key: string; pin: string; net: string }>;
  /** 收拢后网表复核（已自动补挂过掉网的脚） */
  netIssues: { lost: Array<{ pin: string; net: string }>; shorts: Array<{ pin: string; net: string; extra: string[] }> };
}

/**
 * P3.5：放完器件、pattern 与模块内连线之后、**跨模块标签之前**调用。
 *
 * 1. 记录收拢前网表；按 **电气连通** 收集每个模块的器件、导线、电源符号、NetAlias；
 * 2. 同一连通分量跨了两个模块（pattern 直连 host 脚等）→ 只剪掉中间的「桥」导线，
 *    记下两侧网名，平移后各挂一个短 stub + 同名 NetAlias；
 * 3. 用真实外包重算网格，setPageExt 改页（保持上边不动），每个模块整批平移；
 * 4. 复核网表：掉网的脚按原网名补挂短 stub；仍有并网（短路）默认抛错，不要接着画框。
 */
export async function repackModules(
  client: C, ctx: P, specs: ModuleSpec[], plan: CompactPlan,
  opts?: PlanOptions & { setPage?: boolean; strictNets?: boolean },
): Promise<RepackResult> {
  const framePad = opts?.framePad ?? FRAME_PAD;
  const before = await netMembership(client, ctx);
  const g = await buildPageGraph(client, ctx, specs);
  const keys = new Set(specs.map((s) => s.key));

  // 1) 剪跨模块的桥
  const comps0 = graphComponents(g);
  const cut = new Set<string>();
  const crossWires = new Set<string>();
  const crossNames = new Map<string, string>();
  for (const c of comps0) {
    if (c.owners.length < 2 || !c.owners.some((o) => keys.has(o))) continue;
    for (const w of c.wires) crossWires.add(String(w.id));
    const firstPin = [...c.pins].sort((a, b) => `${a.ref}.${a.pinNum}`.localeCompare(`${b.ref}.${b.pinNum}`))[0];
    const named = c.name ?? before.get(`${firstPin.ref}.${firstPin.pinNum}`)?.net;
    const net = named && !isAutoNet(named) ? named : `NET_${firstPin.ref}_${firstPin.pinNum}`;
    for (const id of bridgeWires(c)) cut.add(id);
    for (const p of c.pins) crossNames.set(`${p.ref}.${p.pinNum}`, net);
    console.log(`  · 跨模块连线 ${c.owners.join("↔")}（${net}）：剪断后两侧改挂同名标签`);
  }
  const comps = graphComponents(g, cut);
  const stillCross = comps.filter((c) => c.owners.length > 1 && c.owners.some((o) => keys.has(o)));
  if (stillCross.length) {
    throw new Error(
      `收拢前仍有跨模块直连无法拆开：${stillCross.map((c) => c.owners.join("↔")).join("，")}`
      + "（多半是引脚直接相碰，没有中间导线）；请改为双端 stub + NetAlias 后再收拢",
    );
  }
  // 剪断后不再挂在任何引脚上的碎线/标签：留在原地会被收拢后的模块压到而并网
  const orphanIds = comps
    .filter((c) => !c.pins.length && c.wires.some((w) => crossWires.has(String(w.id))))
    .flatMap((c) => [...c.wires.map((w) => w.id), ...c.marks.map((m) => m.id)]);
  const strays = comps.filter((c) => !c.pins.length && !c.wires.some((w) => crossWires.has(String(w.id))));
  if (strays.length) {
    console.warn(`  ! 页面上有 ${strays.length} 组不连任何引脚的导线/标签，收拢时不会移动，注意是否被模块压到`);
  }
  const toDelete = [...[...cut].map((s) => BigInt(s)), ...orphanIds];
  if (toDelete.length) {
    await client.canvasOps.deleteObjectsByIds({ context: ctx, objectIds: toDelete } as any);
    await sleep(500);
  }

  // 2) 每个模块的对象集合与真实外包
  type Own = { ids: bigint[]; partIds: bigint[]; bbox: ExtBox | null };
  const own = new Map<string, Own>();
  // 剪断后每一侧（含不属于模块、留在原地的器件）挂一个同名标签；已有同名标记的一侧跳过
  const relabel: Array<{ pin: GraphPin; net: string }> = [];
  const pinComp = new Map<string, number>();
  comps.forEach((c, i) => c.pins.forEach((p) => pinComp.set(`${p.objectId}:${p.pinNum}`, i)));
  const doneSide = new Set<string>();
  for (const p of g.pins) {
    const net = crossNames.get(`${p.ref}.${p.pinNum}`);
    if (!net) continue;
    const ci = pinComp.get(`${p.objectId}:${p.pinNum}`);
    const side = ci == null ? `pin:${p.objectId}:${p.pinNum}` : `comp:${ci}`;
    if (doneSide.has(side)) continue;
    doneSide.add(side);
    if (ci != null && comps[ci].marks.some((m) => m.name === net)) continue;
    relabel.push({ pin: p, net });
  }
  for (const s of specs) {
    const parts = g.parts.filter((p) => p.owner === s.key);
    const mine = comps.filter((c) => c.owners.length === 1 && c.owners[0] === s.key);
    const wires = mine.flatMap((c) => c.wires);
    const marks = mine.flatMap((c) => c.marks);
    const boxes = [
      ...parts.map((p) => p.box),
      ...wires.map((w) => ({ x1: Math.min(w.a.x, w.b.x), y1: Math.min(w.a.y, w.b.y), x2: Math.max(w.a.x, w.b.x), y2: Math.max(w.a.y, w.b.y) })),
      ...marks.map((m) => m.box),
    ];
    own.set(s.key, {
      ids: [...parts.map((p) => p.id), ...wires.map((w) => w.id), ...marks.map((m) => m.id)],
      partIds: parts.map((p) => p.id),
      bbox: unionBoxes(boxes),
    });
    if (!parts.length) console.warn(`  ! [${s.key}] 没有找到器件（refs: ${s.refs.join(",")}），按估算尺寸保留位置`);
  }

  // 3) 重算网格 + 改页 + 平移
  const measured = specs.map((s) => {
    const b = own.get(s.key)?.bbox;
    return b ? { ...s, w: snapExt(boxW(b)), h: snapExt(boxH(b)) } : s;
  });
  const next = planCompactZones(measured, { ...opts, layout: plan.layout });
  if (opts?.setPage !== false) await setPageExt(client, ctx, next.pageW, next.pageH);

  const moved: RepackResult["moved"] = [];
  for (const s of specs) {
    const o = own.get(s.key);
    const zone = next.zones[s.key];
    if (!o?.bbox || !zone || !o.partIds.length) continue;
    const dx = snapExt(zone.x1 + framePad - o.bbox.x1);
    const dy = snapExt(zone.y1 + framePad - o.bbox.y1);
    if (!dx && !dy) {
      moved.push({ key: s.key, dx, dy, actual: { dx: 0, dy: 0 } });
      continue;
    }
    const r = await moveExtBatch(client, ctx, o.ids, dx, dy);
    moved.push({ key: s.key, dx, dy, actual: r.actual });
    const resid = Math.max(Math.abs(r.actual.dx - dx), Math.abs(r.actual.dy - dy));
    if (!r.ok || resid > EXT_GRID) {
      throw new Error(
        `[${s.key}] 平移失败：目标 (${dx}, ${dy})，实际 (${r.actual.dx}, ${r.actual.dy})。`
        + "停止收拢；可删该模块后按新单元重放",
      );
    }
    console.log(`  ✓ [${s.key}] 平移 (${dx}, ${dy})，含导线/符号/标签 ${o.ids.length - o.partIds.length} 个`);
  }

  // 4) 剪断处补挂同名标签
  const relabeled: RepackResult["relabeled"] = [];
  for (const r of relabel) {
    await placeShortStubAlias(client, ctx, r.pin.objectId, r.pin.pinNum, r.net);
    relabeled.push({ key: r.pin.owner, pin: `${r.pin.ref}.${r.pin.pinNum}`, net: r.net });
  }

  // 5) 网表复核：掉网按原网名补挂；并网报错
  const modulePins = g.pins.filter((p) => keys.has(p.owner));
  const pinKeys = [...new Set(modulePins.map((p) => `${p.ref}.${p.pinNum}`))];
  let issues = diffNetMembership(before, await netMembership(client, ctx), pinKeys);
  const fixable = issues.lost.filter((l) => !isAutoNet(l.net) || crossNames.has(l.pin));
  if (fixable.length) {
    const afterNow = await netMembership(client, ctx);
    const done = new Set<string>();
    for (const l of fixable) {
      const net = crossNames.get(l.pin) ?? l.net;
      const group = afterNow.get(l.pin)?.peers ?? new Set([l.pin]);
      const gkey = `${net}|${[...group].sort().join(",")}`;
      if (done.has(gkey)) continue;
      done.add(gkey);
      const gp = modulePins.find((p) => `${p.ref}.${p.pinNum}` === l.pin);
      if (!gp) continue;
      await placeShortStubAlias(client, ctx, gp.objectId, gp.pinNum, net);
      console.log(`  · 收拢后 ${l.pin} 掉出 ${net}，已补挂短 stub + 标签`);
    }
    issues = diffNetMembership(before, await netMembership(client, ctx), pinKeys);
  }

  const after = await occupancyBoxesById(client, ctx);
  const finalBoxes = specs
    .map((s) => ({
      key: s.key,
      box: unionBoxes((own.get(s.key)?.partIds ?? []).map((id) => after.get(String(id))).filter(Boolean) as ExtBox[]),
    }))
    .filter((m): m is { key: string; box: ExtBox } => !!m.box);
  const overlaps: Array<[string, string]> = [];
  for (let i = 0; i < finalBoxes.length; i++) {
    for (let j = i + 1; j < finalBoxes.length; j++) {
      if (boxesOverlap(finalBoxes[i].box, finalBoxes[j].box)) overlaps.push([finalBoxes[i].key, finalBoxes[j].key]);
    }
  }
  if (overlaps.length) console.warn(`  ! 收拢后模块外包重叠：${overlaps.map((p) => p.join("↔")).join("，")}`);
  if (issues.lost.length) console.warn(`  ! 收拢后仍掉网：${issues.lost.map((l) => `${l.pin}→${l.net}`).join(" ")}`);
  if (issues.shorts.length) {
    const msg = issues.shorts.map((s) => `${s.pin}(${s.net}) 混入 ${s.extra.join(",")}`).join("；");
    if (opts?.strictNets !== false) throw new Error(`收拢后出现并网（短路），停止：${msg}`);
    console.warn(`  ! 收拢后并网：${msg}`);
  }
  return { plan: next, moved, overlaps, relabeled, netIssues: issues };
}

/**
 * 平移一批对象到目标 ext 位移。`MoveObjectsByIds` 用 **窗口像素** 坐标，
 * 比例随缩放变化：先把整批移动 100 px 标定 px→ext（整批一起动，相对位置不变），
 * 再按比例下发剩余位移，最后按残差迭代最多 `maxIters` 轮。
 * 参考对象取 ids 中第一个出现在 occupancy 里的（导线不在 occupancy 中）。
 */
export async function moveExtBatch(
  client: C, ctx: P, ids: bigint[], dxExt: number, dyExt: number,
  maxIters = 3,
): Promise<{ ok: boolean; actual: { dx: number; dy: number } }> {
  if (!ids.length || (dxExt === 0 && dyExt === 0)) return { ok: true, actual: { dx: 0, dy: 0 } };

  const bboxById = async (id: bigint): Promise<{ x1: number; y1: number } | null> => {
    const b = (await occupancyBoxesById(client, ctx)).get(String(id));
    return b ? { x1: b.x1, y1: b.y1 } : null;
  };

  const initial = await occupancyBoxesById(client, ctx);
  const probeId = ids.find((id) => initial.has(String(id)));
  if (probeId == null) return { ok: false, actual: { dx: 0, dy: 0 } };
  const start = { x1: initial.get(String(probeId))!.x1, y1: initial.get(String(probeId))!.y1 };

  const probeWin = 100;
  const calib: any = await client.canvasOps.moveObjectsByIds({
    context: ctx, objectIds: ids,
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
  // 标定已整批移动一次，计入残差
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

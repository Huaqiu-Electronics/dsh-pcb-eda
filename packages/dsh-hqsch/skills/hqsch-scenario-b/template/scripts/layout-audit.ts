/**
 * 布局质量审计 —— 见 docs/layout-quality-audit.md、docs/modular-layout-compact.md
 *
 * 用法：P4b，或用户抱怨「模块太散 / 空白太多 / 不对齐」时运行。
 *   cd template && npx tsx scripts/layout-audit.ts
 *
 * 模块框默认用 listPageDecorations 自动发现；也可 FRAME_RECTS=id1,id2,... 指定。
 */
import { hqMainWithProject } from "./lib/hq.js";
import {
  EXT_GRID, LABEL_CORRIDOR, MIN_CONTENT_CLEARANCE, MODULE_DENSITY_LOW, SMALL_MODULE_PARTS, MERGE_MAX_PARTS,
  boxArea, boxH, boxW, boxesOverlap, gapBetweenBoxes, gridOccupancy as cellOccupancy,
  listPageDecorations, listWireSegmentsExt, objJson, occupancyMap, PAGE_TOP, refreshPageTop,
  type ExtBox,
} from "./modular-lib";

const CELL = 50;              // 整页空白地图网格
const MODULE_CELL = EXT_GRID; // 模块内密度网格
const MIN_FRAME_AREA = 40000; // 小于此面积的矩形不当模块框

// 起始经验带，可按项目调整（见 layout-quality-audit.md）
const MODULE_DENSITY_HIGH = 70;
const ZONE_DENSITY_HIGH = 72;
const MAX_EMPTY_RATIO = 10;
const MARGIN_RATIO_MAX = 2;

const ok = (pass: boolean) => (pass ? "✅" : "⚠");
const problems: string[] = [];
const note = (msg: string) => problems.push(msg);

function rectExtFromJson(j: Record<string, unknown>): ExtBox {
  const x1 = Number(j.locX);
  const y1 = Number(j.locY);
  return { x1, y1, x2: x1 + (Number(j.x1) - Number(j.x2)), y2: y1 + (Number(j.y2) - Number(j.y1)) };
}

/** 二值矩阵内最大空矩形（直方图法），返回 cell 数 */
function largestEmptyRect(grid: number[][]) {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const heights = new Array<number>(cols).fill(0);
  let best = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) heights[c] = grid[r][c] ? 0 : heights[c] + 1;
    const stack: number[] = [];
    for (let c = 0; c <= cols; c++) {
      const h = c === cols ? 0 : heights[c];
      while (stack.length && heights[stack[stack.length - 1]] >= h) {
        const top = stack.pop()!;
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        best = Math.max(best, heights[top] * (c - left));
      }
      stack.push(c);
    }
  }
  return best;
}

/** 线段是否与矩形边界相交（Liang–Barsky 裁剪 + 端点包含判断） */
function segmentCrossesFrame(p1: { x: number; y: number }, p2: { x: number; y: number }, f: ExtBox) {
  const inside = (p: { x: number; y: number }) => p.x >= f.x1 && p.x <= f.x2 && p.y >= f.y1 && p.y <= f.y2;
  if (inside(p1) !== inside(p2)) return true;
  if (inside(p1) && inside(p2)) return false;
  let t0 = 0;
  let t1 = 1;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  for (const [p, q] of [[-dx, p1.x - f.x1], [dx, f.x2 - p1.x], [-dy, p1.y - f.y1], [dy, f.y2 - p1.y]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

hqMainWithProject(async ({ client, projectContext: ctx }) => {
await refreshPageTop(client, ctx);
const { map, pageBox } = await occupancyMap(client, ctx);
const PAGE: ExtBox = { x1: 0, y1: 0, x2: Number(pageBox.max.x), y2: Number(pageBox.max.y) };
const PAGE_W = boxW(PAGE);
const PAGE_H = boxH(PAGE);

const devs: ExtBox[] = [];
for (const [ref, v] of map) {
  if (/^\d+$/.test(ref)) continue;
  const b = v.bbox;
  devs.push({ x1: Number(b.min.x), y1: Number(b.min.y), x2: Number(b.max.x), y2: Number(b.max.y) });
}
if (!devs.length) {
  console.log("活动页无器件，无需审计");
  return;
}

const wireSegs = await listWireSegmentsExt(client, ctx);

const content: ExtBox = {
  x1: Math.min(...devs.map((d) => d.x1), ...wireSegs.map((w: any) => Math.min(w.a.x, w.b.x))),
  y1: Math.min(...devs.map((d) => d.y1), ...wireSegs.map((w: any) => Math.min(w.a.y, w.b.y))),
  x2: Math.max(...devs.map((d) => d.x2), ...wireSegs.map((w: any) => Math.max(w.a.x, w.b.x))),
  y2: Math.max(...devs.map((d) => d.y2), ...wireSegs.map((w: any) => Math.max(w.a.y, w.b.y))),
};
const sumDev = devs.reduce((s, d) => s + boxArea(d), 0);

console.log("=== 页面 ===");
console.log(`  page_box ${PAGE_W}×${PAGE_H}   PAGE_TOP=${PAGE_TOP}   器件 ${devs.length}  导线段 ${wireSegs.length}`);
console.log(`  内容 union [${content.x1},${content.y1}]-[${content.x2},${content.y2}]  占页 ${((boxArea(content) / boxArea(PAGE)) * 100).toFixed(1)}%（勿单独作紧凑度结论）`);
console.log(`  Σ器件/页面 ${((sumDev / boxArea(PAGE)) * 100).toFixed(2)}%   Σ器件/union ${((sumDev / Math.max(1, boxArea(content))) * 100).toFixed(1)}%`);

const margins = { 左: content.x1, 上: content.y1, 右: PAGE_W - content.x2, 下: PAGE_H - content.y2 };
const mVals = Object.values(margins);
const mRatio = Math.max(...mVals) / Math.max(1, Math.min(...mVals));
console.log(`  页边距 ${Object.entries(margins).map(([k, v]) => `${k} ${v}`).join("  ")}   max/min=${mRatio.toFixed(1)} ${ok(mRatio <= MARGIN_RATIO_MAX)}`);
if (mRatio > MARGIN_RATIO_MAX) note(`页边距不均衡（max/min=${mRatio.toFixed(1)}）→ 重跑 P3.5 repackModules（收拢 + setPageExt）`);

console.log("\n=== 整页空白 ===");
const pageOcc = cellOccupancy(PAGE, devs, CELL);
const emptyCells = largestEmptyRect(pageOcc.grid);
const emptyRatio = (emptyCells * CELL * CELL / boxArea(PAGE)) * 100;
console.log(`  ${CELL} ext 网格占用 ${pageOcc.pct.toFixed(1)}%`);
console.log(`  最大空白矩形 ≈ ${emptyCells} cell = 占页 ${emptyRatio.toFixed(1)}% ${ok(emptyRatio <= MAX_EMPTY_RATIO)}`);
if (emptyRatio > MAX_EMPTY_RATIO) note(`存在大片空白（占页 ${emptyRatio.toFixed(1)}%）→ 收紧模块走廊至 ${LABEL_CORRIDOR} ext，或重跑 P3.5 repackModules`);

console.log("\n=== 六分区占用（2 行 × 3 列）===");
for (let r = 0; r < 2; r++) {
  const line: string[] = [];
  for (let c = 0; c < 3; c++) {
    const zone: ExtBox = {
      x1: Math.round((PAGE_W / 3) * c), y1: Math.round((PAGE_H / 2) * r),
      x2: Math.round((PAGE_W / 3) * (c + 1)), y2: Math.round((PAGE_H / 2) * (r + 1)),
    };
    const pct = cellOccupancy(zone, devs.filter((d) => boxesOverlap(d, zone)), CELL).pct;
    if (pct > ZONE_DENSITY_HIGH) note(`分区[${r},${c}] 占用 ${pct.toFixed(0)}% 偏挤 → 拆模块或加大页`);
    line.push(`${pct.toFixed(0)}%`.padStart(5));
  }
  console.log(`  ${line.join(" |")}`);
}

// ─── 模块框 ─────────────────────────────────────────────
const frameIds = (process.env.FRAME_RECTS ?? "").split(",").filter(Boolean);
type Frame = { box: ExtBox; label: string };
const frames: Frame[] = [];

if (frameIds.length) {
  for (const id of frameIds) {
    try {
      frames.push({ box: rectExtFromJson(await objJson(client, ctx, BigInt(id)) as Record<string, unknown>), label: `#${id}` });
    } catch { /* skip */ }
  }
} else {
  const items = await listPageDecorations(client, ctx);
  const toBox = (it: any): ExtBox | null => it.box?.min && it.box?.max
    ? { x1: Number(it.box.min.x), y1: Number(it.box.min.y), x2: Number(it.box.max.x), y2: Number(it.box.max.y) }
    : null;
  const texts = items.filter((it: any) => it.text).map((it: any) => ({ text: String(it.text), box: toBox(it) }));
  for (const it of items as any[]) {
    if (it.text) continue;
    const box = toBox(it);
    if (!box || boxArea(box) < MIN_FRAME_AREA) continue;
    const near = texts
      .filter((t) => t.box && t.box.x1 >= box.x1 - EXT_GRID * 4 && t.box.x1 <= box.x2
        && t.box.y1 >= box.y1 - EXT_GRID * 6 && t.box.y1 <= box.y1 + EXT_GRID * 4)
      .sort((a, b) => Math.abs(a.box!.y1 - box.y1) - Math.abs(b.box!.y1 - box.y1));
    const title = near[0];
    if (title?.box && title.box.y1 < box.y1) {
      note(`「${title.text}」标题在框外 → 放到框内左上角（placeModuleFrameAndTitle 默认 titleDy 向内）`);
    }
    frames.push({ box, label: title?.text ?? `rect#${it.objectId}` });
  }
}

if (!frames.length) {
  console.log("\n=== 模块框 ===\n  未发现模块框（P4a 未做，或引擎 listPageDecorations 不可用；可用 FRAME_RECTS= 指定）");
} else {
  console.log(`\n=== 模块框 ${frames.length} 个（密度 / 净距 / mod${EXT_GRID}）===`);
  for (const f of frames) {
    const inner = devs.filter((d) => boxesOverlap(d, f.box));
    const dens = cellOccupancy(f.box, inner, MODULE_CELL).pct;
    const clearance = inner.length
      ? Math.min(...inner.map((d) => Math.min(d.x1 - f.box.x1, f.box.x2 - d.x2, d.y1 - f.box.y1, f.box.y2 - d.y2)))
      : Infinity;
    const mods = [f.box.x1, f.box.y1, f.box.x2, f.box.y2].map((v) => v % EXT_GRID);
    const aligned = mods.every((v) => v === 0);
    const small = inner.length > 0 && inner.length <= SMALL_MODULE_PARTS;
    const densOk = (small || dens >= MODULE_DENSITY_LOW) && dens <= MODULE_DENSITY_HIGH;
    console.log(`  ${f.label}`);
    console.log(`    ${boxW(f.box)}×${boxH(f.box)} 器件 ${inner.length}  密度 ${dens.toFixed(0)}% ${small && dens < MODULE_DENSITY_LOW ? "ℹ 小模块不判" : ok(densOk)}  内容净距 ${clearance === Infinity ? "-" : clearance} ${ok(clearance >= MIN_CONTENT_CLEARANCE)}  mod${EXT_GRID} ${aligned ? "✅" : "❌"}`);
    if (!inner.length) note(`「${f.label}」框内无器件 → 删掉空框`);
    else if (inner.length <= MERGE_MAX_PARTS) note(`「${f.label}」只有 ${inner.length} 个器件 → 并入与之相连的功能模块（attachTo），不单独成框`);
    else if (dens < MODULE_DENSITY_LOW && !small) note(`「${f.label}」密度 ${dens.toFixed(0)}% 偏空 → 缩小该框（减小 pad）或与邻模块合并`);
    else if (dens > MODULE_DENSITY_HIGH) note(`「${f.label}」密度 ${dens.toFixed(0)}% 偏挤 → 略扩框或拆分`);
    if (clearance < MIN_CONTENT_CLEARANCE) note(`「${f.label}」内容贴框/被框切 → 框边至少离内容 ${MIN_CONTENT_CLEARANCE} ext`);
    if (!aligned) note(`「${f.label}」框边未吸附 ${EXT_GRID} ext 网格`);
  }

  const gaps: Array<{ g: number; a: string; b: string }> = [];
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      gaps.push({ g: gapBetweenBoxes(frames[i].box, frames[j].box), a: frames[i].label, b: frames[j].label });
    }
  }
  // 只看每个框的最近邻，避免对角远框拉高散度
  const nearest = frames.map((f) => {
    const cands = gaps.filter((x) => x.a === f.label || x.b === f.label).map((x) => x.g);
    return { label: f.label, g: cands.length ? Math.min(...cands) : 0 };
  });
  const nVals = nearest.map((n) => n.g);
  const nMin = Math.min(...nVals);
  const nMax = Math.max(...nVals);
  console.log(`\n  最近邻间距 min=${nMin} max=${nMax} 散度=${(nMax / Math.max(1, nMin)).toFixed(1)}  目标 ≈${LABEL_CORRIDOR}~${LABEL_CORRIDOR * 2} ext`);
  for (const n of nearest) {
    if (n.g < EXT_GRID) note(`「${n.label}」与邻框几乎相接/重叠 → 至少留 ${LABEL_CORRIDOR} ext 标签走廊`);
    else if (n.g > LABEL_CORRIDOR * 3) note(`「${n.label}」离最近模块 ${n.g} ext 过远 → 向主控方向收拢`);
  }

  // ─── 网格对齐：每条框边要么贴整体外轮廓，要么与另一框同边对齐，要么与相邻框隔一个统一走廊
  console.log(`\n=== 网格对齐（容差 ${EXT_GRID} ext）===`);
  const TOL = EXT_GRID;
  const env: ExtBox = {
    x1: Math.min(...frames.map((f) => f.box.x1)), y1: Math.min(...frames.map((f) => f.box.y1)),
    x2: Math.max(...frames.map((f) => f.box.x2)), y2: Math.max(...frames.map((f) => f.box.y2)),
  };
  const near = (a: number, b: number) => Math.abs(a - b) <= TOL;
  const overlapX = (a: ExtBox, b: ExtBox) => Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 0;
  const overlapY = (a: ExtBox, b: ExtBox) => Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > 0;
  type Side = "上" | "下" | "左" | "右";
  const neighborGap = (f: ExtBox, side: Side): number | null => {
    const cands = frames.map((o) => o.box).filter((o) => o !== f).flatMap((o) => {
      if (side === "上" && o.y2 <= f.y1 && overlapX(o, f)) return [f.y1 - o.y2];
      if (side === "下" && o.y1 >= f.y2 && overlapX(o, f)) return [o.y1 - f.y2];
      if (side === "左" && o.x2 <= f.x1 && overlapY(o, f)) return [f.x1 - o.x2];
      if (side === "右" && o.x1 >= f.x2 && overlapY(o, f)) return [o.x1 - f.x2];
      return [];
    });
    return cands.length ? Math.min(...cands) : null;
  };
  const edge = (b: ExtBox, side: Side) => (side === "上" ? b.y1 : side === "下" ? b.y2 : side === "左" ? b.x1 : b.x2);
  const envEdge = (side: Side) => edge(env, side);

  const neighborGaps: number[] = [];
  const misaligned: string[] = [];
  for (const f of frames) {
    const bad: Side[] = [];
    for (const side of ["上", "下", "左", "右"] as Side[]) {
      const g = neighborGap(f.box, side);
      if (g != null && g <= LABEL_CORRIDOR * 3) neighborGaps.push(g);
      const onEnvelope = near(edge(f.box, side), envEdge(side));
      const sharesEdge = frames.some((o) => o !== f && near(edge(o.box, side), edge(f.box, side)));
      const corridorNext = g != null && g <= LABEL_CORRIDOR + TOL;
      if (!onEnvelope && !sharesEdge && !corridorNext) bad.push(side);
    }
    if (bad.length) misaligned.push(`${f.label}（${bad.join("/")}）`);
  }
  console.log(`  外轮廓 [${env.x1},${env.y1}]-[${env.x2},${env.y2}]`);
  console.log(`  边未对齐的框 ${misaligned.length} ${misaligned.length ? "❌" : "✅"}${misaligned.length ? `  ${misaligned.join("，")}` : ""}`);
  if (misaligned.length) {
    note(`框边不齐：${misaligned.join("，")} → 先 repackModules 收拢，再用 placeGridFrames 按网格单元拉框`);
  }
  if (neighborGaps.length) {
    const gMin = Math.min(...neighborGaps);
    const gMax = Math.max(...neighborGaps);
    const even = gMax - gMin <= TOL;
    console.log(`  相邻框间距 ${gMin}～${gMax} ext ${even ? "✅" : "❌"}（目标统一为 ${LABEL_CORRIDOR}）`);
    if (!even) note(`相邻框间距不一致（${gMin}～${gMax} ext）→ 用 planCompactZones grid 统一走廊 ${LABEL_CORRIDOR} ext`);
  }

  console.log("\n=== 导线穿模块框（跨模块应只走 NetAlias）===");
  let crossing = 0;
  const crossers = new Set<string>();
  for (const w of wireSegs) {
    for (const f of frames) {
      if (segmentCrossesFrame(w.a, w.b, f.box)) {
        crossing++;
        crossers.add(f.label);
        break;
      }
    }
  }
  console.log(`  穿框导线段 ${crossing} ${crossing === 0 ? "✅" : "❌"}${crossing ? `  涉及: ${[...crossers].join(", ")}` : ""}`);
  if (crossing) note(`${crossing} 段导线穿过模块框 → 改为双端 placePinStubWireAndNetAlias（同名网络）`);
}

console.log("\n=== 结论 ===");
if (!problems.length) console.log("  ✅ 未发现布局问题");
else problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));

});

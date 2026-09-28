/**
 * 布局质量审计 —— 见 docs/layout-quality-audit.md
 *
 * 用法：P4b 前或用户抱怨「空白太多/不对齐」时运行。
 * 可选环境变量 FRAME_RECTS=id1,id2,...（place-rect 的 objectId，用于对齐检测）
 */
import { openCtx, objJson, occupancyMap, PAGE_TOP } from "./modular-lib";

const CELL = 50;

interface Box { x1: number; y1: number; x2: number; y2: number }

function rectExtFromJson(j: Record<string, unknown>): Box {
  const x1 = Number(j.locX);
  const y1 = Number(j.locY);
  const w = Number(j.x1) - Number(j.x2);
  const h = Number(j.y2) - Number(j.y1);
  return { x1, y1, x2: x1 + w, y2: y1 + h };
}

const { client, ctx } = await openCtx();
const { map, pageBox } = await occupancyMap(client, ctx);
const PAGE_W = Number(pageBox.max.x);
const PAGE_H = Number(pageBox.max.y);

const devs: Box[] = [];
for (const [ref, v] of map) {
  if (/^\d+$/.test(ref)) continue;
  const b = v.bbox;
  devs.push({ x1: Number(b.min.x), y1: Number(b.min.y), x2: Number(b.max.x), y2: Number(b.max.y) });
}

const wires: any = await client.canvasOps.listWireSegments({ context: ctx } as any);
let wx1 = 1e9, wy1 = 1e9, wx2 = -1e9, wy2 = -1e9;
for (const w of wires.wires ?? []) {
  for (const p of [w.start, w.end]) {
    const x = Number(p.x), y = PAGE_TOP - Number(p.y);
    wx1 = Math.min(wx1, x); wx2 = Math.max(wx2, x);
    wy1 = Math.min(wy1, y); wy2 = Math.max(wy2, y);
  }
}

const cx1 = Math.min(...devs.map((d) => d.x1), wx1);
const cy1 = Math.min(...devs.map((d) => d.y1), wy1);
const cx2 = Math.max(...devs.map((d) => d.x2), wx2);
const cy2 = Math.max(...devs.map((d) => d.y2), wy2);
const uW = cx2 - cx1, uH = cy2 - cy1;
const pageArea = PAGE_W * PAGE_H;
const unionArea = uW * uH;
const sumDev = devs.reduce((s, d) => s + (d.x2 - d.x1) * (d.y2 - d.y1), 0);

console.log("=== 页面 ===");
console.log(`  page_box: ${PAGE_W}×${PAGE_H}  PAGE_TOP=${PAGE_TOP}`);
console.log("\n=== 1) union 外接矩形（勿单独用作紧凑度结论）===");
console.log(`  [${cx1},${cy1}]-[${cx2},${cy2}]  union/页面 = ${((unionArea / pageArea) * 100).toFixed(1)}%`);
console.log("\n=== 2) 真实填充率 ===");
console.log(`  Σ器件/页面 = ${((sumDev / pageArea) * 100).toFixed(2)}%`);
console.log(`  Σ器件/union = ${((sumDev / unionArea) * 100).toFixed(1)}%`);

const cols = Math.ceil(PAGE_W / CELL), rows = Math.ceil(PAGE_H / CELL);
const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
const mark = (b: Box) => {
  for (let y = Math.max(0, Math.floor(b.y1 / CELL)); y <= Math.min(rows - 1, Math.floor((b.y2 - 1) / CELL)); y++)
    for (let x = Math.max(0, Math.floor(b.x1 / CELL)); x <= Math.min(cols - 1, Math.floor((b.x2 - 1) / CELL)); x++) grid[y][x] = 1;
};
for (const d of devs) mark(d);

let occ = 0;
for (const row of grid) for (const c of row) occ += c;
console.log("\n=== 3) 网格占用（50 ext）===");
console.log(`  ${occ}/${cols * rows} = ${((occ / (cols * rows)) * 100).toFixed(1)}%`);

const frameIds = (process.env.FRAME_RECTS ?? "").split(",").filter(Boolean);
const frames: Box[] = [];
for (const id of frameIds) {
  try {
    frames.push(rectExtFromJson(await objJson(client, ctx, BigInt(id)) as Record<string, unknown>));
  } catch { /* skip */ }
}
if (frames.length) {
  console.log("\n=== 4) 模块框对齐 mod20 ===");
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const m = [f.x1, f.y1, f.x2, f.y2].map((v) => v % 20);
    const ok = m.every((v) => v === 0);
    console.log(`  #${i + 1} [${f.x1},${f.y1}]-[${f.x2},${f.y2}] mod20=[${m.join(",")}] ${ok ? "✅" : "❌"}`);
  }
  const gap = (a: Box, b: Box) => {
    const dx = Math.max(0, Math.max(a.x1 - b.x2, b.x1 - a.x2));
    const dy = Math.max(0, Math.max(a.y1 - b.y2, b.y1 - a.y2));
    return dx + dy;
  };
  const gaps: number[] = [];
  for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) gaps.push(gap(frames[i], frames[j]));
  gaps.sort((a, b) => a - b);
  if (gaps.length) {
    console.log(`  框间距 min=${gaps[0]} max=${gaps.at(-1)} avg=${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(0)} ext`);
  }
} else {
  console.log("\n=== 4) 模块框（跳过：设置 FRAME_RECTS=id1,id2,...）===");
}

console.log("\n=== 5) 页边距（器件 union）===");
console.log(`  左 ${cx1} 上 ${cy1} 右 ${PAGE_W - cx2} 下 ${PAGE_H - cy2}`);

client.close();

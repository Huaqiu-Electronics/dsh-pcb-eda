/**
 * Scenario B · 模块化布局公共库
 *
 * - 活动页引脚：优先 getObjectJsonById → PortInstScalar（勿依赖陈旧 snapshot）
 * - ext 坐标 Y 向下；PAGE_TOP 默认 1400，应与 page_box.max.y 一致（P0 后读取）
 */
import { connect, toJsonString } from "@huaqiu/huaqiu-client";

export let PAGE_TOP = 1400;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  try {
    const occ: any = await client.patternLayout.getPageOccupancy({ context: ctx, includeWires: false });
    const py = Number(occ.pageBox?.max?.y);
    if (py > 0) PAGE_TOP = py;
  } catch { /* keep default */ }
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

export const toJson = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));

export async function setRefValue(client: C, ctx: P, objectId: bigint, ref: string, value: string) {
  await client.canvasOps.setObjectProperty({ context: ctx, objectId, propKey: "Part Reference", propValue: ref, op: 1, commitUndo: true });
  await client.canvasOps.setObjectProperty({ context: ctx, objectId, propKey: "Value", propValue: value, op: 1, commitUndo: true });
}

/** 活动页网络列表（Connect-ES 响应形状） */
export async function activePageNets(client: C, ctx: P) {
  const resp: any = await client.netList.getActivePageNetList({ context: ctx } as any);
  return (resp.result?.value?.nets ?? []) as Array<{ name: string; pinReferences?: Array<{ referenceDesignator: string; pinNumber: string }> }>;
}

/**
 * 读电路模板 —— 理解已有设计的标准流程（只读，不修改任何东西）
 *
 * 用法：
 *   npx tsx scripts/read-circuit.ts
 *   REF=VR201 npx tsx scripts/read-circuit.ts
 *   NET=+3.3V npx tsx scripts/read-circuit.ts
 *   REF=VR201 TRACE=1 npx tsx scripts/read-circuit.ts
 */
import { hqMainWithProject, type EditorClient, type ProjectContext } from "./lib/hq.js";

const REF = process.env.REF;
const NET = process.env.NET;
const TRACE = process.env.TRACE === "1" || process.env.TRACE === "true";
const TRACE_DEPTH = Math.max(1, Math.min(4, parseInt(process.env.TRACE_DEPTH ?? "2", 10) || 2));

const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? String(v) : v);
const js = (v: unknown, n = 400) => {
  const s = JSON.stringify(v, bigintSafe, 1) ?? "(undefined)";
  return s.length > n ? s.slice(0, n) + " …" : s;
};
const pos = (v: unknown) => {
  const o = v as { x?: unknown; y?: unknown } | undefined;
  return o && o.x !== undefined ? `(${o.x},${o.y})` : js(v, 60);
};
function propVal(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "value" in o ? propVal(o.value) : js(v, 120);
  }
  return String(v);
}
const isRailName = (n: string) =>
  /^[+-]?\d+(\.\d+)?V$/i.test(n) || /^V(CC|DD|EE|BAT|IN|OUT)?[A-Z0-9_]*$/i.test(n) || /^\+/.test(n);

type Sym = Record<string, unknown>;
type Pin = Record<string, unknown>;
type Net = { name?: string; netClass?: number; pinInstanceIds?: string[] };
type Def = { name?: string; pins?: Array<{ number?: string; name?: string; electricalType?: number }> };
type PinRow = { num: string; name: string; net: string; pos: unknown };

const NET_CLASS: Record<number, string> = { 0: "UNSPECIFIED", 1: "SIGNAL", 2: "POWER", 3: "GROUND", 4: "BUS" };

function metaId(obj: Record<string, unknown> | undefined): string {
  return String((obj?.metadata as Record<string, unknown> | undefined)?.id ?? "");
}
function symMetaId(sym: Sym): string {
  return metaId(sym as Record<string, unknown>) || String(sym.canvasObjectId ?? "");
}
function pinMetaId(pin: Pin): string {
  return metaId(pin as Record<string, unknown>);
}
function refPrefix(ref: string): string {
  const m = /^([A-Za-z_]+)/.exec(ref);
  return m?.[1] ?? ref;
}
function isPassiveBridgePrefix(ref: string): boolean {
  return /^(C|R|L|FB|FL|BEAD)$/i.test(refPrefix(ref));
}
function isActivePrefix(ref: string): boolean {
  const p = refPrefix(ref).toUpperCase();
  return /^(U|VR|Q|IC|D|J|X|Y|K|SW|S|T|M)/.test(p) && !isPassiveBridgePrefix(ref);
}
function isPowerRailNet(name: string, netClass?: number): boolean {
  if ((netClass ?? 0) >= 2) return true;
  return /^(GND|VCC|VDD|VEE|VSS|\+|\-)/i.test(name) || isRailName(name);
}
function neighborRoleHint(ref: string): string {
  const p = refPrefix(ref).toUpperCase();
  if (/^C/.test(p)) return "旁路/滤波电容";
  if (/^R/.test(p)) return "电阻(上拉/下拉/分压)";
  if (/^(L|FB|FL|BEAD)/.test(p)) return "电感/磁珠";
  if (/^(U|VR|IC)/.test(p)) return "有源器件";
  if (/^(D|Q)/.test(p)) return "二极管/晶体管";
  if (/^(VCC|VDD|GND)/.test(ref)) return "电源轨符号";
  return "无源/其它";
}
function symValue(sym: Sym | undefined): string {
  if (!sym) return "";
  const props = ((sym.metadata as Record<string, unknown> | undefined)?.properties as Array<{ key: string; value: unknown }>) ?? [];
  const v = props.find((p) => p.key === "Value");
  return v ? propVal(v.value).slice(0, 40) : "";
}

class SnapCtx {
  readonly syms: Sym[];
  readonly pins: Pin[];
  readonly nets: Net[];
  readonly defs: Def[];
  readonly netOf = new Map<string, string>();
  readonly pinById = new Map<string, Pin>();
  readonly symByMetaId = new Map<string, Sym>();
  readonly symByDesignator = new Map<string, Sym>();
  readonly defByName = new Map<string, Def>();
  readonly netByName = new Map<string, Net>();

  constructor(raw: Record<string, unknown[]>) {
    this.syms = (raw.symbolInstances ?? []) as Sym[];
    this.pins = (raw.pinInstances ?? []) as Pin[];
    this.nets = (raw.nets ?? []) as unknown as Net[];
    this.defs = (raw.symbolDefinitions ?? []) as unknown as Def[];
    for (const net of this.nets) {
      if (net.name) this.netByName.set(net.name, net);
      for (const pid of net.pinInstanceIds ?? []) this.netOf.set(pid, net.name ?? "?");
    }
    for (const p of this.pins) this.pinById.set(pinMetaId(p), p);
    for (const s of this.syms) {
      if (s.designator) this.symByDesignator.set(String(s.designator), s);
      this.symByMetaId.set(symMetaId(s), s);
    }
    for (const d of this.defs) if (d.name) this.defByName.set(d.name, d);
  }

  pinNameTable(definitionId: unknown): Map<string, string> {
    const d = this.defByName.get(String(definitionId));
    const m = new Map<string, string>();
    for (const p of d?.pins ?? []) m.set(String(p.number), String(p.name));
    return m;
  }
  pinsOfRef(ref: string): Pin[] {
    const sym = this.symByDesignator.get(ref);
    if (!sym) return [];
    return this.pins.filter((p) => String(p.symbolInstanceId) === symMetaId(sym));
  }
  pinRows(ref: string): PinRow[] {
    const sym = this.symByDesignator.get(ref);
    if (!sym) return [];
    const pn = this.pinNameTable(sym.definitionId);
    return this.pinsOfRef(ref)
      .map((p) => ({
        num: String(p.pinDefinitionId),
        name: pn.get(String(p.pinDefinitionId)) ?? "?",
        net: this.netOf.get(pinMetaId(p)) ?? "(未连接)",
        pos: p.position,
      }))
      .sort((a, b) => Number(a.num) - Number(b.num));
  }
  netMembers(netName: string, excludeRef?: string): Array<{ ref: string; pinLabel: string }> {
    const net = this.netByName.get(netName);
    if (!net) return [];
    const out: Array<{ ref: string; pinLabel: string }> = [];
    for (const pid of net.pinInstanceIds ?? []) {
      const p = this.pinById.get(pid);
      if (!p) continue;
      const sym = this.symByMetaId.get(String(p.symbolInstanceId));
      const ref = String(sym?.designator ?? "?");
      if (excludeRef && ref === excludeRef) continue;
      const pn = this.pinNameTable(sym?.definitionId);
      const num = String(p.pinDefinitionId);
      out.push({ ref, pinLabel: `${num}(${pn.get(num) ?? "?"})` });
    }
    return out;
  }
  prefixStats(members: Array<{ ref: string }>): string {
    const cnt = new Map<string, number>();
    const refs = new Set<string>();
    for (const m of members) {
      if (refs.has(m.ref)) continue;
      refs.add(m.ref);
      cnt.set(refPrefix(m.ref), (cnt.get(refPrefix(m.ref)) ?? 0) + 1);
    }
    return [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(", ");
  }
}

type SeriesBridge = { ref: string; value: string; netA: string; netB: string };

function buildSeriesBridgeGraph(ctx: SnapCtx): SeriesBridge[] {
  const bridges: SeriesBridge[] = [];
  const seen = new Set<string>();
  for (const sym of ctx.syms) {
    const ref = String(sym.designator ?? "");
    if (!ref || !isPassiveBridgePrefix(ref)) continue;
    const myPins = ctx.pinsOfRef(ref).filter((p) => ctx.netOf.get(pinMetaId(p)));
    if (myPins.length !== 2) continue;
    const nets = [...new Set(myPins.map((p) => ctx.netOf.get(pinMetaId(p))!))];
    if (nets.length !== 2) continue;
    const [netA, netB] = nets;
    if (refPrefix(ref).toUpperCase() === "C") {
      const aRail = isPowerRailNet(netA, ctx.netByName.get(netA)?.netClass);
      const bRail = isPowerRailNet(netB, ctx.netByName.get(netB)?.netClass);
      if (aRail !== bRail) continue;
    }
    const key = [ref, ...nets.sort()].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    bridges.push({ ref, value: symValue(sym), netA, netB });
  }
  return bridges;
}
function bridgesFromNet(bridges: SeriesBridge[], netName: string): SeriesBridge[] {
  return bridges.filter((b) => b.netA === netName || b.netB === netName);
}
function otherNet(bridge: SeriesBridge, netName: string): string {
  return bridge.netA === netName ? bridge.netB : bridge.netA;
}

function expandNeighborhood(ctx: SnapCtx, ref: string, rows: PinRow[]): void {
  console.log(`\n  ── 邻域展开（同网 1 跳）──`);
  for (const r of rows) {
    if (r.net === "(未连接)") {
      console.log(`    pin${r.num} ${r.name.padEnd(10)} → (未连接)`);
      continue;
    }
    const allMembers = ctx.netMembers(r.net);
    const neighbors = ctx.netMembers(r.net, ref);
    const net = ctx.netByName.get(r.net);
    const nc = NET_CLASS[net?.netClass ?? -1] ?? String(net?.netClass ?? "?");
    console.log(`    pin${r.num} ${String(r.name).padEnd(10)} → ${String(r.net).padEnd(16)} [${nc}]`);
    if (allMembers.length <= 8) {
      const list = neighbors.map((m) => `${m.ref}(${m.pinLabel})`).join(", ");
      console.log(`      同网邻居: ${list || "(仅本器件)"}  [${new Set(allMembers.map((m) => m.ref)).size} 器件 / ${neighbors.length} 脚]`);
    } else {
      console.log(`      同网邻居: (大网摘要) ${new Set(allMembers.map((m) => m.ref)).size} 器件 / ${allMembers.length} 脚 | ${ctx.prefixStats(neighbors)}`);
      console.log(`      代表: ${neighbors.slice(0, 5).map((m) => `${m.ref}(${m.pinLabel})`).join(", ")}${neighbors.length > 5 ? " …" : ""}`);
    }
    const roles = [...new Set(neighbors.slice(0, 6).map((m) => neighborRoleHint(m.ref)))];
    if (roles.length) console.log(`      角色推断: ${roles.join("；")}`);
    for (const m of neighbors.slice(0, 4)) {
      const val = symValue(ctx.symByDesignator.get(m.ref));
      if (val) console.log(`        ${m.ref} Value=${val}`);
    }
  }
}

function traceThroughPassives(ctx: SnapCtx, ref: string, rows: PinRow[], bridges: SeriesBridge[], maxDepth: number): void {
  console.log(`\n  ── 串联穿透（C/R/L/FB，max ${maxDepth} 跳）──`);
  let found = 0;
  for (const r of rows) {
    if (r.net === "(未连接)") continue;
    type QItem = { net: string; path: string[]; depth: number };
    const queue: QItem[] = [{ net: r.net, path: [r.net], depth: 0 }];
    const visited = new Set<string>();
    while (queue.length) {
      const { net, path, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;
      for (const br of bridgesFromNet(bridges, net)) {
        const next = otherNet(br, net);
        if (path.includes(next)) continue;
        if (isPowerRailNet(next, ctx.netByName.get(next)?.netClass) && depth > 0) continue;
        const label = br.value ? `${br.ref} ${br.value}` : br.ref;
        console.log(`    pin${r.num} ${r.name}: ${path.join(" → ")} —[${label}]— ${next}`);
        const active = ctx.netMembers(next, ref).filter((m) => isActivePrefix(m.ref));
        if (active.length) console.log(`      对侧有源: ${active.slice(0, 5).map((m) => `${m.ref}(${m.pinLabel})`).join(", ")}`);
        else {
          const passive = ctx.netMembers(next, ref).slice(0, 4).map((m) => `${m.ref}(${m.pinLabel})`).join(", ");
          if (passive) console.log(`      对侧: ${passive}`);
        }
        found++;
        const vkey = `${next}|${depth + 1}`;
        if (!visited.has(vkey)) {
          visited.add(vkey);
          queue.push({ net: next, path: [...path, next], depth: depth + 1 });
        }
      }
    }
  }
  if (!found) console.log(`    (未发现可穿透的串联 C/R/L/FB 链路)`);
}

function printRoleSummary(ref: string, sym: Sym, rows: PinRow[], props: Array<{ key: string; value: unknown }>): void {
  console.log(`\n  ── 作用回答要点（供 agent 组织自然语言）──`);
  const desc = props.find((p) => p.key === "Description");
  const mpn = props.find((p) => p.key === "MPN");
  if (desc) console.log(`    身份: ${propVal(desc.value).slice(0, 120)}`);
  else console.log(`    身份: ${String(sym.definitionId)}（无 Description，勿编造 datasheet）`);
  if (mpn) console.log(`    MPN: ${propVal(mpn.value)}`);
  console.log(`    连接: ${rows.map((r) => `${r.name}→${r.net}`).join("; ")}`);
  console.log(`    总结: 结合邻域${TRACE ? "/穿透" : ""}块描述 ${ref} 在局部子电路中的功能`);
}

async function resolveCanvasIds(
  client: EditorClient,
  ctx: ProjectContext,
  ref: string,
  sym: Sym,
): Promise<void> {
  console.log(`\n  ── canvas 编辑 id（读懂 → 改电路桥接）──`);
  console.log(`    snapshot metadata.id:  ${symMetaId(sym)}`);
  console.log(`    canvasObjectId:       ${sym.canvasObjectId ?? "(空)"}`);
  try {
    const found = await client.canvasOps.findObjectByProperty({ context: ctx, propKey: "Reference", propValue: ref });
    console.log(`    FindObject(Reference): ${found.objectIds?.[0] ?? "(未找到)"}`);
  } catch {
    console.log(`    FindObject(Reference): (调用失败)`);
  }
}

hqMainWithProject(async ({ client, projectId, projectContext: pctx }) => {
  console.log(`工程 projectId: ${projectId}\n`);

  const t = Date.now();
  const snap = await client.kernel.getSnapshot({ context: pctx });
  const ctx = new SnapCtx(snap.snapshot as unknown as Record<string, unknown[]>);
  console.log(`[快照] ${Date.now() - t}ms — ${ctx.syms.length} 器件 / ${ctx.pins.length} 引脚 / ${ctx.nets.length} 网络\n`);

  if (!REF && !NET) {
    console.log("=== 网络分类（netClass）===");
    const byClass = new Map<number, number>();
    for (const n of ctx.nets) byClass.set(n.netClass ?? -1, (byClass.get(n.netClass ?? -1) ?? 0) + 1);
    for (const [k, v] of [...byClass.entries()].sort()) console.log(`  ${String(NET_CLASS[k] ?? k).padEnd(12)} ${v}`);
    const bridges = buildSeriesBridgeGraph(ctx);
    console.log(`\n=== 可穿透串联无源件: ${bridges.length} 个 ===`);
    for (const b of bridges.slice(0, 8)) console.log(`  ${b.ref}  ${b.netA} ↔ ${b.netB}`);
    console.log(`\n提示：REF= / NET= ；串联穿透 TRACE=1`);
    return;
  }

  if (REF) {
    const sym = ctx.symByDesignator.get(REF);
    if (!sym) {
      const cands = ctx.syms.filter((x) => String(x.designator ?? "").includes(REF));
      console.log(`未找到位号 ${REF}`);
      if (cands.length) console.log(`  相近: ${cands.slice(0, 8).map((x) => x.designator).join(", ")}`);
      return;
    }
    console.log(`=== ${REF} ===`);
    console.log(`  definitionId: ${sym.definitionId}  position: ${pos(sym.position)}`);
    const props = ((sym.metadata as Record<string, unknown> | undefined)?.properties as Array<{ key: string; value: unknown }>) ?? [];
    if (props.filter((p) => p.key !== "pins").length) {
      console.log(`\n  ── 器件参数 ──`);
      for (const p of props.filter((x) => x.key !== "pins")) console.log(`    ${p.key} = ${propVal(p.value).slice(0, 100)}`);
    } else console.log(`\n  ── 器件参数 ── (空) 禁止编造 datasheet`);
    const rows = ctx.pinRows(REF);
    console.log(`\n  ── 引脚 → 网络 ──`);
    for (const r of rows) console.log(`    pin${r.num} ${String(r.name).padEnd(10)} → ${r.net}`);
    expandNeighborhood(ctx, REF, rows);
    const bridges = buildSeriesBridgeGraph(ctx);
    if (TRACE) traceThroughPassives(ctx, REF, rows, bridges, TRACE_DEPTH);
    else console.log(`\n  (设 TRACE=1 开启串联穿透)`);
    printRoleSummary(REF, sym, rows, props);
    await resolveCanvasIds(client, pctx, REF, sym);
  }

  if (NET) {
    const net = ctx.netByName.get(NET);
    if (!net) { console.log(`未找到网络 ${NET}`); return; }
    console.log(`\n=== 网络 "${NET}" === netClass=${net.netClass} 成员=${net.pinInstanceIds?.length ?? 0} 脚`);
    const byRef = new Map<string, string[]>();
    for (const m of ctx.netMembers(NET)) {
      if (!byRef.has(m.ref)) byRef.set(m.ref, []);
      byRef.get(m.ref)!.push(m.pinLabel);
    }
    for (const [ref, list] of [...byRef.entries()].sort()) console.log(`    ${ref}: ${list.join(", ")} (${neighborRoleHint(ref)})`);
    for (const b of bridgesFromNet(buildSeriesBridgeGraph(ctx), NET))
      console.log(`    串联: ${b.ref} → 对侧 ${otherNet(b, NET)}`);
  }
});
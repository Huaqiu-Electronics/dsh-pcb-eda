/**
 * STM32F103 最小系统 · 单入口（清页 → P0 → P1 → P2/P3 → P3b → P4a）
 *
 *   npx tsx scripts/stm32-min-system.ts
 *
 * 仅本文件为入口；勿 import 带 main() 的脚本（避免重复放置）。
 */
import { HqServicesV1PatternLayoutService as PL } from "@hqedge/connect";
import {
  PAGE_H, PAGE_W, STM32_MODULES, STM32_SLOTS, TITLE_DY, at, frameOf,
} from "./modular-grid";
import {
  activePageNets, idOf, occupancyMap, openCtx, pinsOf, searchAndPlace,
  setRefValue, sleep, toJson, waitForIds,
} from "./modular-lib";

const PID = PL.CircuitPatternId;
const ORI = PL.PatternOrientation.PATTERN_ORIENT_LEFT_TO_RIGHT;
const ROUTE = PL.PatternRouteMode.PATTERN_ROUTE_FULL;
const PWR = PL.PatternPowerMode.PATTERN_POWER_AUTO_PLACE;

const PART_REFS = [
  "J1", "U1", "C1", "C2", "U3", "R5", "J2", "R4", "Y1", "C3", "C4",
  "C10", "C11", "C12", "C13", "R1", "C9", "SW1", "U2",
] as const;

// ─── 清页 ─────────────────────────────────────────────
async function clearPage(client: any, ctx: any) {
  for (let round = 0; round < 8; round++) {
    const ids = new Set<string>();
    const occ: any = await client.patternLayout.getPageOccupancy({ context: ctx, includeWires: true });
    for (const it of occ.items ?? []) ids.add(String(it.objectId));
    const wires: any = await client.canvasOps.listWireSegments({ context: ctx } as any);
    for (const w of wires.wires ?? []) ids.add(String(w.objectId));
    if (!ids.size) {
      console.log(round === 0 ? "  活动页已空" : `  清页完成（${round} 轮）`);
      return;
    }
    console.log(`  第 ${round + 1} 轮删除 ${ids.size} 个对象…`);
    await client.canvasOps.deleteObjectsByIds({
      context: ctx, objectIds: [...ids].map((x) => BigInt(x)),
    } as any);
    await sleep(600);
  }
  throw new Error("清页未干净，请手动检查活动页");
}

async function setPage(client: any, ctx: any) {
  await client.canvasOps.setPageSize({
    context: ctx, ltX: 0, ltY: 0, rbX: PAGE_W, rbY: PAGE_H,
    showBorder: true, pageSizeLabel: "Custom",
  } as any);
}

function assertUniqueParts(map: Map<string, unknown>) {
  for (const ref of PART_REFS) {
    const hits = [...map.keys()].filter((k) => k === ref || k.startsWith(`${ref}#`));
    if (ref === "U2") {
      if (hits.length !== 2) throw new Error(`U2 应为 2 个 section，实际: ${hits.join(",")}`);
      continue;
    }
    if (hits.length !== 1) throw new Error(`位号 ${ref} 重复或缺失: ${hits.join(",")}`);
  }
}

// ─── P1 ─────────────────────────────────────────────
async function placeMcu(client: any, ctx: any) {
  const q = "STM32F103C8T6";
  const page: any = await client.parts.searchParts({
    query: q, requirements: { symbol: true, footprint: true }, pageSize: 20,
  });
  const hit = (page.items ?? []).find((i: any) => i.mpn === q && i.hasSymbol && i.manufacturer?.id);
  if (!hit) throw new Error("未找到 STM32F103C8T6");
  const models: any = await client.parts.getEdaModels({ manufacturerId: hit.manufacturer.id, mpn: hit.mpn });
  const s = STM32_SLOTS.mcu;
  const gpio = at(s, 30, 60);
  const pwr = at(s, 30, 540);
  const res: any = await client.componentPlace.placeKicadSymbol({
    context: ctx,
    localPos: { x: BigInt(gpio.x), y: BigInt(gpio.y) },
    sectionPlacements: [
      { sectionIndex: 0, localPos: { x: BigInt(gpio.x), y: BigInt(gpio.y) } },
      { sectionIndex: 1, localPos: { x: BigInt(pwr.x), y: BigInt(pwr.y) } },
    ],
    component: {
      componentName: `U2_${hit.mpn}`,
      symbolResource: { uri: models.symbol.url },
      footprintResources: models.footprint?.url
        ? [{ uri: models.footprint.url, models: models.model3d?.url ? [{ uri: models.model3d.url }] : [] }]
        : [],
      attributes: [
        { name: "Reference", value: "U2" },
        { name: "Value", value: hit.mpn },
        { name: "Footprint", value: models.footprint?.fileName ?? hit.package ?? "" },
        { name: "MPN", value: hit.mpn },
      ],
    },
  } as any);
  if (!res.success) throw new Error("MCU 放置失败");
  const ids = (res.objectIds ?? [res.objectId]).map((x: any) => BigInt(String(x)));
  for (const id of ids) await setRefValue(client, ctx, id, "U2", hit.mpn);
  return ids;
}

async function runP1(client: any, ctx: any) {
  const S = STM32_SLOTS;
  type Row = [string[], string | undefined, string, string, number, number];
  const rows: Row[] = [
    [["2 pin header 2.54mm"], undefined, "J1", "PWR_IN", ...Object.values(at(S.power, 30, 100)) as [number, number]],
    [["AMS1117-3.3"], "AMS1117-3.3", "U1", "AMS1117-3.3", ...Object.values(at(S.power, 170, 100)) as [number, number]],
    [["100uF capacitor"], "EEE-FK1C101P", "C1", "100uF", ...Object.values(at(S.power, 350, 120)) as [number, number]],
    [["100nF 0402 capacitor"], "GCM155R71C104KA55D", "C2", "100nF", ...Object.values(at(S.power, 50, 220)) as [number, number]],
    [["DS18B20"], "DS18B20", "U3", "DS18B20", ...Object.values(at(S.temp, 50, 120)) as [number, number]],
    [["0402 4.7k resistor"], "MCR01MZPF4701", "R5", "4.7k", ...Object.values(at(S.temp, 270, 120)) as [number, number]],
    [["2 pin header 2.54mm"], undefined, "J2", "BOOT", ...Object.values(at(S.boot, 50, 100)) as [number, number]],
    [["0402 10k resistor"], "MCR01MZPF1002", "R4", "10k", ...Object.values(at(S.boot, 50, 200)) as [number, number]],
    [["ABM3-8.000MHZ-D2Y-T"], "ABM3-8.000MHZ-D2Y-T", "Y1", "8MHz", ...Object.values(at(S.crystal, 90, 60)) as [number, number]],
    [["0402 20pF capacitor"], "GCM1555C1H200FA16D", "C3", "20pF", ...Object.values(at(S.crystal, 50, 140)) as [number, number]],
    [["0402 20pF capacitor"], "GCM1555C1H200FA16D", "C4", "20pF", ...Object.values(at(S.crystal, 150, 140)) as [number, number]],
    [["100nF 0402 capacitor"], "GCM155R71C104KA55D", "C10", "100nF", ...Object.values(at(S.decouple, 30, 60)) as [number, number]],
    [["100nF 0402 capacitor"], "GCM155R71C104KA55D", "C11", "100nF", ...Object.values(at(S.decouple, 110, 60)) as [number, number]],
    [["100nF 0402 capacitor"], "GCM155R71C104KA55D", "C12", "100nF", ...Object.values(at(S.decouple, 190, 60)) as [number, number]],
    [["100nF 0402 capacitor"], "GCM155R71C104KA55D", "C13", "100nF", ...Object.values(at(S.decouple, 110, 160)) as [number, number]],
    [["0402 10k resistor"], "MCR01MZPF1002", "R1", "10k", ...Object.values(at(S.reset, 50, 60)) as [number, number]],
    [["100nF 0402 capacitor"], "GCM155R71C104KA55D", "C9", "100nF", ...Object.values(at(S.reset, 50, 140)) as [number, number]],
    [["TS-1187A tactile switch"], "TS-1187A-C-J-B", "SW1", "RESET", ...Object.values(at(S.reset, 150, 80)) as [number, number]],
  ];

  const ids: bigint[] = [];
  for (const [queries, mpn, ref, val, x, y] of rows) {
    const r = await searchAndPlace(client, ctx, queries, mpn, ref, val, x, y);
    ids.push(r.id);
    console.log(`  ${ref} @ (${x},${y})`);
    await sleep(300);
  }
  ids.push(...await placeMcu(client, ctx));
  await waitForIds(client, ctx, ids, "P1");
  const { map, count } = await occupancyMap(client, ctx);
  console.log(`  occupancy 条目 ${count}`);
  assertUniqueParts(map);
}

// ─── U2 / 引脚 ─────────────────────────────────────────────
async function resolveU2(client: any, ctx: any) {
  const { map } = await occupancyMap(client, ctx);
  let gpio: bigint | undefined, pwr: bigint | undefined;
  for (const [ref, v] of map) {
    if (!ref.startsWith("U2")) continue;
    const names = new Set((await pinsOf(client, ctx, v.id)).map((p) => p.name));
    if (names.has("PD0-OSC_IN")) gpio = v.id;
    if (names.has("VDD_1")) pwr = v.id;
  }
  if (!gpio || !pwr) throw new Error("U2 section 未识别");
  return { map, gpio, pwr };
}

async function pinNum(client: any, ctx: any, id: bigint, ...names: string[]) {
  for (const p of await pinsOf(client, ctx, id)) {
    if (names.includes(p.name)) return p.num;
  }
  throw new Error(`引脚未找到: ${names.join("|")} object=${id}`);
}

async function applyPattern(client: any, ctx: any, label: string, req: any) {
  let r: any = await client.patternLayout.applyCircuitPattern({
    ...req, planOnly: false, ignoreAreaConflict: false,
  } as any);
  if (Number(r.status) === PL.PatternStatus.AREA_OCCUPIED) {
    const bound = new Set((req.roles ?? []).map((x: any) => String(x.objectId)));
    const extra = (r.conflictingObjectIds ?? []).map(String).filter((id) => !bound.has(id));
    if (!extra.length) {
      r = await client.patternLayout.applyCircuitPattern({ ...req, ignoreAreaConflict: true } as any);
    }
  }
  const ok = Number(r.status) === PL.PatternStatus.OK || Number(r.status) === PL.PatternStatus.PARTIAL;
  console.log(`  ${label.padEnd(20)} ${ok ? "✓" : "✗"} st=${r.status} ${(r.message ?? "").slice(0, 50)}`);
  await sleep(450);
  return ok;
}

async function runPatterns(client: any, ctx: any) {
  console.log("\n=== P2/P3 Pattern ===");
  let { map, gpio, pwr } = await resolveU2(client, ctx);
  const u1 = idOf(map, "U1");
  const vin = await pinNum(client, ctx, u1, "VI", "VIN", "VIN/EN");
  const vout = await pinNum(client, ctx, u1, "VO", "VOUT");

  await applyPattern(client, ctx, "LDO in C1", {
    context: ctx, pattern: PID.CIRCUIT_PATTERN_DECOUPLING_CAP, orientation: ORI, routeMode: ROUTE, powerMode: PWR,
    anchor: { x: BigInt(at(STM32_SLOTS.power, 350, 120).x), y: BigInt(at(STM32_SLOTS.power, 350, 120).y) },
    options: { power_net: "+5V", power_symbol: "VCC" },
    roles: [
      { role: "host", objectId: u1, slotIndex: 0, pins: [{ terminal: "vcc", pinNumber: vin }] },
      { role: "cap", objectId: idOf(map, "C1"), slotIndex: 0 },
    ],
  });

  ({ map } = await resolveU2(client, ctx));
  await applyPattern(client, ctx, "LDO out C2", {
    context: ctx, pattern: PID.CIRCUIT_PATTERN_DECOUPLING_CAP, orientation: ORI, routeMode: ROUTE, powerMode: PWR,
    anchor: { x: BigInt(at(STM32_SLOTS.power, 50, 220).x), y: BigInt(at(STM32_SLOTS.power, 50, 220).y) },
    options: { power_net: "+3V3", power_symbol: "VCC" },
    roles: [
      { role: "host", objectId: u1, slotIndex: 0, pins: [{ terminal: "vcc", pinNumber: vout }] },
      { role: "cap", objectId: idOf(map, "C2"), slotIndex: 0 },
    ],
  });

  ({ map, gpio, pwr } = await resolveU2(client, ctx));
  await applyPattern(client, ctx, "MCU decouple", {
    context: ctx, pattern: PID.CIRCUIT_PATTERN_DECOUPLING_CAP, orientation: ORI, routeMode: ROUTE, powerMode: PWR,
    anchor: { x: BigInt(at(STM32_SLOTS.decouple, 30, 60).x), y: BigInt(at(STM32_SLOTS.decouple, 30, 60).y) },
    options: { power_net: "+3V3", power_symbol: "VCC" },
    roles: [
      { role: "host", objectId: pwr, slotIndex: 0, pins: [{ terminal: "vcc", pinName: "VDD_1" }] },
      { role: "cap", objectId: idOf(map, "C10"), slotIndex: 0 },
      { role: "cap", objectId: idOf(map, "C11"), slotIndex: 1 },
      { role: "cap", objectId: idOf(map, "C12"), slotIndex: 2 },
      { role: "cap", objectId: idOf(map, "C13"), slotIndex: 3 },
    ],
  });

  ({ map, gpio } = await resolveU2(client, ctx));
  const yA = at(STM32_SLOTS.crystal, 90, 60);
  await applyPattern(client, ctx, "HSE crystal", {
    context: ctx, pattern: PID.CIRCUIT_PATTERN_CRYSTAL, orientation: ORI, routeMode: ROUTE, powerMode: PWR,
    anchor: { x: BigInt(yA.x), y: BigInt(yA.y) },
    options: { layout_origin: "anchor", osc_in_net: "HSE_IN", osc_out_net: "HSE_OUT" },
    roles: [
      { role: "host", objectId: gpio, slotIndex: 0, pins: [{ terminal: "xin", pinName: "PD0-OSC_IN" }, { terminal: "xout", pinName: "PD1-OSC_OUT" }] },
      { role: "xtal", objectId: idOf(map, "Y1"), slotIndex: 0 },
      { role: "cap_load_1", objectId: idOf(map, "C3"), slotIndex: 0 },
      { role: "cap_load_2", objectId: idOf(map, "C4"), slotIndex: 0 },
    ],
  });

  ({ map, gpio } = await resolveU2(client, ctx));
  const rA = at(STM32_SLOTS.reset, 50, 60);
  await applyPattern(client, ctx, "NRST", {
    context: ctx, pattern: PID.CIRCUIT_PATTERN_RESET_CIRCUIT, orientation: ORI, routeMode: ROUTE, powerMode: PWR,
    anchor: { x: BigInt(rA.x), y: BigInt(rA.y) },
    options: { layout_origin: "anchor", reset_net: "NRST" },
    roles: [
      { role: "host", objectId: gpio, slotIndex: 0, pins: [{ terminal: "rst", pinName: "NRST" }] },
      { role: "pull_up", objectId: idOf(map, "R1"), slotIndex: 0 },
      { role: "filter_cap", objectId: idOf(map, "C9"), slotIndex: 0 },
      { role: "reset_sw", objectId: idOf(map, "SW1"), slotIndex: 0 },
    ],
  });

  ({ map } = await resolveU2(client, ctx));
  await applyPattern(client, ctx, "R5 pull-up", {
    context: ctx, pattern: PID.CIRCUIT_PATTERN_PULL_RESISTOR, orientation: ORI, routeMode: ROUTE, powerMode: PWR,
    anchor: { x: BigInt(at(STM32_SLOTS.temp, 270, 120).x), y: BigInt(at(STM32_SLOTS.temp, 270, 120).y) },
    options: { polarity: "up" },
    roles: [
      { role: "signal_host", objectId: idOf(map, "U3"), slotIndex: 0, pins: [{ terminal: "sig", pinName: "DQ" }] },
      { role: "resistor", objectId: idOf(map, "R5"), slotIndex: 0 },
    ],
  });
}

// ─── P3b / P4a ─────────────────────────────────────────────
async function placeGnd(client: any, ctx: any, x: number, y: number) {
  const libs: any = await client.componentPlace.listSymbolLibraries({ context: ctx } as any);
  for (const lib of libs.libraries ?? []) {
    const sym = (lib.symbols ?? []).find((s: any) => s.symbolName === "GND");
    if (!sym) continue;
    const r: any = await client.componentPlace.placeSymbolFromLibrary({
      context: ctx, localPos: { x: BigInt(x), y: BigInt(y) },
      libraryName: lib.libraryName, symbolName: sym.symbolName,
      libraryFilePath: lib.libraryFilePath, kind: sym.kind, netName: "GND",
    } as any);
    if (r.success && r.objectId) return BigInt(String(r.objectId));
  }
  throw new Error("GND 符号失败");
}

async function placeVcc(client: any, ctx: any, net: string, x: number, y: number) {
  const libs: any = await client.componentPlace.listSymbolLibraries({ context: ctx } as any);
  for (const lib of libs.libraries ?? []) {
    const sym = (lib.symbols ?? []).find((s: any) => s.symbolName === "VCC");
    if (!sym) continue;
    const r: any = await client.componentPlace.placeSymbolFromLibrary({
      context: ctx, localPos: { x: BigInt(x), y: BigInt(y) },
      libraryName: lib.libraryName, symbolName: sym.symbolName,
      libraryFilePath: lib.libraryFilePath, kind: sym.kind, netName: net,
    } as any);
    if (r.success && r.objectId) return BigInt(String(r.objectId));
  }
  throw new Error(`VCC 符号 ${net} 失败`);
}

async function stub(client: any, ctx: any, oid: bigint, pin: number | string, net: string) {
  const n = typeof pin === "number" ? { pinNum: pin } : { pinName: pin };
  await client.objPlace.placePinStubWireAndNetAlias({
    context: ctx, objectId: oid, ...n, netName: net,
    snapToGrid: true, initialStubLength: 30n, stubExtendStep: 10n, maxStubLength: 260n,
  } as any);
  await sleep(150);
}

async function connect(client: any, ctx: any, o1: bigint, p1: number | string, o2: bigint, p2: number | string) {
  const a = typeof p1 === "number" ? { pinNum1: [p1] } : { pinName1: [p1] };
  const b = typeof p2 === "number" ? { pinNum2: [p2] } : { pinName2: [p2] };
  const r: any = await client.canvasOps.autoConnectObjectsById({
    context: ctx, objectId1: o1, ...a, objectId2: o2, ...b,
  } as any);
  return r.value === true || r.success === true;
}

async function runP3b(client: any, ctx: any) {
  console.log("\n=== P3b 补线 ===");
  const { map, gpio } = await resolveU2(client, ctx);
  const p5 = await placeVcc(client, ctx, "+5V", at(STM32_SLOTS.power, 30, 80).x, at(STM32_SLOTS.power, 30, 80).y);
  const g1 = await placeGnd(client, ctx, at(STM32_SLOTS.power, 30, 300).x, at(STM32_SLOTS.power, 30, 320).y);
  console.log("  J1 power:", await connect(client, ctx, idOf(map, "J1"), 1, p5, 0), await connect(client, ctx, idOf(map, "J1"), 2, g1, 0));

  const g2 = await placeGnd(client, ctx, at(STM32_SLOTS.boot, 50, 320).x, at(STM32_SLOTS.boot, 50, 340).y);
  await connect(client, ctx, idOf(map, "J2"), 2, g2, 0);
  await connect(client, ctx, idOf(map, "R4"), 2, g2, 0);

  await stub(client, ctx, idOf(map, "J2"), 1, "BOOT0");
  await stub(client, ctx, idOf(map, "R4"), 1, "BOOT0");
  await stub(client, ctx, gpio, "BOOT0", "BOOT0");
  await stub(client, ctx, idOf(map, "U3"), "DQ", "TEMP_DQ");
  await stub(client, ctx, idOf(map, "R5"), 1, "TEMP_DQ");
}

async function runP4a(client: any, ctx: any) {
  console.log("\n=== P4a 模块框 ===");
  const rects: string[] = [];
  for (const m of STM32_MODULES) {
    const f = frameOf(m.box);
    const rr: any = await client.objPlace.placeRect({
      context: ctx,
      box: { min: { x: BigInt(f.x1), y: BigInt(f.y1) }, max: { x: BigInt(f.x2), y: BigInt(f.y2) } },
      snapToGrid: true,
    } as any);
    await client.objPlace.placeText({
      context: ctx,
      localPos: { x: BigInt(f.x1 + 20), y: BigInt(f.y1 - TITLE_DY) },
      text: m.title, fontSize: 11,
    } as any);
    rects.push(String(rr.objectId));
    console.log(`  ${m.title} [${f.x1},${f.y1}]-[${f.x2},${f.y2}]`);
  }
  console.log("  FRAME_RECTS=" + rects.join(","));
}

async function main() {
  const { client, ctx } = await openCtx();
  console.log("=== 清页 ===");
  await clearPage(client, ctx);
  console.log("=== P0 定页 ===");
  await setPage(client, ctx);
  console.log("=== P1 放置（每器件一次）===");
  await runP1(client, ctx);
  await runPatterns(client, ctx);
  await runP3b(client, ctx);
  await runP4a(client, ctx);

  const nets = await activePageNets(client, ctx);
  const named = nets.filter((n) => !/^N\d+$/.test(String(n.name)));
  const orphan = nets.filter((n) => /^N\d+$/.test(String(n.name)));
  console.log(`\n=== 网络：命名 ${named.length}，自动 ${orphan.length} ===`);
  for (const n of named) console.log(`  ${String(n.name).padEnd(10)} ${(n.pinReferences ?? []).length}`);

  await client.canvasOps.zoomAll({ context: ctx } as any).catch(() => {});
  await client.project.saveProject({ context: ctx } as any).catch(() => {});
  client.close();
  console.log("\n✅ stm32-min-system 完成");
}

main().catch((e) => { console.error("❌", e); process.exit(1); });

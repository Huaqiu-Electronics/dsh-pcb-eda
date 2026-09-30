/**
 * Flow C 配方：删旧放新（骨架 — 需补 part-search 与 pin 重连列表）
 * OLD_REF=U3 CONFIRM=1 npx tsx scripts/replace-part-by-ref.ts
 *
 * 完整替换需：searchParts → placeKicadSymbol → 按 OLD 的 pin→net 逐脚 autoConnect
 */
import { hqMainWithProject, sleep } from "./lib/hq.js";

const OLD_REF = process.env.OLD_REF;
const CONFIRM = process.env.CONFIRM === "1";

hqMainWithProject(async ({ client, projectId, projectContext: ctx }) => {
  if (!OLD_REF) throw new Error("需要 OLD_REF=");
  console.log("projectId:", projectId);

  const snap = await client.kernel.getSnapshot({ context: ctx });
  const sym = snap.snapshot?.symbolInstances?.find((x: any) => x.designator === OLD_REF) as any;
  if (!sym) throw new Error(`快照无 ${OLD_REF}`);

  console.log(`\n计划: 删除 ${OLD_REF} @ ${JSON.stringify(sym.position)} rotation=${sym.rotation}`);
  console.log("  ⚠ 替换需指定 NEW_MPN + placeKicadSymbol + 重连 — 本脚本仅演示定位与删除前检查");
  if (!CONFIRM) { console.log("未执行。设 CONFIRM=1 且补全新器件放置逻辑。"); return; }

  const found = await client.canvasOps.findObjectByProperty({ context: ctx, propKey: "Reference", propValue: OLD_REF });
  const id = found.objectIds?.[0];
  if (!id) throw new Error("FindObject 失败");
  await client.canvasOps.deleteObjectsByIds({ context: ctx, objectIds: [id] });
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const occ = await client.patternLayout.getPageOccupancy({ context: ctx });
    const ids = (occ.items ?? []).map((it) => String(it.objectId));
    if (!ids.includes(String(id))) break;
  }
  console.log(`✓ 已删除 ${OLD_REF} — 请 placeKicadSymbol 并 autoConnect 各 pin`);
});

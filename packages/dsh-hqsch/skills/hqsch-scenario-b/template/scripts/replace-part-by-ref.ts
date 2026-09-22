/**
 * Flow C 配方：删旧放新（骨架 — 需补 part-search 与 pin 重连列表）
 * OLD_REF=U3 CONFIRM=1 npx tsx scripts/replace-part-by-ref.ts
 *
 * 完整替换需：searchParts → placeKicadSymbol → 按 OLD 的 pin→net 逐脚 autoConnect
 */
import { connect } from "@huaqiu/huaqiu-client";

const OLD_REF = process.env.OLD_REF;
const CONFIRM = process.env.CONFIRM === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!OLD_REF) throw new Error("需要 OLD_REF=");
  const client = await connect({ instanceId: process.env.HQ_INSTANCE_ID });
  const active = await client.project.getActiveProject({ context: client.createEditorContext() });
  const projectId = active.project?.projectId;
  if (!projectId) throw new Error("请先打开工程");
  const ctx = client.createProjectContext(projectId);
  console.log("projectId:", projectId);

  const snap = await client.kernel.getSnapshot({ context: ctx });
  const s = snap.snapshot as Record<string, unknown[]>;
  const sym = (s.symbolInstances as Array<Record<string, unknown>>)?.find((x) => x.designator === OLD_REF);
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
    const occ = await client.canvasOps.getPageOccupancy({ context: ctx });
    const ids = (occ.objectIds ?? []).map(String);
    if (!ids.includes(String(id))) break;
  }
  console.log(`✓ 已删除 ${OLD_REF} — 请 placeKicadSymbol 并 autoConnect 各 pin`);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
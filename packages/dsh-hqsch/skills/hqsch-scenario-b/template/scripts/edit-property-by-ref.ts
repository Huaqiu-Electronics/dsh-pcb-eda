/**
 * Flow C 配方：按位号改属性
 * REF=C201 PROP=Value NEW="1 µF" CONFIRM=1 npx tsx scripts/edit-property-by-ref.ts
 */
import { hqMainWithProject } from "./lib/hq.js";

const REF = process.env.REF;
const PROP = process.env.PROP ?? "Value";
const NEW = process.env.NEW;
const CONFIRM = process.env.CONFIRM === "1";

hqMainWithProject(async ({ client, projectId, projectContext: ctx }) => {
  if (!REF || NEW === undefined) throw new Error("需要 REF= 与 NEW=");
  console.log("projectId:", projectId);

  const found = await client.canvasOps.findObjectByProperty({ context: ctx, propKey: "Reference", propValue: REF });
  const id = found.objectIds?.[0];
  if (!id) throw new Error(`找不到 ${REF}`);

  let oldVal = "";
  try {
    const g = await client.canvasOps.getObjectProperty({ context: ctx, objectId: id, propKey: PROP });
    oldVal = String(g.propValue ?? "");
  } catch { oldVal = "(未知)"; }

  console.log(`\n计划修改: ${REF} ${PROP}: "${oldVal}" → "${NEW}"  objectId=${id}`);
  if (!CONFIRM) { console.log("未执行。设 CONFIRM=1 后重跑。"); return; }

  await client.canvasOps.setObjectProperty({ context: ctx, objectId: id, propKey: PROP, propValue: NEW, op: 1, commitUndo: true });
  console.log("✓ 已写入");

  const snap = await client.kernel.getSnapshot({ context: ctx });
  const sym = (snap.snapshot as { symbolInstances?: Array<{ designator?: string; metadata?: { properties?: Array<{ key: string; value: unknown }> } }> })
    .symbolInstances?.find((s) => s.designator === REF);
  const v = sym?.metadata?.properties?.find((p) => p.key === PROP);
  console.log("快照验收:", PROP, "=", v ? String(Object.values(v.value as object)[0] ?? v.value) : NEW);
});

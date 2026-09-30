/**
 * Flow C 配方：把 REF 的某 pin 接到 TARGET_REF 的 TARGET_PIN（autoConnect）
 * REF=R201 PIN=1 TARGET_REF=U301 TARGET_PIN=14 CONFIRM=1 npx tsx scripts/rewire-pin-by-ref.ts
 */
import { hqMainWithProject } from "./lib/hq.js";

const REF = process.env.REF;
const PIN = process.env.PIN;
const TARGET_REF = process.env.TARGET_REF;
const TARGET_PIN = process.env.TARGET_PIN ?? "1";
const CONFIRM = process.env.CONFIRM === "1";

hqMainWithProject(async ({ client, projectId, projectContext: ctx }) => {
  if (!REF || !PIN || !TARGET_REF) throw new Error("需要 REF= PIN= TARGET_REF=");
  console.log("projectId:", projectId);

  const a = await client.canvasOps.findObjectByProperty({ context: ctx, propKey: "Reference", propValue: REF });
  const b = await client.canvasOps.findObjectByProperty({ context: ctx, propKey: "Reference", propValue: TARGET_REF });
  const id1 = a.objectIds?.[0];
  const id2 = b.objectIds?.[0];
  if (!id1 || !id2) throw new Error("找不到 objectId");

  console.log(`\n计划: ${REF}.pin${PIN} autoConnect → ${TARGET_REF}.pin${TARGET_PIN}`);
  console.log(`  id1=${id1}  id2=${id2}`);
  if (!CONFIRM) { console.log("未执行。设 CONFIRM=1"); return; }

  await client.canvasOps.autoConnectObjectsById({
    context: ctx,
    objectId1: id1,
    pinNum1: [Number(PIN)],
    objectId2: id2,
    pinNum2: [Number(TARGET_PIN)],
  });
  console.log("✓ autoConnect 完成 — 请 GetSnapshot 验收 pin→net");
});

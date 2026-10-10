/**
 * 修正位号与参数值：
 *   C1 → C_IN (10 μF), C2 → C_IN_BYPASS (0.1 μF)
 *   C3 → C_OUT1 (10 μF), C4 → C_OUT2 (0.1 μF)
 */
import { hqMainWithProject } from "./lib/hq.js";

const RENAMES: Array<[string, string, string]> = [
  // [oldRef, newRef, value]
  ["C1", "C_IN", "10 μF"],
  ["C2", "C_IN_BYPASS", "0.1 μF"],
  ["C3", "C_OUT1", "10 μF"],
  ["C4", "C_OUT2", "0.1 μF"],
];

hqMainWithProject(async ({ client, projectContext: ctx }) => {

  for (const [oldRef, newRef, value] of RENAMES) {
    const found = await client.canvasOps.findObjectByProperty({
      context: ctx, propKey: "Reference", propValue: oldRef,
    });
    const id = found.objectIds?.[0];
    if (!id) { console.log(`  ⚠ 找不到 ${oldRef}`); continue; }

    await client.canvasOps.setObjectProperty({
      context: ctx, objectId: id,
      propKey: "Part Reference", propValue: newRef, op: 1, commitUndo: true,
    });
    await client.canvasOps.setObjectProperty({
      context: ctx, objectId: id,
      propKey: "Value", propValue: value, op: 1, commitUndo: true,
    });
    console.log(`  ✓ ${oldRef} → ${newRef} (${value}) id=${id}`);
  }

  // 验证
  console.log("\n验证:");
  for (const [, newRef] of RENAMES) {
    const r = await client.canvasOps.findObjectByProperty({
      context: ctx, propKey: "Reference", propValue: newRef,
    });
    console.log(`  ${newRef}: ${(r.objectIds?.length ?? 0) > 0 ? "✓" : "✗"}`);
  }
  await client.canvasOps.zoomAll({ context: ctx });
});

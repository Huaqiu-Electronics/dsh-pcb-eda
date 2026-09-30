/**
 * Scenario B smoke test — verify HQ EDA connectivity before circuit automation.
 *
 *   npm install
 *   npx tsx scripts/hello.ts
 *
 * Optional: HQ_INSTANCE_ID=<id> when multiple editors are open (run listEditors first).
 *
 * ⚠ 必须走 `hqMain`（`scripts/lib/hq.ts`）：per-RPC 截止时间透传 `connect({ timeoutMs })`
 *   + `finally { client.close() }`，进程一定会退出。裸 `connect()` 会泄漏 node 进程。
 */
import { listEditors, toJsonString } from "@huaqiu/huaqiu-client";
import { hqMain } from "./lib/hq.js";

hqMain(async (client) => {
  const editors = await listEditors();
  console.log("editors:", toJsonString(editors, { prettySpaces: 2 }));

  console.log("connected:", client.info.instanceId);

  const editorCtx = client.createEditorContext();
  const active = await client.project.getActiveProject({ context: editorCtx });
  const projectId = active.project?.projectId;
  if (!projectId) {
    throw new Error("No active project — open a schematic in HQ EDA first");
  }
  console.log("active project:", active.project?.name, projectId);

  const ctx = client.createProjectContext(projectId);
  const snap = await client.kernel.getSnapshot({ context: ctx });
  const parts = snap.snapshot?.symbolInstances?.length ?? 0;
  const wires = snap.snapshot?.wireSegments?.length ?? 0;
  console.log(`snapshot: ${parts} symbols, ${wires} wire segments on active page`);

  await client.canvasOps.zoomAll({ context: ctx });
  console.log("zoomAll: OK");

  console.log("OK — ready for LLM-generated placement scripts");
});

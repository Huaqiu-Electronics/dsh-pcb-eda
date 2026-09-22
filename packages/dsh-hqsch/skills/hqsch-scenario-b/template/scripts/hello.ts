/**
 * Scenario B smoke test — verify HQ EDA connectivity before circuit automation.
 *
 *   npm install
 *   npx tsx scripts/hello.ts
 *
 * Optional: HQ_INSTANCE_ID=<id> when multiple editors are open (run listEditors first).
 */
import { connect, listEditors, toJsonString } from "@huaqiu/huaqiu-client";

const INSTANCE = process.env.HQ_INSTANCE_ID;

async function main() {
  const editors = await listEditors();
  console.log("editors:", toJsonString(editors, { prettySpaces: 2 }));

  const client = INSTANCE
    ? await connect({ instanceId: INSTANCE })
    : await connect();

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
  const parts = snap.symbolInstances?.length ?? 0;
  const wires = snap.wireSegments?.length ?? 0;
  console.log(`snapshot: ${parts} symbols, ${wires} wire segments on active page`);

  await client.canvasOps.zoomAll({ context: ctx });
  console.log("zoomAll: OK");

  console.log("OK — ready for LLM-generated placement scripts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

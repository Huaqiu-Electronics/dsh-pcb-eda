/**
 * 手动探测 Connect 客户端是否暴露 scenario-b 依赖的 RPC（非 CI 门禁）。
 * 用法：cd template && npx tsx scripts/probe-rpc.ts
 */
import { hqMain } from "./lib/hq.js";

hqMain(async (client: any) => {
  const withClient = [
    { label: "netList.getActivePageNetList", fn: client?.netList?.getActivePageNetList },
    { label: "canvasOps.listWireSegments", fn: client?.canvasOps?.listWireSegments },
    { label: "objPlace.placePinStubWireAndNetAlias", fn: client?.objPlace?.placePinStubWireAndNetAlias },
    { label: "componentPlace.placeKicadSymbol", fn: client?.componentPlace?.placeKicadSymbol },
    { label: "canvasOps.setPageSize", fn: client?.canvasOps?.setPageSize },
    { label: "objPlace.placeText", fn: client?.objPlace?.placeText },
    // E — planned; see docs/decoration-objects.md
    { label: "canvasOps.listPageDecorations", fn: client?.canvasOps?.listPageDecorations },
    { label: "export.exportSchematicPdf", fn: client?.export?.exportSchematicPdf },
  ];
  let fail = 0;
  for (const { label, fn } of withClient) {
    const pass = typeof fn === "function";
    console.log(pass ? `OK  ${label}` : `MISS ${label}`);
    if (!pass) fail++;
  }
  process.exitCode = fail > 0 ? 1 : 0;
});

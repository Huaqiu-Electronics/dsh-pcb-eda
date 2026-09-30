/**
 * 保存工程并导出当前活动原理图页 PDF（矢量），stdout 打印绝对路径。
 *
 * 用法：cd template && npx tsx scripts/export-layout-pdf.ts
 * 可选：OUTPUT_PATH=./review/layout.pdf  COLOR_MODE=1 (BW=1, GRAY=2, COLOUR=3)
 */
import { hqMainWithProject } from "./lib/hq.js";

/** SchematicPdfColorMode（不 import 枚举：老版客户端包里还没有这个 proto） */
const COLOR_BW = 1;

hqMainWithProject(async ({ client, projectContext: ctx }) => {
  const exportSvc: any = client.export;
  if (typeof exportSvc.exportSchematicPdf !== "function") {
    throw new Error(
      "当前 @huaqiu/huaqiu-client 不含 ExportSchematicPdf，请升级客户端包后重试"
      + "（P4b 可先跳过 PDF，仅用 layout-audit.ts 做数值验收）",
    );
  }

  await client.project.saveProject({ context: ctx } as never);

  const colorMode = process.env.COLOR_MODE != null ? Number(process.env.COLOR_MODE) : COLOR_BW;

  const resp: any = await exportSvc.exportSchematicPdf({
    context: ctx,
    outputPath: process.env.OUTPUT_PATH ?? "",
    colorMode,
    resolutionDpi: 0,
  } as never);

  if (!resp.success) {
    throw new Error(resp.message ?? "exportSchematicPdf failed");
  }

  const filePath = String(resp.filePath ?? "");
  if (!filePath) throw new Error("empty filePath in response");
  console.log(filePath);
});

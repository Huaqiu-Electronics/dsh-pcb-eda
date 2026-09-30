# 布局目视验收（P4b · PDF 整页）

在模块化放置（P4a 框 + 中文标题）之后，用 **与 UI 打印同源的矢量 PDF** 做整页效果检查，弥补 `layout-audit.ts` 无法回答的「像不像成品图」问题。

## 适用问题

| 关注点 | 数值 audit | PDF 目视 |
| --- | --- | --- |
| 模块摆放是否合理 | 模块间距散度、框 mod20 | 各分区是否成团、走线是否挤在框内 |
| 空白是否太多 | 最大空白矩形、填充率 | 页心/页角是否大片无内容 |
| 页尺寸（P0）是否合理 | 页边距均衡 | 边框相对内容是否留白过大、是否需 P4c |

## 推荐顺序（与 `modular-layout.md` P4b 一致）

1. `npx tsx scripts/layout-audit.ts`（可选 `FRAME_RECTS=`）。
2. `project.saveProject` — PDF 读 **持久化** `VxPage`，不是未保存画布。
3. `export.exportSchematicPdf` 或 `npx tsx scripts/export-layout-pdf.ts` → stdout **`filePath`**（绝对路径）。
4. 将 PDF 交给支持 PDF/vision 的模型，或把路径给用户本地打开；结合 audit 数字给出 **改 P1 槽位 / P0 页 / P4a 框** 的建议。
5. `canvasOps.zoomAll` 便于用户在编辑器对照。

## 限制（v1）

- **客户端包需含 `ExportSchematicPdf`**（`@huaqiu/huaqiu-client` 0.1.9 尚未包含）。`export-layout-pdf.ts` 会先探测，不可用时报「请升级客户端包」并退出 —— 此时 P4b **不要卡住**：用 `layout-audit.ts` 的数值验收 + 告知用户 PDF 需升级包，见 `rpc-availability.md` § Client / build alignment。
- 仅 **当前活动原理图页**。
- 必须先 save；与 Ctrl+P 打印同一页在 save 后视觉一致。
- 单次约 1–3 s（GUI 线程），勿并发多次导出。

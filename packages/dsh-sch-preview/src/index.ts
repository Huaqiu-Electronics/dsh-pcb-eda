/**
 * @huaqiu/dsh-sch-preview — DSH plugin: headless KiCad schematic preview.
 *
 * Registers the model-facing `sch_preview` tool: renders .kicad_sch design
 * files in a short-lived headless browser (Playwright + vendored kicanview
 * bundle), captures a PNG screenshot of the drawing surface, and returns the
 * image as an attachment block plus structured content (sheet list, captured
 * sheet, BOM summary) into the agent context. The PNG is also persisted to
 * disk (savedTo) so it can be referenced or re-read later.
 *
 * Node half only (no browser bundle): the tool result itself carries the
 * screenshot, so no client card is needed in v1.
 * @module @huaqiu/dsh-sch-preview
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { renderSchematic, type BomItemView, type RenderFile, type SheetInfo } from "./render/renderer.js";

export const name = "@huaqiu/dsh-sch-preview";
export const inject = ["tools"];

/** Deployment configuration for the schematic preview tool. */
export interface Config {
    /** kicadpreview vendor directory (dist/ + design_blocks/). Default: in-package vendor dir (see defaultVendorDir). */
    vendorDir?: string;
    /** Playwright browser channel override, e.g. "chrome" or "msedge". */
    browserChannel?: "chromium" | "chrome" | "msedge";
    /** Explicit browser executable path (overrides browserChannel). */
    executablePath?: string;
    /** Per-operation timeout budget in ms (default 90000). */
    timeoutMs?: number;
    /** Default viewport width in CSS px (default 1600). */
    defaultWidth?: number;
    /** Default viewport height in CSS px (default 1000). */
    defaultHeight?: number;
    /**
     * Attach the screenshot as an image block in the tool result. Set false on
     * deployments whose model cannot consume image input (the PNG is still
     * persisted to disk and referenced by savedTo). Default: true.
     */
    attachImage?: boolean;
}

// schemastery schemas are optional by default; `.required()` marks a field mandatory.
export const Config = z.object({
    vendorDir: z.string(),
    browserChannel: z.string(),
    executablePath: z.string(),
    timeoutMs: z.number().min(1),
    defaultWidth: z.number().min(1),
    defaultHeight: z.number().min(1),
    attachImage: z.boolean(),
});

const KICAD_EXTS = [".kicad_sch", ".kicad_pro", ".kicad_wks"];
/** Hard cap on total design content per render call (keeps page.evaluate payloads sane). */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** The canonical outcome declared by the `sch_preview` output schema. */
export interface SchPreviewValue {
    /** Present only when a durable attachment store is mounted and accepts PNG. */
    image?: {
        attachmentId: string;
        mediaType: "image/png";
        bytes: number;
        width: number;
        height: number;
        name: string;
    };
    /** Persisted screenshot path (always set on success). */
    savedTo: string;
    sheets: SheetInfo[];
    /** Omitted when no sheet could be captured. */
    capturedSheet?: string;
    bom: { count: number; totalQty: number; items: BomItemView[]; error?: string };
}

/** Resolve the working directory for relative paths: session header cwd, else process cwd. */
function resolveCwd(exec: ToolExecution): string {
    const cwd = exec.agent?.session.header.cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

/** Collect design files from one path argument (single file or directory walk). */
function collectFiles(arg: string, cwd: string): RenderFile[] {
    const abs = isAbsolute(arg) ? arg : resolve(cwd, arg);
    const st = statSync(abs);
    if (st.isFile()) {
        return [{ name: basename(abs), content: readFileSync(abs, "utf8") }];
    }
    const out: RenderFile[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith(".")) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (KICAD_EXTS.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
                out.push({ name: basename(full), content: readFileSync(full, "utf8") });
            }
        }
    };
    walk(abs);
    return out;
}

/** Format the model-facing text envelope beside the optional image block. */
function formatOutput(value: SchPreviewValue): string {
    const sheetLines = value.sheets.map((s) => `  ${s.filename}${s.name && s.name !== s.filename ? ` (${s.name})` : ""}`).join("\n");
    const bomError = value.bom.error ? ` BOM extraction failed: ${value.bom.error}.` : "";
    return `<sch_preview>
<sheet>${value.capturedSheet ?? "(none)"}</sheet>
<sheets>
${sheetLines || "  (none)"}
</sheets>
<bom>${value.bom.count} kinds, ${value.bom.totalQty} total.${bomError}</bom>
<image_file>${value.savedTo} (${value.image ? `${value.image.bytes} bytes` : "not attached"})</image_file>
</sch_preview>`;
}

/** Project the canonical outcome into content blocks (text envelope + image when attached). */
function previewContent(value: SchPreviewValue): ContentBlock[] {
    const blocks: ContentBlock[] = [{ type: "text", text: formatOutput(value) }];
    if (value.image) {
        blocks.push({
            type: "image",
            attachment: { ...value.image, attachmentId: AttachmentId(value.image.attachmentId) },
        });
    }
    return blocks;
}

export function apply(ctx: Context, config: Config): void {
    ctx.tools.register(
        defineTool({
            name: "sch_preview",
            description:
                "Render KiCad schematic design files (.kicad_sch) headlessly and return a PNG screenshot plus structured content. " +
                "Use when the user asks to preview, draw, or visually inspect a .kicad_sch file, or when you need an image of a schematic. " +
                "file_path may be one design file (or a directory containing them); relative paths resolve against the session working directory. " +
                "The screenshot is attached as an image block when the deployment supports images and also saved to disk (savedTo).",
            parameters: {
                file_path: {
                    type: "string",
                    required: true,
                    description: "Path to a .kicad_sch/.kicad_pro file, or a directory containing KiCad design files.",
                },
                sheet: {
                    type: "string",
                    description: "Filename of the sheet to capture instead of the first page (see returned sheets list).",
                },
                width: { type: "integer", description: "Viewport width in CSS px." },
                height: { type: "integer", description: "Viewport height in CSS px." },
                save_dir: {
                    type: "string",
                    description: "Directory to persist the PNG into (default: <cwd>/.sch-preview-out).",
                },
            },
            output: {
                schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        image: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                attachmentId: { type: "string", required: true },
                                mediaType: { type: "string", enum: ["image/png"], required: true },
                                bytes: { type: "integer", required: true },
                                width: { type: "integer", required: true },
                                height: { type: "integer", required: true },
                                name: { type: "string", required: true },
                            },
                        },
                        savedTo: { type: "string", required: true },
                        sheets: {
                            type: "array",
                            required: true,
                            items: {
                                type: "object",
                                additionalProperties: false,
                                properties: {
                                    filename: { type: "string", required: true },
                                    name: { type: "string" },
                                    path: { type: "string" },
                                },
                            },
                        },
                        capturedSheet: { type: "string" },
                        bom: {
                            type: "object",
                            additionalProperties: false,
                            required: true,
                            properties: {
                                count: { type: "integer", required: true },
                                totalQty: { type: "integer", required: true },
                                items: {
                                    type: "array",
                                    required: true,
                                    items: {
                                        type: "object",
                                        additionalProperties: false,
                                        properties: {
                                            Reference: { type: "string", required: true },
                                            Name: { type: "string", required: true },
                                            Footprint: { type: "string", required: true },
                                            Description: { type: "string", required: true },
                                            Qty: { type: "integer", required: true },
                                            DNP: { type: "boolean", required: true },
                                        },
                                    },
                                },
                                error: { type: "string" },
                            },
                        },
                    },
                },
                render: (_args, value) => previewContent(value as SchPreviewValue),
            },
            async execute(args, exec) {
                const cwd = resolveCwd(exec);
                const files = collectFiles(args.file_path, cwd);
                if (files.length === 0) {
                    throw new Error(`no KiCad design files found at "${args.file_path}"`);
                }
                const totalBytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.content, "utf8"), 0);
                if (totalBytes > MAX_TOTAL_BYTES) {
                    throw new Error(`design content too large (${totalBytes} bytes > ${MAX_TOTAL_BYTES} cap)`);
                }
                if (exec.signal?.aborted) throw new Error("cancelled before render");

                const result = await renderSchematic({
                    files,
                    sheet: args.sheet,
                    width: args.width ?? config.defaultWidth,
                    height: args.height ?? config.defaultHeight,
                    vendorDir: config.vendorDir,
                    browserChannel: config.browserChannel,
                    executablePath: config.executablePath,
                    timeoutMs: config.timeoutMs,
                });

                const outDir = resolve(cwd, args.save_dir ?? ".sch-preview-out");
                mkdirSync(outDir, { recursive: true });
                const baseName = basename(files[0]!.name).replace(/\.kicad_sch$/, "");
                const sheetTag = result.capturedSheet
                    ? `_${basename(result.capturedSheet).replace(/\.kicad_sch$/, "")}`
                    : "";
                const savedTo = join(outDir, `${baseName}${sheetTag}.png`);
                writeFileSync(savedTo, result.png);

                // Attach the screenshot durably when enabled and a store is mounted
                // (graceful text-only fallback otherwise — e.g. text-only models).
                let image: SchPreviewValue["image"];
                const attachments = ctx.get("attachments");
                if (config.attachImage !== false && attachments !== undefined && attachments.imageLimits.mediaTypes.includes("image/png")) {
                    try {
                        const ref = await attachments.saveImage({
                            data: new Uint8Array(result.png),
                            mediaType: "image/png",
                            name: basename(savedTo),
                        });
                        image = {
                            attachmentId: ref.attachmentId,
                            mediaType: "image/png",
                            bytes: ref.bytes,
                            width: ref.width,
                            height: ref.height,
                            name: ref.name ?? basename(savedTo),
                        };
                    } catch (error) {
                        console.error("sch_preview: attachment save failed:", error);
                    }
                }

                return {
                    ...image === undefined ? {} : { image },
                    savedTo,
                    sheets: result.sheets.map((s) => ({
                        filename: s.filename,
                        ...s.name === null ? {} : { name: s.name },
                        ...s.path === null ? {} : { path: s.path },
                    })),
                    ...result.capturedSheet === null ? {} : { capturedSheet: result.capturedSheet },
                    bom: result.bom,
                };
            },
            presentCall(args) {
                return {
                    card: "generic",
                    title: `Preview schematic ${args.file_path}`,
                    kind: "other" as const,
                    locations: [{ path: args.file_path }],
                };
            },
        }),
    );
}

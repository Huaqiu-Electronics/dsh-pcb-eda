/**
 * Headless KiCad schematic renderer.
 *
 * Serves the vendored kicadpreview bundle over a loopback HTTP server and
 * drives it with Playwright (headless Chromium): loads .kicad_sch content,
 * waits for the canvas to settle, captures a PNG screenshot of the drawing
 * surface, and collects structured content (sheet list + BOM) from the page.
 * No visible browser window is ever shown.
 */

import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import type { Browser } from "playwright";

/** One design file to render (text content of a .kicad_sch/.kicad_pro/...). */
export interface RenderFile {
    name: string;
    content: string;
}

export interface RenderOptions {
    files: RenderFile[];
    /** Capture this sheet's filename instead of the first page. */
    sheet?: string;
    /** Viewport width in CSS px (default 1600). */
    width?: number;
    /** Viewport height in CSS px (default 1000). */
    height?: number;
    /** Directory containing dist/ + design_blocks/ (default: in-package vendor dir, see defaultVendorDir). */
    vendorDir?: string;
    /** Playwright browser channel, e.g. "chrome" or "msedge" (default: bundled chromium). */
    browserChannel?: "chromium" | "chrome" | "msedge";
    /** Explicit browser executable path (overrides channel). */
    executablePath?: string;
    /** Per-operation timeout budget in ms (default 90000). */
    timeoutMs?: number;
}

export interface SheetInfo {
    filename: string;
    name: string | null;
    path: string | null;
}

export interface BomItemView {
    Reference: string;
    Name: string;
    Footprint: string;
    Description: string;
    Qty: number;
    DNP: boolean;
}

export interface RenderResult {
    png: Buffer;
    width: number;
    height: number;
    sheets: SheetInfo[];
    capturedSheet: string | null;
    bom: { count: number; totalQty: number; items: BomItemView[]; error?: string };
    consoleErrors: string[];
}

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".map": "application/json",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
    ".kicad_sch": "text/plain; charset=utf-8",
    ".kicad_pcb": "text/plain; charset=utf-8",
    ".kicad_pro": "application/json",
};

/**
 * Default vendor location: the in-package copy (published layout, resolved
 * relative to this compiled file), falling back to the legacy workspace-root
 * copy (<project root>/vendor/kicadpreview) for checkouts that predate the
 * move. The first candidate containing dist/ wins.
 */
export function defaultVendorDir(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        resolve(here, "../../vendor/kicadpreview"), // lib/render/../.. = package root
        resolve(here, "../../../../vendor/kicadpreview"), // legacy workspace-root layout
    ];
    return candidates.find((p) => existsSync(join(p, "dist"))) ?? candidates[0];
}

/**
 * The render page: a minimal host for the kicadpreview bundle. Exposes
 * `window.__schPreview__` with load/switchSheet and returns structured data.
 */
export function renderPageHtml(): string {
    return /* html */ `<!doctype html>
<html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"kicadpreview":"./dist/ecad-viewer.js"}}</script>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #fff; overflow: hidden; }
  #viewer { width: 100vw; height: 100vh; }
</style>
</head><body>
<div id="viewer"></div>
<script type="module">
import { SchematicViewer, BomViewer } from "kicadpreview";

const viewer = new SchematicViewer(document.getElementById("viewer"));

/**
 * Fit the camera to the union of the sheet content and the paper frame.
 *
 * kicanvas' zoom_fit_top_item (called by fitScreen) fits ONLY the content
 * bounding box; for designs whose content extends beyond the paper (or is far
 * from the origin) the page outline / title block gets cropped out of the
 * screenshot. Here we wait until the internal fit has actually reached the
 * camera (the kicanvas:sheet:loaded event fires BEFORE it does), then expand
 * the camera bbox to also cover the paper rectangle [0..W] x [0..H].
 *
 * NOTE: camera.bbox is a getter returning a fresh copy on each access — the
 * expansion must go through the SETTER (cam.bbox = {...}), which applies a
 * uniform zoom + centering (aspect-corrected) to the given box.
 */
async function fitWithPaper(preSwitchBbox) {
    const tStart = Date.now();
    let v;
    while (Date.now() - tStart < 10000) {
        v = viewer.element?.shadowRoot?.querySelector("kc-schematic-app")?.viewer;
        const b = v?.viewport?.camera?.bbox;
        const ready = !!b && b.w > 0 && b.h > 0 &&
            (!preSwitchBbox || b.x !== preSwitchBbox.x || b.y !== preSwitchBbox.y || b.w !== preSwitchBbox.w || b.h !== preSwitchBbox.h);
        if (ready) break;
        await new Promise((r) => setTimeout(r, 50));
    }
    try {
        const cam = v?.viewport?.camera;
        const doc = v?.document;
        if (!cam || !doc) return;
        // AD-converted documents render no worksheet frame — merging the paper
        // rectangle would only add a blank margin around far-from-origin content.
        if (doc.is_converted_from_ad) return;
        const cur = cam.bbox; // copy — do not mutate; use the setter below
        const pw = doc.paper?.width ?? 0;
        const ph = doc.paper?.height ?? 0;
        const x1 = Math.min(cur.x, 0);
        const y1 = Math.min(cur.y, 0);
        const x2 = Math.max(cur.x + cur.w, pw);
        const y2 = Math.max(cur.y + cur.h, ph);
        cam.bbox = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        v.draw();
    } catch { /* keep whatever framing the internal pipeline produced */ }
}

window.__schPreview__ = {
    status: "idle",
    sheets: [],
    async load(blobs) {
        this.status = "loading";
        const files = blobs.map((b) => {
            const bytes = Uint8Array.from(atob(b.contentBase64), (c) => c.charCodeAt(0));
            return new File([bytes], b.name);
        });
        await viewer.loadFromFiles(files);

        const proj = viewer.element && viewer.element.project;
        // kicanview's page.filename is the generic "schematic" for every page;
        // the real per-sheet identity (and what switchPage/file_by_name resolve)
        // is the file name in sheet_path. Surface that as the filename field so
        // multi-sheet projects expose distinct, switchable sheet ids.
        this.sheets = ((proj && proj.pages) || []).map((p) => ({
            filename: p.sheet_path ?? p.filename,
            name: p.name || null,
            path: p.sheet_path || null,
        }));

        // BOM extraction (standalone DOM table; discarded afterwards).
        let bom = { count: 0, totalQty: 0, items: [] };
        try {
            const holder = document.createElement("div");
            const bv = new BomViewer(holder);
            const items = await bv.loadFromFiles(files);
            bom = {
                count: items.length,
                totalQty: items.reduce((s, i) => s + (i.Qty || 0), 0),
                items: items.map((i) => ({
                    Reference: i.Reference || "",
                    Name: i.Name || "",
                    Footprint: i.Footprint || "",
                    Description: i.Description || "",
                    Qty: i.Qty || 0,
                    DNP: !!i.DNP,
                })),
            };
            bv.dispose();
        } catch (e) {
            bom.error = String(e && e.message ? e.message : e);
        }

        await fitWithPaper(null);
        this.status = "ready";
        return { sheets: this.sheets, bom };
    },
    async switchSheet(filename) {
        const preBbox = viewer.element?.shadowRoot?.querySelector("kc-schematic-app")?.viewer?.viewport?.camera?.bbox;
        await viewer.element.switchPage(filename);
        // Wait for the sheet to actually load (bounded fallback).
        await new Promise((resolveWait) => {
            const timer = setTimeout(resolveWait, 5000);
            viewer.element.addEventListener(
                "kicanvas:sheet:loaded",
                () => { clearTimeout(timer); resolveWait(); },
                { once: true },
            );
        });
        await fitWithPaper(preBbox ? { x: preBbox.x, y: preBbox.y, w: preBbox.w, h: preBbox.h } : null);
    },
};
</script>
</body></html>`;
}

interface StaticServerHandle {
    base: string;
    close(): Promise<void>;
}

/** Serve the vendor directory on an ephemeral loopback port (+ /_render.html). */
async function startStaticServer(rootDir: string): Promise<StaticServerHandle> {
    const normalizedRoot = normalize(resolve(rootDir));
    const server: Server = createServer((req, res) => {
        try {
            const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]!);
            if (urlPath === "/_render.html") {
                res.writeHead(200, { "Content-Type": MIME[".html"] });
                res.end(renderPageHtml());
                return;
            }
            const file = normalize(join(normalizedRoot, urlPath));
            if (file !== normalizedRoot && !file.startsWith(normalizedRoot + sep)) {
                res.writeHead(403);
                res.end("forbidden");
                return;
            }
            readFile(file)
                .then((buf) => {
                    res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream" });
                    res.end(buf);
                })
                .catch(() => {
                    res.writeHead(404);
                    res.end("not found");
                });
        } catch {
            res.writeHead(500);
            res.end("internal error");
        }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return {
        base: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((r) => {
                server.closeAllConnections?.();
                server.close(() => r());
            }),
    };
}

/**
 * Render schematic files headlessly and capture a PNG screenshot plus content.
 * Spawns one short-lived headless browser per call; the loopback server and
 * browser are always torn down in `finally`.
 */
export async function renderSchematic(options: RenderOptions): Promise<RenderResult> {
    if (options.files.length === 0) throw new Error("no files to render");
    const width = options.width ?? 1600;
    const height = options.height ?? 1000;
    const timeoutMs = options.timeoutMs ?? 90_000;
    const vendorDir = resolve(options.vendorDir ?? defaultVendorDir());

    const server = await startStaticServer(vendorDir);
    let browser: Browser | undefined;
    try {
        // Launch with graceful fallback: an explicit executable/channel wins;
        // otherwise try the bundled chromium, then installed system browsers
        // (covers playwright/browser-revision mismatches on shared machines).
        const attempts: Parameters<typeof chromium.launch>[0][] = options.executablePath
            ? [{ headless: true, executablePath: options.executablePath }]
            : options.browserChannel
              ? [
                    { headless: true, channel: options.browserChannel },
                    { headless: true },
                ]
              : [
                    { headless: true },
                    { headless: true, channel: "chrome" },
                    { headless: true, channel: "msedge" },
                ];
        let lastError: unknown;
        browser = undefined;
        for (const attempt of attempts) {
            try {
                browser = await chromium.launch(attempt);
                break;
            } catch (error) {
                lastError = error;
            }
        }
        if (!browser) throw new Error(`no usable headless browser: ${String(lastError)}`);
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        page.setDefaultTimeout(timeoutMs);

        const consoleErrors: string[] = [];
        page.on("console", (msg) => {
            if (msg.type() === "error") consoleErrors.push(msg.text());
        });
        page.on("pageerror", (err) => consoleErrors.push(String(err)));

        await page.goto(`${server.base}/_render.html`, { waitUntil: "load" });

        const requestedSheet = options.sheet ?? null;
        const data = await page.evaluate(
            async ({ blobs, sheet }) => {
                const api = (window as unknown as { __schPreview__?: any }).__schPreview__;
                if (!api) throw new Error("render page failed to initialize __schPreview__");
                const loaded = await api.load(blobs);

                let capturedSheet: string | null = null;
                const target = sheet ? loaded.sheets.find((s: SheetInfo) => s.filename === sheet || s.path === sheet) : undefined;
                if (target) {
                    await api.switchSheet(target.filename);
                    capturedSheet = target.filename;
                } else {
                    capturedSheet = loaded.sheets[0]?.filename ?? null;
                }
                return { sheets: loaded.sheets as SheetInfo[], bom: loaded.bom, capturedSheet };
            },
            {
                blobs: options.files.map((f) => ({
                    name: f.name,
                    contentBase64: Buffer.from(f.content, "utf8").toString("base64"),
                })),
                sheet: requestedSheet,
            },
        );

        // The DOM contains one hidden 0x0 canvas (inactive tab) plus the live
        // drawing surface; pick the first canvas with a non-zero bounding box.
        const deadline = Date.now() + timeoutMs;
        let target: Awaited<ReturnType<typeof page.locator>> | undefined;
        while (!target && Date.now() < deadline) {
            const canvases = page.locator("#viewer canvas");
            const count = await canvases.count();
            for (let i = 0; i < count; i++) {
                const c = canvases.nth(i);
                const box = await c.boundingBox();
                if (box && box.width > 0 && box.height > 0) {
                    target = c;
                    break;
                }
            }
            if (!target) await page.waitForTimeout(250);
        }
        if (!target) throw new Error("no sized canvas appeared within the timeout");
        // Settle the final draw pass (fitScreen schedules rAF renders).
        await page.waitForTimeout(400);

        const pngBytes = await target.screenshot({ type: "png" });
        const box = await target.boundingBox();

        return {
            png: Buffer.from(pngBytes),
            width: Math.round(box?.width ?? width),
            height: Math.round(box?.height ?? height),
            sheets: data.sheets,
            capturedSheet: data.capturedSheet,
            bom: data.bom,
            consoleErrors,
        };
    } finally {
        await browser?.close().catch(() => undefined);
        await server.close();
    }
}

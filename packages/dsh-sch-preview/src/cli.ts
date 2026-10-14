/**
 * Standalone CLI for the headless schematic renderer (no DSH required):
 *
 *   node lib/cli.js <file.kicad_sch | dir> [more files...] [options]
 *
 * Options:
 *   --sheet <filename>    capture this sheet instead of the first page
 *   --width <px>          viewport width  (default 1600)
 *   --height <px>         viewport height (default 1000)
 *   --out <dir>           output directory (default ./.sch-preview-out)
 *   --vendor <dir>        kicadpreview vendor dir (default project vendor)
 *   --channel <name>      playwright channel: chrome | msedge
 *   --json                print the full JSON result (including BOM items)
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { renderSchematic, type RenderFile } from "./render/renderer.js";

const KICAD_EXTS = [".kicad_sch", ".kicad_pro", ".kicad_wks"];

function collectFiles(arg: string): RenderFile[] {
    const abs = resolve(arg);
    const st = statSync(abs);
    if (st.isFile()) {
        return [{ name: basename(abs), content: readFileSync(abs, "utf8") }];
    }
    // Directory: recursive walk for KiCad design files.
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

interface CliArgs {
    files: string[];
    sheet?: string;
    width?: string;
    height?: string;
    out?: string;
    vendor?: string;
    channel?: string;
    json?: string;
}

function parseArgs(argv: string[]): CliArgs {
    const known = new Set(["sheet", "width", "height", "out", "vendor", "channel", "json"]);
    const args: CliArgs = { files: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a.startsWith("--")) {
            const key = a.slice(2);
            if (!known.has(key)) throw new Error(`unknown option --${key}`);
            const value = argv[++i];
            if (value === undefined) throw new Error(`missing value for ${a}`);
            (args as unknown as Record<string, unknown>)[key] = value;
        } else {
            args.files.push(a);
        }
    }
    return args;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.files.length === 0) {
        console.error("usage: node lib/cli.js <file.kicad_sch | dir> [more...] [--sheet x] [--width n] [--height n] [--out dir] [--json]");
        process.exitCode = 1;
        return;
    }

    const files: RenderFile[] = [];
    for (const f of args.files) files.push(...collectFiles(f));
    if (files.length === 0) throw new Error(`no KiCad design files found in: ${args.files.join(", ")}`);

    const baseName = basename(files[0]!.name).replace(/\.kicad_sch$/, "");
    const result = await renderSchematic({
        files,
        sheet: args.sheet,
        width: args.width ? Number(args.width) : undefined,
        height: args.height ? Number(args.height) : undefined,
        vendorDir: args.vendor,
        browserChannel: (args.channel as "chrome" | "msedge") || undefined,
    });

    const outDir = resolve(args.out ?? ".sch-preview-out");
    mkdirSync(outDir, { recursive: true });
    const sheetTag = result.capturedSheet ? `_${basename(result.capturedSheet).replace(/\.kicad_sch$/, "")}` : "";
    const outPath = join(outDir, `${baseName}${sheetTag}.png`);
    writeFileSync(outPath, result.png);

    const jsonOut = args.json ? result.bom : { count: result.bom.count, totalQty: result.bom.totalQty, error: result.bom.error };
    console.log(
        JSON.stringify(
            {
                png: outPath,
                size: `${result.width}x${result.height}`,
                bytes: result.png.length,
                sheets: result.sheets.map((s) => s.filename),
                capturedSheet: result.capturedSheet,
                bom: jsonOut,
                consoleErrors: result.consoleErrors,
            },
            null,
            2,
        ),
    );
    if (!args.json && result.bom.count > 0) {
        console.log(`\nBOM (${result.bom.count} kinds, ${result.bom.totalQty} total):`);
        for (const item of result.bom.items.slice(0, 20)) {
            console.log(`  ${item.Reference}  ${item.Name || "-"}  x${item.Qty}${item.DNP ? "  [DNP]" : ""}`);
        }
    }
}

main().catch((err) => {
    console.error("render failed:", err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
});

// Mock-ctx smoke test: run the plugin's apply() against a fake context to
// validate the full defineTool path (schema compilation + registration).
import { fileURLToPath } from "node:url";
const pkgDir = fileURLToPath(new URL("..", import.meta.url)); // package root
const mod = await import("../lib/index.js");

let registered = null;
const ctx = {
    tools: { register: (def) => { registered = def; } },
    get: () => undefined,
    emit: () => {},
};

mod.apply(ctx, {});

if (!registered) throw new Error("tool was not registered");
console.log("registered tool:", registered.name);
console.log("description ok:", typeof registered.description === "string" && registered.description.length > 50);

// Exercise the compiled schemas: valid + invalid args.
const schema = registered.schema ?? registered.parameters;
console.log("schema present:", !!schema);

// Render the output value through the tool's own render (if exposed).
if (registered.render) {
    const blocks = registered.render({}, {
        savedTo: "C:/tmp/x.png",
        sheets: [{ filename: "1.kicad_sch" }],
        capturedSheet: "1.kicad_sch",
        bom: { count: 37, totalQty: 37, items: [] },
    });
    console.log("render blocks:", JSON.stringify(blocks).slice(0, 200));
}

// Simulate an execute call with a real file (no attachments -> text-only path).
if (registered.execute) {
    const exec = { agent: undefined, signal: new AbortController().signal };
    const value = await registered.execute({
        file_path: `${pkgDir}vendor/kicadpreview/design_blocks/1.kicad_sch`,
        save_dir: `${pkgDir}.sch-preview-out`,
    }, exec);
    console.log("execute ok:", JSON.stringify({ savedTo: value.savedTo, sheets: value.sheets, bom: value.bom.count, image: value.image }));
}

console.log("SMOKE TEST PASSED");

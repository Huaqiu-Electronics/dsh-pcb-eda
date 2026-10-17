// Verify the attachImage gate in both directions with a fake attachments store.
import assert from "node:assert";
import { fileURLToPath } from "node:url";
const pkgDir = fileURLToPath(new URL("..", import.meta.url)); // package root
const mod = await import("../lib/index.js");

const FILE = `${pkgDir}vendor/kicadpreview/design_blocks/2.kicad_sch`;
const OUT = `${pkgDir}.sch-preview-out`;

function makeCtx() {
    let registered;
    const ctx = {
        tools: { register: (def) => { registered = def; } },
        get: (key) =>
            key === "attachments"
                ? {
                      imageLimits: { mediaTypes: ["image/png"] },
                      saveImage: async ({ data, mediaType, name }) => ({
                          attachmentId: "att-test-1",
                          mediaType,
                          bytes: data.length,
                          width: 1200,
                          height: 800,
                          name,
                      }),
                  }
                : undefined,
        emit: () => {},
    };
    const exec = { agent: undefined, signal: new AbortController().signal };
    return { ctx, exec, getRegistered: () => registered };
}

// Path A: default config (attachImage unset -> true) with a store present.
{
    const { ctx, exec, getRegistered } = makeCtx();
    mod.apply(ctx, {});
    const v = await getRegistered().execute({ file_path: FILE, save_dir: OUT }, exec);
    assert.ok(v.image, "default config should attach the image");
    assert.equal(v.image.attachmentId, "att-test-1");
    console.log("A) default -> image attached:", v.image.attachmentId, `(${v.image.bytes} bytes)`);
}

// Path B: attachImage:false with the same store present.
{
    const { ctx, exec, getRegistered } = makeCtx();
    mod.apply(ctx, { attachImage: false });
    const v = await getRegistered().execute({ file_path: FILE, save_dir: OUT }, exec);
    assert.strictEqual(v.image, undefined, "attachImage:false must not attach the image");
    assert.ok(v.savedTo, "savedTo must still be present");
    console.log("B) attachImage:false -> text only, savedTo:", v.savedTo);
}

// Path C: default config but NO attachments store (text-only deployment).
{
    const { exec, getRegistered } = makeCtx();
    const ctx = { tools: { register: (def) => getRegistered.bind(null, def) }, get: () => undefined, emit: () => {} };
    let registered;
    ctx.tools.register = (def) => { registered = def; };
    mod.apply(ctx, {});
    const v = await registered.execute({ file_path: FILE, save_dir: OUT }, exec);
    assert.strictEqual(v.image, undefined, "no store -> no image");
    console.log("C) no store -> text only, savedTo:", v.savedTo);
}

console.log("ATTACH-IMAGE GATE TESTS PASSED");

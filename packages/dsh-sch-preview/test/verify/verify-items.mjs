// Verify every schematic item's anchor has ink in the rendered PNG (completeness check).
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

const schFile = process.argv[2];
const pngFile = process.argv[3];
const camX1 = Number(process.argv[4]);
const camY1 = Number(process.argv[5]);
const camW = Number(process.argv[6]);
const camH = Number(process.argv[7]);
const imgW = Number(process.argv[8] ?? 1600);
const imgH = Number(process.argv[9] ?? 1000);

// ---- parse top-level item anchors (string-aware, same logic as debug-bbox.mjs) ----
const text = readFileSync(schFile, "utf8");
const stack = [];
let inLibSymbols = false;
const anchors = []; // { type, x, y }
let i = 0;
while (i < text.length) {
    const ch = text[i];
    if (ch === '"') { const e = text.indexOf('"', i + 1); i = e >= 0 ? e + 1 : text.length; continue; }
    if (ch === "(") {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        let name = "";
        if (text[j] === '"') { const e = text.indexOf('"', j + 1); name = text.slice(j + 1, e); i = e; }
        else { const m = /^[A-Za-z_][A-Za-z0-9_.\-]*/.exec(text.slice(j)); if (m) { name = m[0]; i = j + m[0].length - 1; } else i = j; }
        const newDepth = stack.length + 1;
        if (newDepth === 3 && !inLibSymbols && stack.length >= 2) {
            const parent = stack[stack.length - 1].name;
            if (name === "at" || name === "xy") {
                let k = i + 1, nums = [];
                while (nums.length < 2 && k < text.length) {
                    if (text[k] === '"') { const e = text.indexOf('"', k + 1); k = e >= 0 ? e + 1 : k + 1; continue; }
                    const m2 = /-?\d+(?:\.\d+)?/.exec(text.slice(k, k + 40));
                    if (!m2) break;
                    nums.push(parseFloat(m2[0]));
                    k = k + m2.index + m2[0].length;
                }
                if (nums.length >= 2) anchors.push({ type: parent, prop: name, x: nums[0], y: nums[1] });
            }
        }
        if (newDepth === 2 && name === "lib_symbols") inLibSymbols = true;
        stack.push({ name });
    } else if (ch === ")") {
        const popped = stack.pop();
        if (popped?.name === "lib_symbols" && stack.length === 1) inLibSymbols = false;
    }
    i++;
}

// Keep one anchor per item instance: first 'at' for non-wire items, first 'xy' for wires.
const seenItems = new Set();
const finalAnchors = [];
let idx = 0;
// Re-derive item boundaries to know when a new instance starts (depth-3 open).
// Simpler: dedupe by (type,x,y) AND cap per-type count using known totals.
const counts = {};
for (const a of anchors) {
    const key = `${a.type}:${a.x.toFixed(2)}:${a.y.toFixed(2)}`;
    if (seenItems.has(key)) continue;
    seenItems.add(key);
    // For non-wire items only 'at' is the anchor; wires only first 'xy' per wire.
    if (a.type === "wire" && a.prop !== "xy") continue;
    if (a.type !== "wire" && a.prop !== "at") continue;
    counts[a.type] = (counts[a.type] ?? 0) + 1;
    finalAnchors.push(a);
}

// ---- decode PNG ----
const buf = readFileSync(pngFile);
let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
const idat = [];
while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === "IDAT") idat.push(data);
    off += 12 + len;
}
const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = width * channels;
const px = Buffer.alloc(height * stride);
let pos = 0;
for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
        const a = x >= channels ? row[x - channels] : 0;
        const b = prev ? prev[x] : 0;
        const c = prev && x >= channels ? prev[x - channels] : 0;
        let v = raw[pos++];
        switch (filter) {
            case 1: v = (v + a) & 255; break;
            case 2: v = (v + b) & 255; break;
            case 3: v = (v + ((a + b) >> 1)) & 255; break;
            case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; break; }
        }
        row[x] = v;
    }
}
const ink = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const idx2 = (y * width + x) * channels;
    return px[idx2] < 200 && px[idx2 + 1] < 200 && px[idx2 + 2] < 200;
};
const inkNear = (wx, wy, radiusPx) => {
    const pxX = Math.round(((wx - camX1) / camW) * imgW);
    const pxY = Math.round(((wy - camY1) / camH) * imgH);
    for (let dy = -radiusPx; dy <= radiusPx; dy++)
        for (let dx = -radiusPx; dx <= radiusPx; dx++)
            if (ink(pxX + dx, pxY + dy)) return { pxX, pxY };
    return null;
};

const perType = {};
for (const a of finalAnchors) {
    const t = a.type;
    perType[t] ??= { total: 0, missing: [] };
    perType[t].total++;
    if (!inkNear(a.x, a.y, 12)) perType[t].missing.push({ x: a.x, y: a.y });
}

console.log(JSON.stringify({
    png: pngFile,
    anchorsTotal: finalAnchors.length,
    perType,
}, null, 2));

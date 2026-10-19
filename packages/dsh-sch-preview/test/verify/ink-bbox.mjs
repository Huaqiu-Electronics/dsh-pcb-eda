// Color-aware ink analysis: min-channel < threshold (catches red/green/blue lines, ignores gray grid).
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

const pngFile = process.argv[2];
const camX1 = Number(process.argv[3]);
const camY1 = Number(process.argv[4]);
const camW = Number(process.argv[5]);
const camH = Number(process.argv[6]);
const imgW = Number(process.argv[7] ?? 1600);
const imgH = Number(process.argv[8] ?? 1000);
const TH = Number(process.argv[9] ?? 160);

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
const minCh = (x, y) => { const i = (y * width + x) * channels; return Math.min(px[i], px[i + 1], px[i + 2]); };

let minX = width, minY = height, maxX = -1, maxY = -1;
for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
        if (minCh(x, y) < TH) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
    }
}
const toWorld = (pxX, pxY) => [+(camX1 + (pxX / imgW) * camW).toFixed(2), +(camY1 + (pxY / imgH) * camH).toFixed(2)];

// Edge contact check: ink on outermost 2 rows/cols?
const edge = { top: 0, bottom: 0, left: 0, right: 0 };
for (let x = 0; x < width; x++) { if (minCh(x, 0) < TH || minCh(x, 1) < TH) edge.top++; if (minCh(x, height - 1) < TH || minCh(x, height - 2) < TH) edge.bottom++; }
for (let y = 0; y < height; y++) { if (minCh(0, y) < TH || minCh(1, y) < TH) edge.left++; if (minCh(width - 1, y) < TH || minCh(width - 2, y) < TH) edge.right++; }

console.log(JSON.stringify({
    file: pngFile, width, height, threshold: `minChannel<${TH}`,
    inkBboxPx: { minX, minY, maxX, maxY },
    inkBboxWorld: { x1: toWorld(minX, 0)[0], y1: toWorld(0, minY)[1], x2: toWorld(maxX, 0)[0], y2: toWorld(0, maxY)[1] },
    marginsPx: { top: minY, bottom: height - 1 - maxY, left: minX, right: width - 1 - maxX },
    inkOnOuterEdge: edge,
}, null, 2));

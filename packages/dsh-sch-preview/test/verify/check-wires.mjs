// Check all wire endpoints are inside the camera bbox (nothing cropped).
import { readFileSync } from "node:fs";

const schFile = process.argv[2];
const camX1 = Number(process.argv[3]);
const camY1 = Number(process.argv[4]);
const camW = Number(process.argv[5]);
const camH = Number(process.argv[6]);

const text = readFileSync(schFile, "utf8");
const stack = [];
let inLibSymbols = false;
const wirePts = [];
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
        // wire > pts > xy  => depth 4, parent chain [kicad_sch, wire, pts]
        if (newDepth === 4 && !inLibSymbols && name === "xy" && stack.length >= 3) {
            const isWire = stack[stack.length - 2].name === "wire";
            const isPts = stack[stack.length - 1].name === "pts";
            if (isWire && isPts) {
                let k = i + 1, nums = [];
                while (nums.length < 2 && k < text.length) {
                    const m2 = /-?\d+(?:\.\d+)?/.exec(text.slice(k, k + 40));
                    if (!m2) break;
                    nums.push(parseFloat(m2[0]));
                    k = k + m2.index + m2[0].length;
                }
                if (nums.length >= 2) wirePts.push({ x: nums[0], y: nums[1] });
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

let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
let outside = [];
for (const p of wirePts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    const inCam = p.x >= camX1 && p.x <= camX1 + camW && p.y >= camY1 && p.y <= camY1 + camH;
    if (!inCam) outside.push(p);
}

console.log(JSON.stringify({
    wirePoints: wirePts.length,
    wireBbox: { minX, minY, maxX, maxY },
    camera: { x1: camX1, y1: camY1, x2: camX1 + camW, y2: camY1 + camH },
    pointsOutsideCamera: outside.length,
    outsideSample: outside.slice(0, 10),
}, null, 2));

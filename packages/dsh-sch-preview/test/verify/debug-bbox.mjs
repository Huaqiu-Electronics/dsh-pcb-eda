// Compute the true content bounding box of a .kicad_sch file from top-level items.
// String-aware s-expression scanner (quotes may contain parentheses).
import { readFileSync } from "node:fs";

const file = process.argv[2];
const text = readFileSync(file, "utf8");

let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
const counts = {};
const coordProps = new Set(["at", "xy"]);

const stack = []; // open s-expressions: { name }
let inLibSymbols = false;
const topLevelItems = [];

function record(name, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    counts[name] = (counts[name] ?? 0) + 1;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
}

function readNumbers(from, n) {
    const nums = [];
    let k = from;
    while (nums.length < n && k < text.length) {
        // skip whitespace and quotes (defensive)
        if (text[k] === '"') { const e = text.indexOf('"', k + 1); k = e >= 0 ? e + 1 : k + 1; continue; }
        const m = /-?\d+(?:\.\d+)?/.exec(text.slice(k, k + 40));
        if (!m) break;
        nums.push(parseFloat(m[0]));
        k = k + m.index + m[0].length;
    }
    return nums;
}

let i = 0;
while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
        // skip whole quoted string
        const e = text.indexOf('"', i + 1);
        i = e >= 0 ? e + 1 : text.length;
        continue;
    }
    if (ch === "(") {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        let name = "";
        if (text[j] === '"') {
            const e = text.indexOf('"', j + 1);
            name = text.slice(j + 1, e);
            i = e;
        } else {
            const m = /^[A-Za-z_][A-Za-z0-9_.\-]*/.exec(text.slice(j));
            if (m) { name = m[0]; i = j + m[0].length - 1; }
            else i = j;
        }
        const newDepth = stack.length + 1;
        if (newDepth === 3 && coordProps.has(name) && !inLibSymbols && stack.length >= 2) {
            const nums = readNumbers(i + 1, 2);
            if (nums.length >= 2) record(`${stack[stack.length - 1].name}:${name}`, nums[0], nums[1]);
        }
        if (newDepth === 2 && name === "lib_symbols") inLibSymbols = true;
        if (newDepth === 2) topLevelItems.push(name);
        stack.push({ name });
    } else if (ch === ")") {
        const popped = stack.pop();
        if (popped?.name === "lib_symbols" && stack.length === 1) inLibSymbols = false;
    }
    i++;
}

const summary = {};
for (const n of topLevelItems) summary[n] = (summary[n] ?? 0) + 1;
console.log(JSON.stringify({ file, topLevel: summary, minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, counts }, null, 2));

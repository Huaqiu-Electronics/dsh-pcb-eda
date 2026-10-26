/** Maintainer only: node render.mjs <generated-root> <png-directory>. */
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { resolveKiCadPaths } from '../../../../lib/builder.js';
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node render.mjs <generated-root> <png-directory>');
const root = resolve(process.argv[2]), destination = resolve(process.argv[3]);
mkdirSync(destination, { recursive: true });
const supplement = process.argv.includes('--supplement');
const crops = process.argv.includes('--systems') ? { 'mcu-minimum': [36, 39, 125, 88], 'mcu-external-crystal': [36, 39, 125, 110], 'usb-c-device': [36, 36, 130, 78], 'mosfet-low-side': [31, 33, 112, 74], 'swd-header': [43, 36, 66, 49] }
  : process.argv.includes('--dcdc') ? { 'dcdc-buck': [51, 37, 142, 85], 'dcdc-boost': [53, 37, 145, 80] }
  : supplement ? { 'ldo-three-pin': [43, 36, 112, 62],
  'reset-rc': [38, 32, 80, 55], 'i2c-pullups': [38, 33, 65, 44],
  'crystal-load': [43, 33, 85, 54] } : { 'led-power-indicator': [36, 32, 38, 53],
  'ldo-fixed-on': [32, 32, 115, 62],
  'pullup-button': [36, 32, 52, 57], 'decoupling-bank': [36, 36, 62, 40],
  'label-sides': [35, 34, 70, 50], 'label-vertical': [38, 30, 65, 55] };
for (const [id, crop] of Object.entries(crops)) {
  if (process.argv.includes('--circuits-only') && id.startsWith('label-')) continue;
  const directory = join(root, id), svgDir = join(directory, 'svg');
  mkdirSync(svgDir, { recursive: true });
  const result = spawnSync(resolveKiCadPaths().kicadCliPath, ['sch', 'export', 'svg', '--exclude-drawing-sheet',
    '--output', svgDir, join(directory, `${id}.kicad_sch`)], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  const svg = readFileSync(join(svgDir, `${id}.svg`), 'utf8').replace(/<svg\b[^>]*>/u,
    tag => tag.replace(/\bwidth="[^"]*"/u, `width="${crop[2] * 12}"`)
      .replace(/\bheight="[^"]*"/u, `height="${crop[3] * 12}"`)
      .replace(/\bviewBox="[^"]*"/u, `viewBox="${crop.join(' ')}"`));
  await sharp(Buffer.from(svg)).png().toFile(join(destination, `${id}.png`));
  console.log(join(destination, `${id}.png`));
}

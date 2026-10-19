/** Maintainer only: node render.mjs <generated-root> <png-directory>. */
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { resolveKiCadPaths } from '../../../../lib/builder.js';
if (!process.argv[2] || !process.argv[3]) throw new Error('Usage: node render.mjs <generated-root> <png-directory>');
const root = resolve(process.argv[2]), destination = resolve(process.argv[3]);
mkdirSync(destination, { recursive: true });
const crops = { 'led-power-indicator': [36, 32, 38, 53],
  'ldo-fixed-on': [32, 32, 115, 62],
  'pullup-button': [36, 32, 52, 57], 'decoupling-bank': [36, 36, 62, 40],
  'label-sides': [35, 34, 70, 50], 'label-vertical': [38, 30, 65, 55] };
for (const [id, crop] of Object.entries(crops)) {
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

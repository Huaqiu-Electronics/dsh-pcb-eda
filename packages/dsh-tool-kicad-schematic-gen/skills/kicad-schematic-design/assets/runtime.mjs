/** Shared bootstrap: retain this file's location or set the installed plugin directory. */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginDir = process.env.DSH_SCHEMATIC_PLUGIN_DIR || resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '../../..');
const builderPath = join(pluginDir, 'lib', 'builder.js');
if (!existsSync(builderPath)) throw new Error('Set DSH_SCHEMATIC_PLUGIN_DIR to the installed dsh-tool-kicad-schematic-gen directory before running copied examples.');
const builder = await import(pathToFileURL(builderPath).href);
export const Schematic = builder.Schematic;
export const attachPinLabel = builder.attachPinLabel;
export const attachPinLabels = builder.attachPinLabels;
export const templateDir = join(pluginDir, 'skills', 'kicad-schematic-design', 'templates');
let symbolDir;
export function symbolLibrary(name) {
  const directory = symbolDir ??= builder.resolveKiCadPaths().symbolDir;
  if (!directory) throw new Error('Set KICAD_SYMBOL_DIR to the installed KiCad symbols directory or use a downloaded project symbol library.');
  const filename = join(directory, `${name}.kicad_sym`);
  if (!existsSync(filename)) throw new Error(`Symbol library not found: ${filename}`);
  return filename;
}

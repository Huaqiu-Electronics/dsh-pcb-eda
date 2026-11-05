/** Shared bootstrap: retain this file's location or set the installed plugin directory. */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginDir = process.env.DSH_SCHEMATIC_PLUGIN_DIR || resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '../../..');
const builderPath = join(pluginDir, 'lib', 'builder.js');
if (!existsSync(builderPath)) throw new Error('Set DSH_SCHEMATIC_PLUGIN_DIR to the installed dsh-tool-kicad-schematic-gen directory before running copied examples.');
const builder = await import(pathToFileURL(builderPath).href);
export const Schematic = builder.Schematic;
export const validatePowerSymbolMapping = builder.validatePowerSymbolMapping;
export const SCHEMATIC_GRID_MM = builder.SCHEMATIC_GRID_MM;
export const snapGrid = builder.snapGrid;
export const gridPoint = builder.gridPoint;
export const attachPinLabel = builder.attachPinLabel;
export const attachPinLabels = builder.attachPinLabels;
export const templateDir = join(pluginDir, 'skills', 'kicad-schematic-design', 'templates');
/** Complete bundled power definitions: GND, +3V3 and +5V. No host discovery needed. */
export const powerLibraryPath = join(pluginDir, 'skills', 'kicad-schematic-design', 'assets', 'libraries', 'power.kicad_sym');
let symbolDir;
export function symbolLibrary(name, { directory } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Expected a symbol library name, not a path.');
  // An explicit project/host directory is authoritative; never silently substitute another library.
  if (!directory && name === 'power') {
    if (!existsSync(powerLibraryPath)) throw new Error(`Bundled power library missing: ${powerLibraryPath}. Restore the plugin resources; do not recursively search the host.`);
    return powerLibraryPath;
  }
  const resolvedDirectory = directory || (symbolDir ??= builder.resolveKiCadPaths().symbolDir);
  if (!resolvedDirectory) throw new Error('Set KICAD_SYMBOL_DIR to the installed KiCad symbols directory or use a downloaded project symbol library.');
  const filename = join(resolvedDirectory, `${name}.kicad_sym`);
  if (!existsSync(filename)) throw new Error(`Symbol library not found: ${filename}`);
  return filename;
}

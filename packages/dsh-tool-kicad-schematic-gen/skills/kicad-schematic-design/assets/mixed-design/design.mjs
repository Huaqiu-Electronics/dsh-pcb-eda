/** Reuse an inspected single-sheet module and add one independently scripted region. */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Schematic, templateDir, symbolLibrary } from '../runtime.mjs';
import { place } from './modules/load.mjs';

const [configPath, outputDirectory] = process.argv.slice(2);
if (!configPath || !outputDirectory || !isAbsolute(configPath) || !isAbsolute(outputDirectory)) {
  throw new Error('usage: node design.mjs <absolute-config.json> <absolute-unique-candidate-directory>');
}
const spec = JSON.parse(readFileSync(configPath, 'utf8'));
const sch = new Schematic({ projectName: spec.projectName, title: spec.title, paper: spec.paper,
  templateDir });

// Import before allocating new references; the returned target references are reserved.
const imported = sch.importModule(spec.source);
const reserved = new Set(Object.values(imported.references));
const counts = new Map();
const allocateReference = prefix => {
  let n = counts.get(prefix) ?? 0;
  do { n += 1; } while (reserved.has(`${prefix}${n}`));
  counts.set(prefix, n);
  const reference = `${prefix}${n}`;
  reserved.add(reference);
  return reference;
};
sch.frame({ name: spec.sourceTitle, description: spec.sourceDescription,
  autoBounds: true, objectUuids: imported.objectUuids });
const region = sch.region(spec.loadRegion);
const load = place({ region, part: spec.resistor, allocateReference, groundNet: spec.groundNet });
load.connect();
const anchors = imported.ports[spec.signalPort];
if (!anchors || anchors.length !== 1) throw new Error('Choose one explicit source signal anchor; a missing or repeated port needs a deliberate connection plan');
// The explicit source network mapping supplies the shared net name at the new endpoint.
const sharedNet = imported.netNames[spec.signalPort];
if (!sharedNet) throw new Error('signalPort needs a confirmed source network mapping');
sch.label(sharedNet, sch.pin(load.ports.signal.reference, load.ports.signal.pin));
const powerSymbols = spec.powerSymbols ? sch.replacePowerLabels(spec.powerSymbols) : [];
console.log(JSON.stringify({ ...sch.save(outputDirectory), powerSymbols, importedReferences: imported.references,
  sourceSignalAnchor: anchors[0], loadReference: load.ports.signal.reference }));

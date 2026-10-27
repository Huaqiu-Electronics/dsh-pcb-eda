/** Reuse an inspected single-sheet module and add one independently scripted region. */
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Schematic, templateDir } from '../runtime.mjs';
import { place } from './modules/load.mjs';
import { loadPlacement, configurePowerPlacements } from './layout.mjs';

// run-design.mjs always passes the candidate directory before extra arguments.
const [outputDirectory, configPath] = process.argv.slice(2);
if (!configPath || !outputDirectory || !isAbsolute(configPath) || !isAbsolute(outputDirectory)) {
  throw new Error('script arguments: <absolute-unique-candidate-directory> <absolute-config.json>; launch with run-design.mjs and a saved plan');
}
const spec = JSON.parse(readFileSync(configPath, 'utf8'));
const sch = new Schematic({ projectName: spec.projectName, title: spec.title, paper: spec.paper,
  templateDir, requiredPowerSymbols: spec.powerSymbols?.nets });

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
const load = place({ region, part: spec.resistor, allocateReference, groundNet: spec.groundNet, placement: loadPlacement });
load.connect();
const anchors = imported.ports[spec.signalPort];
if (!anchors || anchors.length !== 1) throw new Error('Choose one explicit source signal anchor; a missing or repeated port needs a deliberate connection plan');
// The explicit source network mapping supplies the shared net name at the new endpoint.
const sharedNet = imported.netNames[spec.signalPort];
if (!sharedNet) throw new Error('signalPort needs a confirmed source network mapping');
sch.label(sharedNet, sch.pin(load.ports.signal.reference, load.ports.signal.pin));
const powerPlan = spec.powerSymbols ? sch.planPowerPlacements(spec.powerSymbols) : null;
if (powerPlan) configurePowerPlacements(sch, powerPlan);
const powerSymbols = powerPlan ? sch.replacePowerLabels({ ...spec.powerSymbols, placements: powerPlan.placements }) : [];
console.log(JSON.stringify({ ...sch.save(outputDirectory), powerSymbols, powerPlan: powerPlan?.diagnostics ?? null, importedReferences: imported.references,
  sourceSignalAnchor: anchors[0], loadReference: load.ports.signal.reference }));

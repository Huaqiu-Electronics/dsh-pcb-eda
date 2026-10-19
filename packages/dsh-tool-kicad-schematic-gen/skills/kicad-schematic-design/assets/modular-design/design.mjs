/** One entry point combines independently authored modules into one editable sheet. */
import { isAbsolute } from 'node:path';
import { Schematic, templateDir, symbolLibrary } from '../runtime.mjs';
import { parts } from './shared/parts.mjs';
import { place as placeInput } from './modules/input.mjs';
import { place as placeOutput } from './modules/output.mjs';

const outputDirectory = process.argv[2];
if (!outputDirectory || !isAbsolute(outputDirectory)) {
  throw new Error('usage: node design.mjs <absolute-unique-candidate-directory>');
}
const sch = new Schematic({
  projectName: 'modular_demo', title: 'Modular script example', paper: 'A4',
  templateDir,
});
const layout = {
  input: { name: 'Input', description: 'Input resistor', origin: [25, 25], size: [80, 80] },
  output: { name: 'Output', description: 'Output resistor', origin: [120, 25], size: [80, 80] },
};
const regions = Object.fromEntries(Object.entries(layout).map(([key, spec]) => [key, sch.region(spec)]));
const counts = new Map();
const allocateReference = prefix => {
  const number = (counts.get(prefix) ?? 0) + 1;
  counts.set(prefix, number);
  return `${prefix}${number}`;
};
const input = placeInput({ region: regions.input, parts, allocateReference,
  nets: { supply: '+3V3' }, bounds: layout.input });
const output = placeOutput({ region: regions.output, parts, allocateReference,
  nets: { ground: 'GND' }, bounds: layout.output });
for (const module of [input, output]) module.connect();

// Cross-region routes use global pin positions and an explicit routing channel.
const a = sch.pin(input.ports.signal.reference, input.ports.signal.pin);
const b = sch.pin(output.ports.signal.reference, output.ports.signal.pin);
sch.wire(a, b, [[110, a[1]], [110, b[1]]]);
sch.label('SIGNAL', a);
sch.replacePowerLabels({
  libraryPath: symbolLibrary('power'),
  nets: { '+3V3': 'power:+3V3', GND: 'power:GND' },
});
console.log(JSON.stringify(sch.save(outputDirectory)));

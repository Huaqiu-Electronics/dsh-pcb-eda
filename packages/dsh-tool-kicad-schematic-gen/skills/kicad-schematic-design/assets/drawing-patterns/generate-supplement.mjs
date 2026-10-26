/** Maintainer-only fixtures using the same KiCad library conventions as the original examples. */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDesignPlan } from '../../../../lib/builder.js';
import { Schematic, templateDir } from '../runtime.mjs';
import { place as ldo } from './ldo-three-pin.mjs';
import { place as reset } from './reset-rc.mjs';
import { place as i2c } from './i2c-pullups.mjs';
import { place as crystal } from './crystal-load.mjs';
import { place as buck } from './dcdc-buck.mjs';
import { place as boost } from './dcdc-boost.mjs';

if (!process.argv[2]) throw new Error('Usage: node generate-supplement.mjs <unused-output-root> [--dcdc]');
const root = resolve(process.argv[2]);
if (existsSync(root)) throw new Error('Choose an unused output root; existing references are preserved');
mkdirSync(root, { recursive: true });
const planPath = join(root, 'drawing-maintenance-plan.md');
writeFileSync(planPath, '# Drawing reference maintenance plan\n\n## Scope\nGenerate selected layout examples using pinned KiCad reference symbols for a three-role fixed LDO, active-low reset RC, two I2C pullups and passive crystal load capacitors, or asynchronous Buck/Boost converters. Example values demonstrate field placement, not production design decisions.\n\n## Constraints\nUse 50 mil coordinates, retain original physical pin identities, keep power domains separate and render with KiCad CLI. Preserve requirement confirmation and real component import rules in hardware projects.\n');
const plan = readDesignPlan(planPath), designPlan = { path: plan.path, sha256: plan.sha256 };
// Pinned, unmodified symbol definitions and inheritance dependencies; see reference-symbols.md.
const libraryPath = join(dirname(fileURLToPath(import.meta.url)), 'reference-symbols.kicad_sym');
const part = (name, pins, value = name, angle = 0) => ({
  libraryPath, libId: `DrawingReference:${name}`, value, angle, pins,
});
const resistor = part('R', { top: '1', bottom: '2' }, '10k');
const capacitor = part('C', { top: '1', bottom: '2' }, '100n');
const converterParts = {
  inductor: part('L', { left: '1', right: '2' }, 'L_SEL', 90),
  inputCapacitor: { ...capacitor, value: 'C_IN' }, outputCapacitor: { ...capacitor, value: 'C_OUT' },
  feedback: { upper: { ...resistor, value: 'R_HIGH' }, lower: { ...resistor, value: 'R_LOW' } },
};
const converterRefs = { controller: 'U1', inductor: 'L1', diode: 'D1', inputCapacitor: 'C1',
  outputCapacitor: 'C2', feedback: { upper: 'R1', lower: 'R2' } };
const fixtures = [
  ['ldo-three-pin', ldo, {
    ldo: part('AMS1117-3.3', { vin: '3', vout: '2', gnd: '1' }),
    inputCapacitors: [{ ...capacitor, value: '10u' }, capacitor],
    outputCapacitors: [{ ...capacitor, value: '10u' }, capacitor],
  }, { ldo: 'U1', inputCapacitors: ['C1', 'C2'], outputCapacitors: ['C3', 'C4'] },
  { input: '+5V', output: '+3V3' }, {}],
  ['reset-rc', reset, {
    resistor, button: part('SW_Push', { top: '1', bottom: '2' }, 'RESET', 270), capacitor,
  }, { resistor: 'R1', button: 'SW1', capacitor: 'C1' },
  { signal: 'RESET_N' }, { activeLowRcConfirmed: true }],
  ['i2c-pullups', i2c, { resistors: [resistor, resistor] }, { resistors: ['R1', 'R2'] },
  { sda: 'SDA', scl: 'SCL' }, {}],
  ['crystal-load', crystal, {
    crystal: part('Crystal', { left: '1', right: '2' }, 'XTAL'),
    capacitors: [{ ...capacitor, value: 'CL1' }, { ...capacitor, value: 'CL2' }],
  }, { crystal: 'Y1', capacitors: ['C1', 'C2'] },
  { left: 'OSC_IN', right: 'OSC_OUT' }, { externalCrystalConfirmed: true }],
  ['dcdc-buck', buck, { ...converterParts,
    controller: part('LM2596S-ADJ', { vin: '1', sw: '2', gnd: '3', fb: '4', shutdown: '5' }),
    diode: part('D_Schottky', { cathode: '1', anode: '2' }, 'D_SEL', 270),
  }, converterRefs, { input: '+5V', output: '+3V3', feedback: 'FB_BUCK' },
  { buckTopologyConfirmed: true, shutdownToGroundConfirmed: true }],
  ['dcdc-boost', boost, { ...converterParts,
    controller: part('TPS61040DBV', { vin: '5', sw: '1', gnd: '2', fb: '3', en: '4' }),
    diode: part('D_Schottky', { left: '2', right: '1' }, 'D_SEL', 180),
  }, converterRefs, { input: '+3V3', output: '+5V', feedback: 'FB_BOOST' },
  { boostTopologyConfirmed: true, enableToVinConfirmed: true }],
];
for (const [id, place, parts, references, nets, options] of fixtures) {
  if (id.startsWith('dcdc-') !== process.argv.includes('--dcdc')) continue;
  const powers = { '+3V3': 'DrawingReference:+3V3', GND: 'DrawingReference:GND',
    ...(id === 'ldo-three-pin' || id.startsWith('dcdc-') ? { '+5V': 'DrawingReference:+5V' } : {}) };
  if (id === 'crystal-load') delete powers['+3V3'];
  if (id === 'i2c-pullups') delete powers.GND;
  const sch = new Schematic({ designPlan, projectName: id, title: id, paper: 'A4', templateDir,
    requiredPowerSymbols: powers });
  const region = sch.region({ name: id, description: 'Drawing example; values are illustrative',
    origin: [25.4, 25.4], size: id.startsWith('dcdc-') ? [241.3, 139.7] : [165.1, 101.6] });
  const unit = place({ region, at: [10.16, 12.7], parts, references,
    nets: { supply: '+3V3', ground: 'GND', ...nets }, ...options });
  unit.connect();
  const plan = sch.planPowerPlacements({ libraryPath, nets: powers });
  sch.replacePowerLabels({ libraryPath, nets: powers, placements: plan.placements });
  console.log(JSON.stringify({ id, ...sch.save(join(root, id)) }));
}

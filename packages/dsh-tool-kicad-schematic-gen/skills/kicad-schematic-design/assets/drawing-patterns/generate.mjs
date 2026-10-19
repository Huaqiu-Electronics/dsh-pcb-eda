/** Maintainer fixture: node generate.mjs <unique-output-root>. Not a production parts list. */
import { resolve, join } from 'node:path';
import { Schematic, templateDir, symbolLibrary } from '../runtime.mjs';
import { place as led } from './led-power-indicator.mjs';
import { place as button } from './pullup-button.mjs';
import { place as bank } from './decoupling-bank.mjs';
import { labelSide } from './label-alignment.mjs';
import { place as ldo } from './ldo-fixed-on.mjs';
if (!process.argv[2]) throw new Error('Usage: node generate.mjs <unique-output-root>');
const output = resolve(process.argv[2]);
const resistor = { libraryPath: symbolLibrary('Device'), libId: 'Device:R', value: '10k',
  pins: { top: '1', bottom: '2' }, angle: 0 };
const capacitor = { libraryPath: symbolLibrary('Device'), libId: 'Device:C', value: '100n',
  pins: { top: '1', bottom: '2' }, angle: 0 };
const fixtures = [
  ['ldo-fixed-on', ldo, { ldo: { libraryPath: symbolLibrary('Regulator_Linear'),
    libId: 'Regulator_Linear:AP2112K-3.3', value: 'AP2112K-3.3', angle: 0,
    pins: { vin: '1', gnd: '2', en: '3', vout: '5', nc: [] } },
    inputCapacitors: [{ ...capacitor, value: '10u' }, capacitor],
    outputCapacitors: [{ ...capacitor, value: '10u' }, capacitor] },
    { ldo: 'U1', inputCapacitors: ['C1', 'C2'], outputCapacitors: ['C3', 'C4'] },
    { input: '+5V', output: '+3V3' }],
  ['led-power-indicator', led, { resistor: { ...resistor, value: '1k' }, led: {
    libraryPath: symbolLibrary('Device'), libId: 'Device:LED', value: 'LED', angle: 90,
    pins: { anode: '2', cathode: '1' } } }, { resistor: 'R1', led: 'D1' }, {}],
  ['pullup-button', button, { resistor, button: { libraryPath: symbolLibrary('Switch'),
    libId: 'Switch:SW_Push', value: 'KEY', angle: 270, pins: { top: '1', bottom: '2' } } },
    { resistor: 'R1', button: 'SW1' }, { signal: 'KEY_IN' }],
  ['decoupling-bank', bank, { capacitors: [{ ...capacitor, value: '10u' }, capacitor] },
    { capacitors: ['C1', 'C2'] }, {}],
];
for (const [id, place, parts, references, extra] of fixtures) {
  const nets = { supply: '+3V3', ground: 'GND', ...extra };
  const powers = { '+3V3': 'power:+3V3', GND: 'power:GND', ...(id === 'ldo-fixed-on' ? { '+5V': 'power:+5V' } : {}) };
  const sch = new Schematic({ projectName: id, title: id, paper: 'A4', templateDir, requiredPowerSymbols: powers });
  const region = sch.region({ name: id, description: 'Drawing example; values are illustrative', origin: [25, 25], size: [id === 'ldo-fixed-on' ? 130 : 85, 80] });
  const unit = place({ region, at: [10, 12], parts, references, nets, enableToVin: id === 'ldo-fixed-on' });
  unit.connect();
  const plan = sch.planPowerPlacements({ libraryPath: symbolLibrary('power'), nets: powers });
  sch.replacePowerLabels({ libraryPath: symbolLibrary('power'), nets: powers, placements: plan.placements });
  console.log(JSON.stringify({ id, ...sch.save(join(output, id)) }));
}
// Rotate the same known fixture to exercise real label text in all four directions.
for (const [id, angle] of [['label-sides', 0], ['label-vertical', 90]]) {
  const sch = new Schematic({ projectName: id, title: id, paper: 'A4', templateDir });
  sch.addSymbol({ libraryPath: symbolLibrary('Connector_Generic'), libId: 'Connector_Generic:Conn_02x08_Odd_Even',
    reference: 'J1', value: 'LABEL_DEMO', at: [65, 60], angle, fieldAngle: angle,
    referenceAt: angle === 0 ? [65, 38] : [88, 57],
    valueAt: angle === 0 ? [65, 40.5] : [88, 60] });
  for (const parity of [1, 2]) {
    const pins = Array.from({ length: 8 }, (_, i) => ({ pin: String(i * 2 + parity),
      net: ['EN', 'GPIO0', 'GPIO1', 'UART_TX', 'UART_RX', 'USB_DP', 'USB_DM', 'GPIO10'][i] + (parity === 2 ? '_B' : '') }));
    const p = sch.pin('J1', pins[0].pin);
    const direction = angle === 0 ? (p[0] < 65 ? 'left' : 'right') : (p[1] < 60 ? 'up' : 'down');
    const result = labelSide(sch, 'J1', direction, pins);
    if (result.warnings.length) throw new Error(JSON.stringify(result.warnings));
  }
  console.log(JSON.stringify({ id, ...sch.save(join(output, id)) }));
}

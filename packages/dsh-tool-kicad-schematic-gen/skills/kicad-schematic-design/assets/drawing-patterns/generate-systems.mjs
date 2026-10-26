/** Maintainer-only fixtures using the same KiCad library conventions as the original examples. */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDesignPlan } from '../../../../lib/builder.js';
import { Schematic, templateDir } from '../runtime.mjs';
import { place as mcuCrystal } from './mcu-external-crystal.mjs';
import { place as mcu } from './mcu-minimum.mjs';
import { place as usb } from './usb-c-device.mjs';
import { place as mosfet } from './mosfet-low-side.mjs';
import { place as swd } from './swd-header.mjs';
if (!process.argv[2]) throw new Error('Usage: node generate-systems.mjs <unused-output-root>');
const root = resolve(process.argv[2]);
if (existsSync(root)) throw new Error('Choose an unused output root');
mkdirSync(root, { recursive: true });
const planPath = join(root, 'drawing-maintenance-plan.md');
writeFileSync(planPath, '# Drawing reference maintenance plan\n\n## Scope\nGenerate MCU internal-clock and external-crystal, USB UFP connector, N-MOS inductive driver and project-specific SWD layout examples.\n\n## Constraints\nUse pinned official KiCad symbols, 50 mil electrical coordinates and verified pin roles. These are drawing fixtures; project-specific component selection and requirement confirmation remain required.\n');
const plan = readDesignPlan(planPath), designPlan = { path: plan.path, sha256: plan.sha256 };
const libraryPath = join(dirname(fileURLToPath(import.meta.url)), 'reference-symbols.kicad_sym');
const part = (name, pins, value = name, angle = 0) => ({ libraryPath, libId: `DrawingReference:${name}`, value, angle, pins });
const resistor = value => part('R', { top: '1', bottom: '2' }, value);
const capacitor = value => part('C', { top: '1', bottom: '2' }, value);
const fixtures = [
  ['mcu-minimum', mcu, {
    mcu: part('STM32F030F4Px', { supply: ['16', '5'], ground: ['15'],
      signals: { reset: '4', boot: '1', tx: '17', rx: '18', swdio: '19', swclk: '20' },
      unused: ['2', '3', '14', '6', '7', '8', '9', '10', '11', '12', '13'] }),
    decoupling: [capacitor('100n'), capacitor('100n')], resetResistor: resistor('R_RESET'),
    resetCapacitor: capacitor('C_RESET'), bootResistor: resistor('R_BOOT'),
  }, { mcu: 'U1', decoupling: ['C1', 'C2'], resetResistor: 'R1', resetCapacitor: 'C3', bootResistor: 'R2' },
  { supply: '+3V3', reset: 'NRST', boot: 'BOOT0', tx: 'UART_TX', rx: 'UART_RX', swdio: 'SWDIO', swclk: 'SWCLK' },
  { internalRcConfirmed: true, bootLowConfirmed: true }],
  ['usb-c-device', usb, {
    connector: part('USB_C_Receptacle_USB2.0_16P', { vbus: ['A4', 'A9', 'B4', 'B9'],
      ground: ['A1', 'A12', 'B1', 'B12'], shield: 'S1', cc1: 'A5', cc2: 'B5',
      dp: ['A6', 'B6'], dm: ['A7', 'B7'], unused: ['A8', 'B8'] }, 'USB_C_USB2'),
    rd: [resistor('5.1k 1%'), resistor('5.1k 1%')],
  }, { connector: 'J1', rd: ['R1', 'R2'] },
  { vbus: '+5V', cc1: 'USB_CC1', cc2: 'USB_CC2', dp: 'USB_DP', dm: 'USB_DM' },
  { ufpSinkConfirmed: true, shieldToGroundConfirmed: true }],
  ['mosfet-low-side', mosfet, {
    mosfet: part('Q_NMOS', { gate: 'G', drain: 'D', source: 'S' }, 'NMOS_SEL'),
    load: part('Conn_01x02', { supply: '1', low: '2' }, 'LOAD'),
    gateResistor: part('R', { left: '1', right: '2' }, 'R_GATE', 90), pulldown: resistor('R_PD'),
    diode: part('D_Schottky', { cathode: '1', anode: '2' }, 'D_SEL', 270),
  }, { mosfet: 'Q1', load: 'J1', gateResistor: 'R1', pulldown: 'R2', diode: 'D1' },
  { supply: '+5V', control: 'LOAD_EN', loadLow: 'LOAD_LOW' }, { inductiveLoadConfirmed: true }],
  ['swd-header', swd, { header: part('Conn_01x05', { vtref: '1', swdio: '2', ground: '3', swclk: '4', reset: '5' }, 'SWD_1x5') },
  { header: 'J1' }, { vtref: 'VTREF_3V3', swdio: 'SWDIO', ground: 'GND', swclk: 'SWCLK', reset: 'NRST' }, { pinoutConfirmed: true }],
];
// The two MCU fixtures share all non-clock circuitry and physical pin assignments.
const internal = fixtures[0], mcuPart = internal[2].mcu;
fixtures.splice(1, 0, ['mcu-external-crystal', mcuCrystal, {
  ...internal[2], mcu: { ...mcuPart, pins: { ...mcuPart.pins, oscillator: { input: '2', output: '3' },
    unused: mcuPart.pins.unused.filter(pin => pin !== '2' && pin !== '3') } },
  crystal: part('Crystal', { left: '1', right: '2' }, 'XTAL_SEL'),
  loadCapacitors: [capacitor('CL1_SEL'), capacitor('CL2_SEL')],
}, { ...internal[3], crystal: 'Y1', loadCapacitors: ['C4', 'C5'] }, { ...internal[4], oscillatorInput: 'OSC_IN', oscillatorOutput: 'OSC_OUT' },
{ externalCrystalConfirmed: true, bootLowConfirmed: true }]);
for (const [id, place, parts, references, nets, options] of fixtures) {
  const powers = { GND: 'DrawingReference:GND',
    ...(id.startsWith('mcu-') ? { '+3V3': 'DrawingReference:+3V3' } : {}),
    ...(id === 'usb-c-device' || id === 'mosfet-low-side' ? { '+5V': 'DrawingReference:+5V' } : {}) };
  const sch = new Schematic({ designPlan, projectName: id, title: id, paper: 'A4', templateDir, requiredPowerSymbols: powers });
  const region = sch.region({ name: id, description: 'Drawing fixture; confirm actual device requirements', origin: [25.4, 25.4], size: [190.5, 139.7] });
  const unit = place({ region, at: [10.16, 12.7], parts, references, nets: { ground: 'GND', ...nets }, ...options });
  unit.connect();
  const placements = sch.planPowerPlacements({ libraryPath, nets: powers });
  sch.replacePowerLabels({ libraryPath, nets: powers, placements: placements.placements });
  console.log(JSON.stringify({ id, ...sch.save(join(root, id)) }));
}

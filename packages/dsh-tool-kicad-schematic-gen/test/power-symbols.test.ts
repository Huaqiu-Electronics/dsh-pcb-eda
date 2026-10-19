import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Schematic } from '../src/schematic/builder.ts'
import { children, parse, value } from '../src/schematic/sexpr.ts'

const templateDir = fileURLToPath(new URL('../skills/kicad-schematic-design/templates', import.meta.url))
const power = (net: string) => `(symbol "${net}" (power)
 (property "Reference" "#PWR" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
 (property "Value" "${net}" (at 0 -2 0) (effects (font (size 1.27 1.27))))
 (symbol "${net}_0_1" (polyline (pts (xy -1 0) (xy 1 0)) (stroke (width 0.15) (type default)) (fill (type none))))
 (symbol "${net}_1_1" (pin power_in line (at 0 0 0) (length 0) hide
 (name "${net}" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`

async function fixture(run: (root: string, library: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-power-symbols-'))
  const library = join(root, 'power.kicad_sym')
  await writeFile(library, `(kicad_symbol_lib (version 20211014) (generator kicad_symbol_editor) ${power('GND')} ${power('+3V3')})`)
  try { await run(root, library) } finally { await rm(root, { recursive: true, force: true }) }
}
const build = (requiredPowerSymbols?: Record<string, string>) => new Schematic({
  projectName: 'power_delivery', title: 'Power delivery', paper: 'A4', templateDir, requiredPowerSymbols,
})

test('fresh UUIDs are selected by current module/net/coordinates on every build', async () => fixture(async (root, library) => {
  const original = build()
  original.addSymbol({ libraryPath: library, libId: 'power:GND', reference: '#PWR1', at: [20, 20] })
  original.label('GND', [30, 30]); original.label('+3V3', [40, 30]); original.label('AGND', [50, 30])
  const source = original.save(join(root, 'source')).schematicPath
  const results: Array<{ uuid: string; content: string }> = []
  for (let iteration = 0; iteration < 2; iteration++) {
    const sch = build({ GND: 'power:GND', '+3V3': 'power:+3V3' })
    const imported = sch.importModule({ sourcePath: source, name: 'core', offset: [10, 10], nets: { GND: 'GND', '+3V3': '+3V3' } })
    sch.frame({ name: 'core', description: 'Power', autoBounds: true, objectUuids: imported.objectUuids })
    const catalog = sch.powerLabelCatalog(['GND', '+3V3'])
    const target = catalog.filter(label => label.module === 'core' && label.net === 'GND'
      && Math.abs(label.at[0] - 40) < 0.001 && Math.abs(label.at[1] - 40) < 0.001)
    assert.equal(target.length, 1)
    const ground = target[0]!
    const copy = sch.powerLabelCatalog(['GND']); copy[0]!.at[0] = -999
    assert.equal(sch.powerLabelCatalog(['GND'])[0]!.at[0], 40)
    const converted = sch.replacePowerLabels({ libraryPath: library, nets: { GND: 'power:GND', '+3V3': 'power:+3V3' },
      placements: { [ground.uuid]: { at: [40, 45], angle: 0, valueAt: [40, 49] } } })
    assert.equal(converted.find(symbol => symbol.uuid === ground.uuid)?.at[1], 45)
    assert.equal(sch.powerLabelCatalog(['GND', '+3V3']).length, 0)
    assert.ok(sch.checkPowerSymbols().every(status => status.symbolCount > 0))
    const saved = sch.save(join(root, `run-${iteration}`))
    const content = await readFile(saved.schematicPath, 'utf8')
    const form = parse(content)
    assert.ok(children(form, 'wire').some(wire => {
      const pts = children(wire, 'pts')[0]!
      return children(pts, 'xy').some(xy => Number(value(xy)) === 40 && Number(value(xy, 2)) === 45)
    }))
    assert.ok(children(form, 'label').some(label => value(label) === 'core__AGND'))
    results.push({ uuid: ground.uuid, content })
  }
  assert.notEqual(results[0]!.uuid, results[1]!.uuid)
}))

test('required nets block render/save without writing when conversion is omitted or partial', async () => fixture(async (root, library) => {
  const sch = build({ GND: 'power:GND', '+3V3': 'power:+3V3' })
  sch.addSymbol({ libraryPath: library, libId: 'power:GND', reference: '#PWR1', at: [10, 10] })
  sch.label('GND', [20, 20]); sch.label('+3V3', [30, 20])
  assert.throws(() => sch.render(), /POWER_SYMBOLS_REQUIRED/)
  assert.throws(() => sch.save(join(root, 'rejected')), /POWER_SYMBOLS_REQUIRED/)
  assert.deepEqual(await readdir(root), ['power.kicad_sym'])
  sch.replacePowerLabels({ libraryPath: library, nets: { GND: 'power:GND' } })
  assert.throws(() => sch.checkPowerSymbols(), /\+3V3/)
  sch.replacePowerLabels({ libraryPath: library, nets: { '+3V3': 'power:+3V3' } })
  assert.ok(sch.checkPowerSymbols().every(status => !status.remainingLabelUuids.length))
  sch.label('GND', [40, 40])
  assert.throws(() => sch.save(join(root, 'reintroduced-label')), /unconverted labels/)
}))

test('stale placement UUIDs reject conversion without removing labels; legacy builds remain optional', async () => fixture(async (root, library) => {
  const sch = build()
  sch.addSymbol({ libraryPath: library, libId: 'power:GND', reference: '#PWR1', at: [10, 10] })
  const uuid = sch.label('GND', [20, 20])
  assert.throws(() => sch.replacePowerLabels({ libraryPath: library, nets: { GND: 'power:GND' },
    placements: { 'previous-build-uuid': { at: [20, 25] } } }), /does not select a mapped label/)
  assert.equal(sch.powerLabelCatalog(['GND'])[0]!.uuid, uuid)
  assert.deepEqual(sch.checkPowerSymbols(), [])
  sch.save(join(root, 'legacy'))
}))

test('a #PWR reference without an actual power definition cannot satisfy delivery', async () => fixture(async (root, library) => {
  const ordinaryLibrary = join(root, 'ordinary.kicad_sym')
  await writeFile(ordinaryLibrary, (await readFile(library, 'utf8')).replaceAll('(power)', ''))
  const required = { GND: 'power:GND' }
  const sch = build(required)
  // Requirements are copied: later mutation of the caller's map cannot disable them.
  delete (required as Partial<typeof required>).GND
  sch.addSymbol({ libraryPath: ordinaryLibrary, libId: 'power:GND', reference: '#PWR1', at: [10, 10] })
  assert.throws(() => sch.checkPowerSymbols(), /GND: 0 power symbols/)
}))

test('catalog includes global and flattened port labels while excluding unrelated nets', async () => fixture(async (root, library) => {
  const original = build()
  original.addSymbol({ libraryPath: library, libId: 'power:GND', reference: '#PWR1', at: [10, 10] })
  const source = original.save(join(root, 'source')).schematicPath
  const text = await readFile(source, 'utf8')
  const rootForm = parse(text)
  const extra = `
    (global_label "GND" (shape input) (at 20 30 90) (effects (font (size 1.27 1.27))) (uuid "global-ground"))
    (hierarchical_label "GND" (shape input) (at 40 30 0) (effects (font (size 1.27 1.27))) (uuid "hier-ground"))
    (label "AGND" (at 50 30 0) (effects (font (size 1.27 1.27))) (uuid "analog-ground"))
  `
  await writeFile(source, `${text.slice(0, rootForm.end - 1)}${extra}${text.slice(rootForm.end - 1)}`)
  const sch = build()
  sch.importModule({ sourcePath: source, name: 'global_module', offset: [5, 5], nets: { GND: 'GND' } })
  const labels = sch.powerLabelCatalog(['GND'])
  // importModule deliberately flattens hierarchical ports to local labels first.
  assert.equal(labels.length, 2)
  const global = labels.find(label => label.type === 'global_label')!
  assert.equal(global.module, 'global_module')
  assert.deepEqual(global.at, [25, 35]); assert.equal(global.angle, 90)
  assert.ok(labels.every(label => label.net === 'GND'))
}))

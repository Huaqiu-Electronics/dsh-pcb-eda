import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, symlink,rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,basename,dirname } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { importComponent } from '../src/components/import-component.ts'
import { partIdentity } from '../src/components/identity.ts'
import { Schematic } from '../src/schematic/builder.ts'

const symbol = `(kicad_symbol_lib (version 20211014) (generator kicad_symbol_editor)
 (symbol "Demo" (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
 (symbol "Demo_1_1" (pin input line (at 0 0 0) (length 2.54)
 (name "IN" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))))`
const footprint = `(footprint "Demo_Package" (version 20240108) (generator pcbnew) (layer "F.Cu")
 (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))`
const options = { requestTimeoutMs: 1000, maxModelBytes: 10000 }

async function fixture(fn: (root: string, run: (fp?: string, missing?: boolean) => ReturnType<typeof importComponent>) => Promise<void>, symbolSource = symbol) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-component-'))
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  try {
    const run = (fp = footprint, missing = false) => {
      const fetcher = (async (url: URL | RequestInfo) => String(url).endsWith('/productDetail')
        ? new Response(JSON.stringify({ code: 200000, result: { mpn: 'Demo', cadUrlList: [
          { type: 'symbol', fileUrl: 'https://example.test/Demo.kicad_sym' },
          ...missing ? [] : [{ type: 'footprint', fileUrl: 'https://example.test/Demo.kicad_mod' }],
        ] } }))
        : new Response(String(url).endsWith('.kicad_sym') ? symbolSource : fp)) as typeof fetch
      return importComponent('7189', 'Demo', root, root, options, ctx.fs, undefined, new AbortController().signal, fetcher)
    }
    await fn(root, run)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
}

test('common-only import preserves pin/pad association, places unit 1 and repeats safely', async () => fixture(async (root, run) => {
  const result = await run()
  assert.equal(result.builderCompatibility.normalization, 'common_only_to_unit_1')
  assert.equal(result.validation.pinPadMatch, 'number_sets_match')
  const text = await readFile(result.libraryPath, 'utf8')
  assert.ok(text.includes('Demo_1_1')); assert.ok(!text.includes('Demo_0_1'))
  const sch = new Schematic({ projectName: 'common', title: 'Common', paper: 'A4', templateDir: join(process.cwd(), 'packages/dsh-tool-kicad-schematic-gen/skills/kicad-schematic-design/templates') })
  sch.addSymbol({ libraryPath: result.libraryPath, libId: result.libId, footprint: result.footprintId, reference: 'U1', at: [50, 50] })
  assert.deepEqual(sch.pin('U1', '1'), [50, 50])
  sch.save(root)
  const second = await run()
  assert.equal(second.library, 'existing'); assert.equal(second.footprintLibrary, 'existing')
  await assert.rejects(run(footprint.replace('(pad "1"', '(pad "2"')), /PIN_PAD_MISMATCH/)
}, symbol.replaceAll('Demo_1_1', 'Demo_0_1')))

test('unsupported unit error identifies part, sections and source before writing', async () => fixture(async (root, run) => {
  await assert.rejects(run(), /SYMBOL_UNITS_UNSUPPORTED: 7189:Demo; symbol Demo; sections \[Demo_1_2\]; source https:/)
  assert.deepEqual(await readdir(root), [])
}, symbol.replaceAll('Demo_1_1', 'Demo_1_2')))

test('manufacturer_id and legacy mfgId agree; conflicting or invalid identities fail', () => {
  assert.deepEqual(partIdentity({ manufacturer_id: '7189', mpn: ' Demo ' }), { mfgId: '7189', mpn: 'Demo' })
  assert.deepEqual(partIdentity({ mfgId: '7189', mpn: 'Demo' }), { mfgId: '7189', mpn: 'Demo' })
  assert.throws(() => partIdentity({ manufacturer_id: '1', mfgId: '2', mpn: 'Demo' }), /same manufacturer/)
  assert.throws(() => partIdentity({ manufacturer_id: 'invalid', mpn: 'Demo' }), /digits/)
})

test('imports both libraries, preserves table entries, returns association and is idempotent', async () => fixture(async (root, run) => {
  await writeFile(join(root, 'fp-lib-table'), '(fp_lib_table (version 7) (lib (name "Other")(type "KiCad")(uri "Other.pretty")(options "")(descr "")))\n')
  const result = await run()
  assert.equal(result.hasSymbol, true); assert.equal(result.hasFootprint, true)
  assert.equal(dirname(result.libraryPath),join(root,'libraries','symbols'))
  assert.equal(dirname(dirname(result.footprintPath)),join(root,'libraries','footprints'))
  assert.equal(result.validation.pinPadMatch, 'number_sets_match')
  assert.equal(await readFile(result.footprintPath, 'utf8'), `${footprint}\n`)
  const table = await readFile(result.footprintTablePath, 'utf8')
  assert.ok(table.includes('Other.pretty')); assert.ok(table.includes('${KIPRJMOD}/libraries/footprints/DSH_7189_Demo_8a2cc0673b1c.pretty'))
  const sch = new Schematic({ projectName: 'paired', title: 'Paired', paper: 'A4', templateDir: join(process.cwd(), 'packages/dsh-tool-kicad-schematic-gen/skills/kicad-schematic-design/templates') })
  sch.addSymbol({ libraryPath: result.libraryPath, libId: result.libId, footprint: result.footprintId, reference: 'U1', at: [50, 50] })
  const saved = sch.save(root)
  assert.ok((await readFile(saved.schematicPath, 'utf8')).includes(`(property "Footprint" "${result.footprintId}"`))
  const second = await run()
  assert.equal(second.footprintLibrary, 'existing'); assert.equal(second.footprintTable, 'existing')
}))

test('existing root-level libraries are reused rather than duplicated after the layout change',async()=>fixture(async(root,run)=>{
 const first=await run();
 const symbol=join(root,basename(first.libraryPath)),footprintDir=join(root,basename(dirname(first.footprintPath)));
 await rename(first.libraryPath,symbol);await rename(dirname(first.footprintPath),footprintDir);
 for(const [file,prefix] of [[first.tablePath,'libraries/symbols/'],[first.footprintTablePath,'libraries/footprints/']] as const){
  await writeFile(file,(await readFile(file,'utf8')).replace(prefix,''));
 }
 const second=await run();
 assert.equal(second.libraryPath,symbol);assert.equal(dirname(second.footprintPath),footprintDir);
 assert.equal(second.library,'existing');assert.equal(second.footprintLibrary,'existing');
 assert.deepEqual(await readdir(join(root,'libraries','symbols')),[]);
 assert.deepEqual(await readdir(join(root,'libraries','footprints')),[]);
}))

test('missing or invalid footprint and mismatching numbered pads write nothing', async () => fixture(async (root, run) => {
  await assert.rejects(run(footprint, true), /MODELS_REQUIRED/)
  await assert.rejects(run('<html>error</html>'), /KiCad/)
  await assert.rejects(run(footprint.replace('(pad "1"', '(pad "2"')), /PIN_PAD_MISMATCH/)
  await assert.rejects(run(footprint.replace('Demo_Package', '../outside')), /safe local filename/)
  assert.deepEqual(await readdir(root), [])
}))

test('different footprint and conflicting table registration are never overwritten', async () => fixture(async (root, run) => {
  const first = await run()
  await writeFile(first.footprintPath, 'different')
  await assert.rejects(run(), /different content/)
  assert.equal(await readFile(first.footprintPath, 'utf8'), 'different')
  await writeFile(first.footprintPath, `${footprint}\n`)
  await writeFile(first.footprintTablePath, '(fp_lib_table (lib (name "DSH_7189_Demo_8a2cc0673b1c")(type "KiCad")(uri "wrong.pretty")(options "")))')
  await assert.rejects(run(), /conflicting registration/)
}))

test('footprint directory junction outside project is rejected before writes', async () => fixture(async (root, run) => {
  const outside = await mkdtemp(join(tmpdir(), 'dsh-footprint-outside-'))
  try {
    await symlink(outside, join(root, 'DSH_7189_Demo_8a2cc0673b1c.pretty'), 'junction')
    await assert.rejects(run(), /inside projectDir/)
    assert.deepEqual(await readdir(outside), [])
    assert.deepEqual(await readdir(root), ['DSH_7189_Demo_8a2cc0673b1c.pretty'])
  } finally { await rm(outside, { recursive: true, force: true }) }
}))

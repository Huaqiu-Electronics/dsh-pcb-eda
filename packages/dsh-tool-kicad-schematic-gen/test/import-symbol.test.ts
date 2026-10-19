import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { importSymbol } from '../src/components/import-symbol.ts'
import type { ModelFetchOptions } from '../src/components/models.ts'

const options: ModelFetchOptions = {
  requestTimeoutMs: 1000,
  maxModelBytes: 10000,
}

const symbol = `(kicad_symbol_lib (version 20211014) (generator kicad_symbol_editor)
  (symbol "Demo" (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "Demo_1_1" (pin input line (at 0 0 0) (length 2.54)
      (name "IN" (effects (font (size 1.27 1.27))))
      (number "1" (effects (font (size 1.27 1.27))))))))`

const fetcher = (async (url: URL | RequestInfo) => String(url).endsWith('/productDetail')
  ? new Response(JSON.stringify({ code: 200000, result: { mpn: 'Demo', cadUrlList: [
    { type: 'symbol', fileUrl: 'https://example.test/Demo.kicad_sym' },
  ] } }), { headers: { 'Content-Type': 'application/json' } })
  : new Response(symbol)) as typeof fetch

let root: string
let ctx: Context
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-kicad-import-'))
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

const run = (projectDir?: string) => importSymbol('7189', 'Demo', projectDir, root,
  options, ctx.fs, undefined, new AbortController().signal, fetcher)

test('creates a project-local Symbol library and registers it without replacing other entries', async () => {
  const project = join(root, 'project')
  await mkdir(project)
  const existing = '(sym_lib_table\n  (version 7)\n  (lib (name "Existing")(type "KiCad")(uri "${KIPRJMOD}/Existing.kicad_sym")(options "")(descr ""))\n)\n'
  await writeFile(join(project, 'sym-lib-table'), existing)

  const result = await run(project)
  assert.equal(result.part, '7189:Demo')
  assert.equal(result.libId, 'DSH_7189_Demo_8a2cc0673b1c:Demo')
  assert.equal(result.pinCount, 1)
  assert.equal(result.builderCompatibility.status, 'ready')
  assert.deepEqual(result.builderCompatibility.availableUnits, [1])
  assert.equal(result.library, 'created')
  assert.equal(result.table, 'updated')
  assert.equal(await readFile(result.libraryPath, 'utf8'), `${symbol}\n`)
  const table = await readFile(result.tablePath, 'utf8')
  assert.ok(table.includes(existing.trim().split('\n')[2]!))
  assert.ok(table.includes(`(name "${result.libId.split(':')[0]}")`))
  assert.ok(table.includes(`\${KIPRJMOD}/libraries/symbols/${result.libId.split(':')[0]}.kicad_sym`))

  const second = await run(project)
  assert.equal(second.library, 'existing')
  assert.equal(second.table, 'existing')
  assert.equal(await readFile(result.tablePath, 'utf8'), table)
})

test('rejects a different existing library without overwriting it', async () => {
  const first = await run()
  await writeFile(first.libraryPath, 'different\n')
  await assert.rejects(run(), /already exists with different content/)
  assert.equal(await readFile(first.libraryPath, 'utf8'), 'different\n')
})

test('rejects destinations outside the session workspace', async () => {
  await assert.rejects(run(join(root, '..')), /inside the current session workspace/)
})

test('rejects a malformed existing library table before creating a library', async () => {
  await writeFile(join(root, 'sym-lib-table'), '(sym_lib_table\n  (lib')
  await assert.rejects(run(), /unbalanced or trailing content/)
  const files = await import('node:fs/promises').then(fs => fs.readdir(root))
  assert.deepEqual(files, ['sym-lib-table'])
})

test('rejects a conflicting library-table registration before creating a library', async () => {
  const nickname = 'DSH_7189_Demo_8a2cc0673b1c'
  const existing = `(sym_lib_table\n  (version 7)\n  (lib (name "${nickname}")(type "KiCad")(uri "other.kicad_sym")(options "")(descr ""))\n)\n`
  await writeFile(join(root, 'sym-lib-table'), existing)
  await assert.rejects(run(), /already defines .* with different metadata/)
  assert.equal(await readFile(join(root, 'sym-lib-table'), 'utf8'), existing)
  const files = await import('node:fs/promises').then(fs => fs.readdir(root))
  assert.deepEqual(files, ['sym-lib-table'])
})

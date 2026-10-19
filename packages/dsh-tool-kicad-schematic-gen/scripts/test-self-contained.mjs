import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {pdfFixture} from '../test/pdf-fixture.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const isolated = await mkdtemp(join(tmpdir(), 'schematic-bundle-'))
try {
  // A fresh Node process outside the repo cannot resolve workspace dependencies.
  await cp(join(root, 'lib'), join(isolated, 'lib'), {recursive: true})
  await cp(join(root, 'skills'), join(isolated, 'skills'), {recursive: true})
  await writeFile(join(isolated, 'package.json'), '{"type":"module"}')
  await writeFile(join(isolated, 'fixture.pdf'), pdfFixture())
  const output = await readFile(join(isolated, 'lib/index.js'), 'utf8')
  assert.doesNotMatch(output, /(?:from\s*|import\s*\(|require\s*\()\s*['"]kicad-sexpr-parser['"]/)
  await writeFile(join(isolated, 'smoke.mjs'), `
    import assert from 'node:assert/strict'
    import {readFile} from 'node:fs/promises'
    import {createRequire} from 'node:module'
    import {apply} from './lib/index.js'
    import * as builder from './lib/builder.js'
    const require = createRequire(new URL('./lib/index.js', import.meta.url))
    assert.throws(() => require.resolve('kicad-sexpr-parser'), {code: 'MODULE_NOT_FOUND'})
    const tools = new Map()
    let provider
    apply({effect: fn => fn(), tools: {register: t => {tools.set(t.name, t); return () => {}}},
      skills: {registerProvider: fn => {provider = fn(); return () => {}}}, get: () => undefined})
    assert.ok(tools.has('get_kicad_component_models'))
    assert.ok((await provider.list()).length)
    assert.ok(Object.keys(builder).length)
    const sharp = require('sharp')
    const image = await sharp(Buffer.from('<svg width="10" height="10"><rect width="10" height="10" fill="red"/></svg>')).png().toBuffer()
    assert.equal((await sharp(image).metadata()).width, 10)
    const {getDocument, GlobalWorkerOptions} = await import('./lib/node_modules/pdfjs-dist/legacy/build/pdf.mjs')
    GlobalWorkerOptions.workerSrc = new URL('./lib/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href
    class BinaryDataFactory {
      constructor({standardFontDataUrl}) { this.root = standardFontDataUrl }
      async fetch({filename}) { return new Uint8Array(await readFile(new URL(filename, this.root))) }
    }
    const loading = getDocument({data: new Uint8Array(await readFile(new URL('./fixture.pdf', import.meta.url))),
      standardFontDataUrl: new URL('./lib/node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href,
      BinaryDataFactory, useWorkerFetch: false})
    try {
      const pdf = await loading.promise
      const text = await (await pdf.getPage(1)).getTextContent()
      assert.match(text.items.map(item => item.str ?? '').join(' '), /Selectable PDF text/)
    } finally { await loading.destroy() }
    console.log('Isolated bundle: plugin registration, builder, sharp PNG, PDF worker/text passed')
  `)
  const env = {...process.env}
  delete env.NODE_PATH
  delete env.NODE_OPTIONS
  console.log(execFileSync(process.execPath, ['smoke.mjs'], {
    cwd: isolated, env, encoding: 'utf8', timeout: 60000, windowsHide: true,
  }).trim())
} finally {
  // Only remove the unique temporary directory created by this invocation.
  assert.ok(isolated.startsWith(join(tmpdir(), 'schematic-bundle-')))
  await rm(isolated, {recursive: true, force: true})
}

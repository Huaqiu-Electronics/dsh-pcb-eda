// Preserve package-relative native binaries, workers, fonts, and WASM files.
import {cp, mkdir, readFile, realpath} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const destinations = new Map()
async function locate(name, from) {
  const require = createRequire(join(from, 'package.json'))
  // Inspect search directories so restrictive package exports cannot hide the
  // manifest of a native package (e.g. @img/sharp-win32-x64).
  for (const directory of require.resolve.paths(name) ?? []) {
    try {
      const source = join(directory, name)
      await readFile(join(source, 'package.json'))
      return await realpath(source)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}
async function vendor(name, from) {
  const source = await locate(name, from)
  if (!source) throw new Error(`Cannot locate ${name} from ${from}`)
  const existing = destinations.get(name)
  if (existing) {
    if (existing !== source) throw new Error(`Conflicting runtime dependency versions: ${name}`)
    return
  }
  destinations.set(name, source)
  const destination = join(root, 'lib/node_modules', name)
  await mkdir(dirname(destination), {recursive: true})
  await cp(source, destination, {recursive: true, dereference: true,
    filter: path => path === source || !path.slice(source.length + 1).split(/[\\/]/).includes('node_modules')})
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  for (const dependency of Object.keys(manifest.dependencies ?? {})) await vendor(dependency, source)
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
    // Only ship optional platform packages installed on this build platform.
    if (!await locate(dependency, source)) continue
    await vendor(dependency, source)
  }
}
await vendor('sharp', root)
await vendor('pdfjs-dist', root)
console.log(`Vendored ${destinations.size} runtime packages for ${process.platform}/${process.arch}`)

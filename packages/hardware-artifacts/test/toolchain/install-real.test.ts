/**
 * The whole install pipeline against a *real* distribution archive.
 *
 * Skipped by default: it needs the actual vendor zip, which cannot live in the
 * repository. Point `HUAQIU_TOOLCHAIN_ZIP` at one or more `tool=path` pairs:
 *
 * ```
 * $env:HUAQIU_TOOLCHAIN_ZIP = 'solidcraft=C:\hardware-toolchains\solidcraft-0.49.1-windows-x64-portable.zip'
 * pnpm --filter @huaqiu/hardware-artifacts exec vitest run test/toolchain/install-real.test.ts
 * ```
 *
 * Why it earns its keep: the decoders are verified entry-by-entry elsewhere, but
 * checksum → extract → layout → promote → validate only proves itself on a real
 * archive — the real 99k-entry ZIP64 central directory, the vendor's own nesting
 * (or lack of it), and the executables the promoted tree actually has to resolve.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { ToolchainInstaller } from '../../src/toolchain/install.js'
import { resolveToolchain } from '../../src/toolchain/resolve.js'

interface Target {
  readonly tool: 'kicad' | 'solidcraft'
  readonly path: string
}

/** `tool=path` pairs from the environment; archives that are not on disk are skipped. */
function targets(): Target[] {
  const raw = process.env.HUAQIU_TOOLCHAIN_ZIP ?? ''
  return raw
    .split(',')
    .map(pair => pair.trim())
    .filter(pair => pair !== '')
    .map((pair) => {
      const at = pair.indexOf('=')
      return { tool: pair.slice(0, at) as Target['tool'], path: pair.slice(at + 1) }
    })
    .filter(target => (target.tool === 'kicad' || target.tool === 'solidcraft') && existsSync(target.path))
}

/** SHA-256 of the archive, computed here so the checksum stage is honestly exercised. */
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

const cases = targets()

describe.skipIf(cases.length === 0)('real archive install', () => {
  let scratch = ''

  afterAll(async () => {
    if (scratch !== '') await rm(scratch, { recursive: true, force: true })
  }, 300_000)

  for (const target of cases) {
    it(`installs ${target.tool} from ${basename(target.path)}`, async () => {
      scratch = await mkdtemp(join(tmpdir(), 'hardware-install-real-'))
      const identity = await stat(target.path)
      const sha256 = await digest(target.path)
      const installer = new ToolchainInstaller({
        root: scratch,
        idleTimeoutMs: 60_000,
        // Stream the local archive where the download would have come from, so
        // every stage after the transfer runs unmodified — checksum included.
        fetchImpl: (async () => new Response(
          Readable.toWeb(createReadStream(target.path)) as ReadableStream<Uint8Array>,
          { headers: { 'content-length': String(identity.size) } },
        )) as unknown as typeof fetch,
      })
      const entry = {
        version: '10.0.7-2',
        platform: 'win',
        arch: 'x64',
        url: `https://example.test/${basename(target.path)}`,
        sha256,
      }
      const phases: string[] = []
      const job = installer.start(target.tool, entry, {
        validate: async installPath => {
          // The manager probes the real CLI; the test supplies the version it
          // would have printed, so the check is the layout, not the spawn.
          const resolution = resolveToolchain(target.tool, installPath, {
            platform: 'win32',
            probeVersion: () => '10.0.7',
          })
          return resolution.configured ? { ok: true } : { ok: false, error: resolution.error ?? 'not configured' }
        },
        onProgress: snapshot => { phases.push(snapshot.phase) },
      })
      expect(['download', 'verify', 'extract']).toContain(job.snapshot.phase)
      const outcome = await job.done
      expect({ code: outcome.errorCode, message: outcome.error }).toEqual({ code: undefined, message: undefined })
      expect(outcome.ok).toBe(true)
      const installPath = outcome.installPath as string
      const promoted = await readdir(installPath, { withFileTypes: true })
      // The distribution's own top level, not a single extracted executable: the
      // KiCad archive keeps `bin`, `etc`, `lib`, `share` side by side.
      expect(promoted.length).toBeGreaterThanOrEqual(2)
      const executable = target.tool === 'kicad' ? join('bin', 'kicad-cli.exe') : 'solidcraft-cli.exe'
      expect(existsSync(join(installPath, executable))).toBe(true)
      // It reached the last stage before declaring success.
      expect(phases.at(-1)).toBe('done')
      expect(phases[0]).toBe('download')
    }, 900_000)
  }
})

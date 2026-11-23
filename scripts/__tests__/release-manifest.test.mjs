/**
 * Tests for the manually invoked canonical-catalog release command.
 * Network calls are injected, so no npm publish/registry access is performed.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../utils/packages.mjs'
import {
  MANIFEST_PACKAGE,
  buildCandidateCatalog,
  buildEdgeHeadlessCatalog,
  fetchCatalogFromCdn,
  isSemver,
  loadPublishedCatalog,
  nextManifestVersion,
  parseArgs,
  readCandidatesFile,
  resolveCanonicalVersion,
  resolveCatalogWriteVersion,
  resolveStandaloneVersions,
  standaloneNames,
  validateCandidateCatalog,
  verifyArtifact,
} from '../release-manifest.mjs'

/** Fetch stub keyed by URL substring. */
const fetchFrom = (routes) => async (url) => {
  const key = Object.keys(routes).find((k) => String(url).includes(k))
  if (!key) return new Response('not found', { status: 404 })
  const value = routes[key]
  if (value instanceof Response) return value
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200 })
}

const previous = () => ({
  schemaVersion: 2,
  manifestPackageVersion: '1.0.0',
  pluginSetVersion: '0.6.29',
  release: { publishedAt: '2026-11-16T00:00:00.000Z' },
  plugins: {
    '@huaqiu/dsh-auth': { version: '0.6.29', hosts: ['all'], requiresHqEdge: false },
    '@huaqiu/dsh-kicad-drc': { version: '0.6.28', hosts: ['kicad'], requiresHqEdge: false },
  },
})

describe('release-manifest argument and version helpers', () => {
  it('dry-runs by default; --publish opts in', () => {
    const dry = parseArgs(['--candidate', '@huaqiu/dsh-auth@0.6.30'])
    assert.equal(dry.dryRun, true)
    assert.equal(dry.publish, false)
    assert.equal(dry.candidates['@huaqiu/dsh-auth'], '0.6.30')
    assert.equal(parseArgs(['--publish']).publish, true)
  })

  it('bumps the manifest package patch version independently of plugin versions', () => {
    assert.equal(nextManifestVersion('1.0.0'), '1.0.1')
    assert.equal(nextManifestVersion('2.3.9'), '2.3.10')
    assert.equal(isSemver('0.6.29'), true)
    assert.equal(isSemver('latest'), false)
  })

  it('uses the lockstep local package version for the next immutable catalog', () => {
    assert.equal(
      resolveCatalogWriteVersion({ localVersion: '0.6.30', publishedVersion: '0.6.29' }),
      '0.6.30',
    )
    assert.equal(
      resolveCatalogWriteVersion({ localVersion: '0.6.30', publishedVersion: '0.6.30', bootstrap: true }),
      '0.6.30',
    )
  })

  it('rejects a local catalog version npm would refuse to republish', () => {
    assert.throws(
      () => resolveCatalogWriteVersion({ localVersion: '0.6.30', publishedVersion: '0.6.31' }),
      /run pnpm bump first/,
    )
  })

  it('keeps CLI candidates when no candidates file is supplied', () => {
    const fromCli = readCandidatesFile(undefined, { '@huaqiu/dsh-auth': '0.6.30' })
    assert.deepEqual(fromCli.candidates, { '@huaqiu/dsh-auth': '0.6.30' })
    assert.equal(fromCli.setVersion, undefined)
    assert.equal(fromCli.edgeHeadlessCatalog, undefined)
  })
})

describe('canonical version resolution', () => {
  it('uses the primary registry dist-tags endpoint', async () => {
    const result = await resolveCanonicalVersion({
      fetchImpl: fetchFrom({
        'registry.npmjs.org/-/package': { latest: '1.0.0' },
      }),
      registry: 'https://registry.npmjs.org',
      mirror: 'https://registry.npmmirror.com',
    })
    assert.equal(result.version, '1.0.0')
    assert.match(result.source, /registry\.npmjs\.org/)
  })

  it('falls back to the configured metadata mirror', async () => {
    const calls = []
    const fetchImpl = async (url) => {
      calls.push(String(url))
      if (String(url).includes('npmmirror')) return new Response(JSON.stringify({ latest: '1.2.3' }))
      return new Response('offline', { status: 503 })
    }
    const result = await resolveCanonicalVersion({
      fetchImpl,
      registry: 'https://primary.invalid',
      mirror: 'https://npmmirror.invalid',
    })
    assert.equal(result.version, '1.2.3')
    assert.match(result.source, /npmmirror\.invalid/)
    assert.equal(calls.length, 2)
  })

  it('rejects a non-semver latest from every metadata endpoint', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ latest: 'bad' }))
    await assert.rejects(
      resolveCanonicalVersion({ fetchImpl, registry: 'https://primary.invalid', mirror: 'https://npmmirror.invalid' }),
      /cannot resolve canonical manifest version/,
    )
  })

  it('supports bootstrap when neither registry is reachable', async () => {
    const result = await resolveCanonicalVersion({
      fetchImpl: async () => { throw new Error('offline') },
      bootstrapVersion: '1.0.0',
    })
    assert.deepEqual(result, { version: '1.0.0', source: 'bootstrap' })
  })
})

describe('exact-version delivery', () => {
  it('builds an exact-version URL (never a latest alias)', async () => {
    let seen = ''
    const fetchImpl = async (url) => {
      seen = String(url)
      return new Response(JSON.stringify({ manifestPackageVersion: '1.0.0' }))
    }
    await fetchCatalogFromCdn({ fetchImpl, base: 'https://cdn.jsdelivr.net/npm', version: '1.0.0' })
    assert.equal(seen, `https://cdn.jsdelivr.net/npm/${MANIFEST_PACKAGE}@1.0.0/plugins-release-manifest.json`)
  })

  it('rejects a delivery endpoint serving an older manifest version', async () => {
    const routes = {}
    for (const base of ['https://cdn.jsdelivr.net/npm', 'https://fastly.jsdelivr.net/npm']) {
      routes[base] = { manifestPackageVersion: '0.9.0' }
    }
    await assert.rejects(
      loadPublishedCatalog({
        fetchImpl: fetchFrom(routes),
        version: '1.0.0',
        loadFromTarball: async () => { throw new Error('no tarball') },
      }),
      /version mismatch/,
    )
  })

  it('accepts the first endpoint serving the exact version', async () => {
    const result = await loadPublishedCatalog({
      fetchImpl: fetchFrom({
        'cdn.jsdelivr.net/npm': { manifestPackageVersion: '1.0.0', schemaVersion: 2 },
      }),
      version: '1.0.0',
      loadFromTarball: async () => { throw new Error('unused') },
    })
    assert.equal(result.source, 'jsdelivr')
    assert.equal(result.catalog.schemaVersion, 2)
  })
})

describe('standalone versions and artifact verification', () => {
  it('resolves standalone plugin versions from npm dist-tags', async () => {
    const versions = await resolveStandaloneVersions({
      fetchImpl: fetchFrom({
        'dsh-kicad-drc': { latest: '0.6.29' },
        'dsh-tool-freerouting': { latest: '0.6.15' },
      }),
      names: ['@huaqiu/dsh-kicad-drc', '@huaqiu/dsh-tool-freerouting'],
    })
    assert.deepEqual(versions, {
      '@huaqiu/dsh-kicad-drc': '0.6.29',
      '@huaqiu/dsh-tool-freerouting': '0.6.15',
    })
  })

  it('verifies a tarball against sha512 integrity', async () => {
    const bytes = Buffer.from('plugin tarball bytes')
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    const fetchImpl = async (url) => {
      const u = String(url)
      if (u.includes('registry.npmjs.org/@huaqiu/dsh-auth/0.6.30')) {
        return new Response(JSON.stringify({ dist: { tarball: 'https://registry.npmjs.org/tarball.tgz', integrity } }))
      }
      if (u.includes('tarball.tgz')) return new Response(bytes)
      return new Response('no', { status: 404 })
    }
    const result = await verifyArtifact({ fetchImpl, name: '@huaqiu/dsh-auth', version: '0.6.30' })
    assert.equal(result.ok, true)

    const corrupted = await verifyArtifact({
      fetchImpl: async (url) => {
        const u = String(url)
        if (u.endsWith('/0.6.30')) {
          return new Response(JSON.stringify({ dist: { tarball: 'https://registry.npmjs.org/tarball.tgz', integrity } }))
        }
        return new Response(Buffer.from('different bytes'))
      },
      name: '@huaqiu/dsh-auth',
      version: '0.6.30',
      mirror: 'https://nowhere.invalid',
    })
    assert.equal(corrupted.ok, false)
    assert.match(corrupted.error, /sha512 mismatch/)
  })
})

describe('catalog merge', () => {
  it('preserves existing entries, refreshes standalone versions and stamps the manifest version', () => {
    const merged = buildCandidateCatalog({
      previous: previous(),
      candidates: { '@huaqiu/dsh-auth': '0.6.30' },
      standaloneVersions: { '@huaqiu/dsh-kicad-drc': '0.6.29' },
      setVersion: '0.6.30',
      manifestVersion: '1.0.1',
      publishedAt: '2026-11-16T12:00:00.000Z',
    })
    assert.equal(merged.manifestPackageVersion, '1.0.1')
    assert.equal(merged.release.publishedAt, '2026-11-16T12:00:00.000Z')
    assert.equal(merged.pluginSetVersion, '0.6.30')
    assert.equal(merged.plugins['@huaqiu/dsh-auth'].version, '0.6.30')
    assert.equal(merged.plugins['@huaqiu/dsh-kicad-drc'].version, '0.6.29')
    assert.equal(merged.plugins['@huaqiu/dsh-kicad-drc'].hosts[0], 'kicad')
    assert.equal(previous().plugins['@huaqiu/dsh-auth'].version, '0.6.29', 'previous must not be mutated')
  })

  it('keeps the previous set version when candidates are not lockstep and no explicit set version is given', () => {
    const merged = buildCandidateCatalog({
      previous: previous(),
      candidates: { '@huaqiu/dsh-auth': '0.6.30', '@huaqiu/dsh-analytics': '0.6.31' },
      manifestVersion: '1.0.1',
    })
    assert.equal(merged.pluginSetVersion, '0.6.29')
  })
})

describe('catalog visibility', () => {
  const realCatalog = () => JSON.parse(readFileSync(
    join(repoRoot, 'release-manifest/plugins-release-manifest.json'), 'utf8',
  ))

  it('treats only catalog entries with no workspace source as standalone', () => {
    // Internal Hardware Engineering packages DO have workspace sources, so
    // they must never be resolved from npm as standalone plugins.
    assert.deepEqual(standaloneNames({ plugins: {
      '@huaqiu/dsh-kicad-drc': {},
      '@huaqiu/dsh-tool-freerouting': {},
      '@huaqiu/dsh-auth': {},
      '@huaqiu/hardware-artifacts': {},
      '@huaqiu/dsh-hardware-ui': {},
    } }), ['@huaqiu/dsh-kicad-drc', '@huaqiu/dsh-tool-freerouting'])
  })

  it('validates the checked-in catalog against the explicit allowlist', () => {
    assert.deepEqual(validateCandidateCatalog(realCatalog()), [])
  })

  it('rejects a candidate catalog that adds an internal-only plugin', () => {
    const catalog = realCatalog()
    catalog.plugins['@huaqiu/dsh-hardware-ui'] = {
      version: catalog.pluginSetVersion, hosts: ['all'], requiresHqEdge: false,
    }
    const failures = validateCandidateCatalog(catalog)
    assert.ok(failures.some((f) => f.includes('internal plugin must not be listed')), failures.join('\n'))
  })
})

describe('edge-headless catalog merge', () => {
  const edgePrevious = () => ({
    schemaVersion: 2,
    manifestPackageVersion: '1.0.0',
    releases: [
      {
        version: '0.3.10',
        sha256: 'a'.repeat(64),
        platform: 'win',
        arch: 'x64',
        url: 'https://down.eda.cn/hq-edge/0.3.10/old.zip',
      },
    ],
  })

  it('preserves releases when no runtime candidate is supplied and stamps the package version', () => {
    const merged = buildEdgeHeadlessCatalog({
      previous: edgePrevious(),
      manifestVersion: '1.0.1',
    })
    assert.equal(merged.manifestPackageVersion, '1.0.1')
    assert.equal(merged.releases.length, 1)
    assert.equal(merged.releases[0].version, '0.3.10')
  })

  it('replaces releases from an explicit runtime catalog and validates them', () => {
    const merged = buildEdgeHeadlessCatalog({
      previous: edgePrevious(),
      catalogInput: {
        releases: [
          {
            version: '0.3.11',
            sha256: 'b'.repeat(64),
            platform: 'darwin',
            arch: 'arm64',
            url: 'https://down.eda.cn/hq-edge/0.3.11/new.zip',
          },
        ],
      },
      manifestVersion: '1.0.1',
    })
    assert.equal(merged.releases.length, 1)
    assert.equal(merged.releases[0].version, '0.3.11')
    assert.throws(
      () => buildEdgeHeadlessCatalog({
        previous: edgePrevious(),
        catalogInput: {
          releases: [{ version: '0.3.12', sha256: 'bad', platform: 'win', url: 'http://insecure' }],
        },
        manifestVersion: '1.0.1',
      }),
      /sha256 must be 64 hex/,
    )
  })
})

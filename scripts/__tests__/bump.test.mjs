import assert from 'node:assert/strict'
import test from 'node:test'
import { applyReleaseManifestBump } from '../bump.mjs'

test('bump aligns the canonical plugin catalog with the lockstep workspace version', () => {
  const catalog = {
    schemaVersion: 2,
    manifestPackageVersion: '1.0.0',
    pluginSetVersion: '0.6.29',
    release: { publishedAt: '2026-11-01T00:00:00.000Z', channel: 'stable' },
    plugins: {
      '@huaqiu/dsh-auth': { version: '0.6.29', hosts: ['all'] },
      '@huaqiu/dsh-kicad': { version: '0.6.29', hosts: ['kicad'] },
      '@huaqiu/dsh-tool-freerouting': '0.6.15',
    },
  }

  const changes = applyReleaseManifestBump(
    catalog,
    '0.6.30',
    ['@huaqiu/dsh-auth', '@huaqiu/dsh-kicad'],
    '2026-11-17T00:00:00.000Z',
  )

  assert.equal(catalog.pluginSetVersion, '0.6.30')
  assert.equal(catalog.plugins['@huaqiu/dsh-auth'].version, '0.6.30')
  assert.equal(catalog.plugins['@huaqiu/dsh-kicad'].version, '0.6.30')
  assert.equal(catalog.plugins['@huaqiu/dsh-tool-freerouting'], '0.6.15')
  assert.equal(catalog.manifestPackageVersion, '1.0.0')
  assert.deepEqual(changes['plugins.@huaqiu/dsh-kicad.version'], ['0.6.29', '0.6.30'])
})

test('bump is idempotent for an already-aligned catalog', () => {
  const catalog = {
    manifestPackageVersion: '1.0.0',
    pluginSetVersion: '0.6.30',
    plugins: { '@huaqiu/dsh-auth': { version: '0.6.30' } },
  }
  assert.deepEqual(applyReleaseManifestBump(catalog, '0.6.30', ['@huaqiu/dsh-auth']), {})
})

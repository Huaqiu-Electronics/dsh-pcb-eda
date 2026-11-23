/**
 * Catalog membership tests.
 *
 * `plugins-release-manifest.json` is what HQ Edge turns into the entries shown
 * in the plugin-update panel, so membership must be an explicit human
 * decision — never a side effect of dropping a new directory into packages/.
 * These tests pin the allowlist, the internal-only set and the release catalog
 * to each other.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CATALOG_PLUGIN_NAMES,
  INTERNAL_DSH_PLUGIN_NAMES,
  dshPlugins,
  internalDshPlugins,
  unclassifiedDshPlugins,
  workspaceDshPlugins,
  productBundles,
  publishablePackages,
  repoRoot,
} from '../utils/packages.mjs'

/** Catalog entries published from their own repos, with no workspace package. */
const STANDALONE_NAMES = ['@huaqiu/dsh-kicad-drc', '@huaqiu/dsh-tool-freerouting']

describe('hardcoded plugin catalog membership', () => {
  it('returns exactly the allowlist from dshPlugins()', () => {
    assert.deepEqual(dshPlugins().map(pkg => pkg.name), [...CATALOG_PLUGIN_NAMES])
    // Guard against accidentally gutting the catalog.
    assert.ok(CATALOG_PLUGIN_NAMES.length >= 10, `only ${CATALOG_PLUGIN_NAMES.length} catalog plugin(s)`)
    assert.ok(CATALOG_PLUGIN_NAMES.includes('@huaqiu/dsh-tool-quote'))
  })

  it('excludes all Hardware Engineering packages from the end-user catalog', () => {
    const names = dshPlugins().map(pkg => pkg.name)
    for (const name of ['@huaqiu/hardware-engineering', '@huaqiu/hardware-artifacts', '@huaqiu/dsh-hardware-ui']) {
      assert.equal(names.includes(name), false, `${name} must not be user-discoverable`)
      assert.ok(INTERNAL_DSH_PLUGIN_NAMES.includes(name), `${name} must be classified as internal`)
    }
  })

  it('never overlaps the user-visible and internal-only sets', () => {
    assert.deepEqual(
      CATALOG_PLUGIN_NAMES.filter(name => INTERNAL_DSH_PLUGIN_NAMES.includes(name)),
      [],
    )
  })

  it('classifies every DSH package in the workspace', () => {
    assert.deepEqual(unclassifiedDshPlugins().map(pkg => pkg.name), [])
    const all = workspaceDshPlugins().map(pkg => pkg.name).sort()
    assert.deepEqual(all, [...CATALOG_PLUGIN_NAMES, ...INTERNAL_DSH_PLUGIN_NAMES].sort())
    assert.deepEqual(internalDshPlugins().map(pkg => pkg.name), [...INTERNAL_DSH_PLUGIN_NAMES])
  })

  it('still treats internal packages as real, publishable workspace packages', () => {
    const workspace = workspaceDshPlugins().map(pkg => pkg.name)
    const publishable = publishablePackages().map(pkg => pkg.name)
    for (const name of INTERNAL_DSH_PLUGIN_NAMES) {
      assert.ok(workspace.includes(name), `${name} missing from workspace DSH plugins`)
      assert.ok(publishable.includes(name), `${name} must still be published to npm`)
    }
  })

  it('identifies the product bundle via DSH listedByDefault', () => {
    assert.deepEqual(productBundles().map(pkg => pkg.name), ['@huaqiu/hardware-engineering'])
  })

  it('matches the canonical release catalog exactly (allowlist + standalone plugins)', () => {
    const manifest = JSON.parse(readFileSync(
      join(repoRoot, 'release-manifest/plugins-release-manifest.json'), 'utf8',
    ))
    assert.deepEqual(
      Object.keys(manifest.plugins).sort(),
      [...CATALOG_PLUGIN_NAMES, ...STANDALONE_NAMES].sort(),
    )
    for (const name of INTERNAL_DSH_PLUGIN_NAMES) {
      assert.equal(manifest.plugins[name], undefined, `${name} leaked into the end-user catalog`)
    }
    // The ordinary plugins the bundle composes remain listed.
    for (const name of ['@huaqiu/dsh-auth', '@huaqiu/dsh-tool-quote', '@huaqiu/dsh-kicad']) {
      assert.ok(manifest.plugins[name], `${name} missing from catalog`)
    }
  })
})

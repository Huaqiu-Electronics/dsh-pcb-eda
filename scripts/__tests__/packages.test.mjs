/**
 * Catalog membership tests. A product bundle is a profile-level composition,
 * not an installable plugin, so it must not be offered in the plugin catalog
 * even though it is still a publishable npm package.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshPlugins, productBundles, publishablePackages, repoRoot } from '../utils/packages.mjs'

describe('plugin catalog membership', () => {
  it('excludes product bundles from the plugin catalog', () => {
    const names = dshPlugins().map(pkg => pkg.name)
    assert.equal(names.includes('@huaqiu/hardware-engineering'), false)
    // Guard against silently dropping every plugin if the discriminator drifts.
    assert.ok(names.length >= 10, `only ${names.length} plugin(s) found`)
    assert.ok(names.includes('@huaqiu/dsh-tool-quote'))
  })

  it('still treats the product bundle as a publishable package', () => {
    const names = publishablePackages().map(pkg => pkg.name)
    assert.ok(names.includes('@huaqiu/hardware-engineering'))
  })

  it('identifies the product bundle via DSH listedByDefault', () => {
    const bundles = productBundles().map(pkg => pkg.name)
    assert.deepEqual(bundles, ['@huaqiu/hardware-engineering'])
  })

  it('does not list the product bundle in the canonical release catalog', () => {
    const manifest = JSON.parse(readFileSync(
      join(repoRoot, 'release-manifest/plugins-release-manifest.json'), 'utf8',
    ))
    assert.equal(manifest.plugins['@huaqiu/hardware-engineering'], undefined)
    // The ordinary plugins it composes remain listed.
    for (const name of ['@huaqiu/dsh-auth', '@huaqiu/dsh-tool-quote', '@huaqiu/dsh-kicad']) {
      assert.ok(manifest.plugins[name], `${name} missing from catalog`)
    }
  })
})

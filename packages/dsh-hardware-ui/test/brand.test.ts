import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HUAQIU_LOGO_SVG_BASE64 } from '../src/client/brand'

/**
 * The wizard's brand mark must be the vendor file, not an approximation of it.
 *
 * `brand.ts` carries `assets/huaqiu.svg` as base64 because the client bundle has no
 * asset pipeline; this test is what keeps the two in step when the logo is
 * re-exported.
 */
describe('brand asset', () => {
  it('decodes to the repository SVG, byte for byte', () => {
    const asset = fileURLToPath(new URL('../../../assets/huaqiu.svg', import.meta.url))
    const expected = readFileSync(asset, 'utf8')
    const decoded = Buffer.from(HUAQIU_LOGO_SVG_BASE64, 'base64').toString('utf8')
    expect(decoded).toBe(expected)
  })

  it('is a self-contained svg document', () => {
    const decoded = Buffer.from(HUAQIU_LOGO_SVG_BASE64, 'base64').toString('utf8')
    expect(decoded.startsWith('<?xml')).toBe(true)
    expect(decoded).toContain('viewBox="0 0 50 50"')
    // No external references: the mark has to render from the data URI alone.
    expect(decoded).not.toMatch(/xlink:href|<image|url\(http/i)
  })
})

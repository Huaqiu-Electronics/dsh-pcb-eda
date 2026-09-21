/**
 * `@huaqiu/component-gen-app` — unit tests for pure helpers.
 *
 * The component tree needs a DOM, so these target the DOM-free utilities only.
 */
import { describe, expect, it } from 'vitest'
import { defaultArtifactsBase, parseEvent } from '../src/api/component-gen-client.js'
import { humanizeKey } from '../src/utils/labels.js'
import { translateFor } from '../src/copy/index.js'

const SYMBOL_WITH_TWO_PINS = `(kicad_symbol_lib (version 20231120) (generator kicad_symbol_editor)
  (symbol "Test"
    (pin_names (offset 1.016))
    (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "Test" (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
    (symbol "Test_1_1"
      (pin input line (at -2.54 0 0) (length 2.54)
        (name "A" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
      (pin output line (at 2.54 0 180) (length 2.54)
        (name "B" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27))))))))`

describe('defaultArtifactsBase', () => {
  it('derives the artifacts base from the component-gen base', () => {
    expect(defaultArtifactsBase('/api/v1/huaqiu/component-gen')).toBe('/api/v1/huaqiu/artifacts')
    expect(defaultArtifactsBase('/api/v1/huaqiu/component-gen/')).toBe('/api/v1/huaqiu/artifacts')
  })
})

describe('parseEvent', () => {
  it('parses an SSE frame', () => {
    const frame = 'event: progress\ndata: {"type":"progress","message":"ok","at":"2026-01-01T00:00:00Z"}\n\n'
    const evt = parseEvent(frame)
    expect(evt?.type).toBe('progress')
    expect(evt?.message).toBe('ok')
  })
  it('returns null for an empty frame', () => {
    expect(parseEvent('')).toBeNull()
  })
})

describe('humanizeKey', () => {
  it('humanizes camelCase keys', () => {
    expect(humanizeKey('a1Min')).toBe('A1 Min')
    expect(humanizeKey('pitch_d')).toBe('Pitch d')
  })
})

describe('translateFor', () => {
  it('returns Chinese by default and English on demand', () => {
    const zh = translateFor('zh')
    const en = translateFor('en')
    expect(zh('card.submit')).toBeTruthy()
    expect(typeof en('card.submit')).toBe('string')
  })
})

describe('symbolPinCount', () => {
  it('counts generated symbol pins', async () => {
    const symbols = await import('../src/utils/symbol-pins.js').catch(() => ({}))
    expect(typeof symbols.symbolPinCount).toBe('function')
    expect(symbols.symbolPinCount!(SYMBOL_WITH_TWO_PINS)).toBe(2)
  })
})

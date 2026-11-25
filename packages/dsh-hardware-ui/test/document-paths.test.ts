/**
 * Path arithmetic for a document preview.
 *
 * These cases are the ones that decide whether a child sheet is found or
 * invented, so they are pinned rather than eyeballed: the address grammar, the
 * `..` collapse, and the refusal to treat a bare name as anything but a sibling.
 */
import { describe, expect, it } from 'vitest'
import { displayName, documentFilePath, resolveReference, splitPath } from '../src/client/document/paths.js'

describe('documentFilePath', () => {
  it('reads a session address into its session and workspace path', () => {
    expect(documentFilePath('dsh-resource://file/session/s-1/boards/main.kicad_sch')).toEqual({
      scope: 'session',
      sessionId: 's-1',
      path: 'boards/main.kicad_sch',
    })
  })

  it('decodes percent-encoded segments, including spaces in a directory', () => {
    expect(documentFilePath('dsh-resource://file/session/s-1/hw%20one/a%20b.kicad_pcb')).toEqual({
      scope: 'session',
      sessionId: 's-1',
      path: 'hw one/a b.kicad_pcb',
    })
  })

  it('ignores query and fragment suffixes', () => {
    expect(documentFilePath('dsh-resource://file/session/s-1/a.kicad_sch?line=3#x')?.path).toBe('a.kicad_sch')
  })

  it('reads an absolute address without a session', () => {
    expect(documentFilePath('dsh-resource://file/absolute/home/u/a.step')).toEqual({
      scope: 'absolute',
      path: '/home/u/a.step',
    })
  })

  it('rejects anything that is not a readable file address', () => {
    expect(documentFilePath('https://example.com/a.kicad_sch')).toBeUndefined()
    expect(documentFilePath('dsh-resource://file/session/s-1')).toBeUndefined()
    expect(documentFilePath('dsh-resource://file/session//a.kicad_sch')).toBeUndefined()
    expect(documentFilePath('dsh-resource://file/other/s-1/a.kicad_sch')).toBeUndefined()
    expect(documentFilePath('dsh-resource://file/session/s-1/%E0%A4%A')).toBeUndefined()
  })
})

describe('resolveReference', () => {
  it('resolves a declared reference against the declaring document', () => {
    expect(resolveReference('boards/a/main.kicad_sch', 'power.kicad_sch')).toBe('boards/a/power.kicad_sch')
  })

  it('collapses parent segments', () => {
    expect(resolveReference('boards/a/main.kicad_sch', '../shared/power.kicad_sch')).toBe('boards/shared/power.kicad_sch')
    expect(resolveReference('boards/a/main.kicad_sch', './sub/./amp.kicad_sch')).toBe('boards/a/sub/amp.kicad_sch')
  })

  it('keeps an absolute reference absolute', () => {
    expect(resolveReference('boards/a/main.kicad_sch', '/libs/power.kicad_sch')).toBe('/libs/power.kicad_sch')
    expect(resolveReference('boards/a/main.kicad_sch', 'C:/hw/power.kicad_sch')).toBe('C:/hw/power.kicad_sch')
  })

  it('normalizes a backslash reference, as KiCad may write it on Windows', () => {
    expect(resolveReference('boards\\a\\main.kicad_sch', 'sub\\amp.kicad_sch')).toBe('boards/a/sub/amp.kicad_sch')
  })

  it('keeps traversal that climbs past the root instead of hiding it', () => {
    expect(resolveReference('main.kicad_sch', '../outside.kicad_sch')).toBe('../outside.kicad_sch')
  })

  it('returns undefined for an empty reference', () => {
    expect(resolveReference('boards/main.kicad_sch', '   ')).toBeUndefined()
  })
})

describe('splitPath / displayName', () => {
  it('splits on either separator', () => {
    expect(splitPath('a/b/c.kicad_sch')).toEqual({ directory: 'a/b', name: 'c.kicad_sch' })
    expect(splitPath('a\\b\\c.kicad_sch')).toEqual({ directory: 'a/b', name: 'c.kicad_sch' })
    expect(splitPath('c.kicad_sch')).toEqual({ directory: '', name: 'c.kicad_sch' })
  })

  it('names a document by its final segment', () => {
    expect(displayName('boards/power.kicad_sch')).toBe('power.kicad_sch')
    expect(displayName('power.kicad_sch')).toBe('power.kicad_sch')
  })
})

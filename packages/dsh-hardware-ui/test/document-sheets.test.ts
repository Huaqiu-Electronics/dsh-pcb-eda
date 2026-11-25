/**
 * Child-sheet discovery.
 *
 * The negative case is the important one: a directory full of unrelated
 * `.kicad_sch` files must yield no hierarchy at all. Everything else here is the
 * positive counterpart — a declared sheet is found, named and resolved.
 */
import { describe, expect, it } from 'vitest'
import { sheetReferences } from '../src/client/document/sheets.js'

const sheet = (file: string | undefined, name?: string): Record<string, unknown> => ({
  properties: [
    ...(name === undefined ? [] : [{ name: 'Sheetname', text: name }]),
    ...(file === undefined ? [] : [{ name: 'Sheet file', text: file }]),
  ],
})

describe('sheetReferences', () => {
  it('lists declared child sheets with their displayed name and resolved path', () => {
    const schematic = { sheets: [sheet('power.kicad_sch', 'Power'), sheet('../shared/usb.kicad_sch', 'USB')] }
    expect(sheetReferences(schematic, 'boards/main.kicad_sch')).toEqual([
      { label: 'Power', declared: 'power.kicad_sch', resolved: 'boards/power.kicad_sch' },
      { label: 'USB', declared: '../shared/usb.kicad_sch', resolved: 'shared/usb.kicad_sch' },
    ])
  })

  it('returns nothing for a flat schematic, however many siblings sit beside it', () => {
    // The whole point: a sibling file is not a child sheet unless it is declared.
    expect(sheetReferences({ sheets: [] }, 'boards/main.kicad_sch')).toEqual([])
    expect(sheetReferences({}, 'boards/main.kicad_sch')).toEqual([])
  })

  it('ignores a sheet node without a file property instead of guessing', () => {
    expect(sheetReferences({ sheets: [sheet(undefined, 'Orphan')] }, 'a.kicad_sch')).toEqual([])
  })

  it('falls back to the declared file name when the sheet has no name', () => {
    expect(sheetReferences({ sheets: [sheet('power.kicad_sch')] }, 'main.kicad_sch')).toEqual([
      { label: 'power.kicad_sch', declared: 'power.kicad_sch', resolved: 'power.kicad_sch' },
    ])
  })

  it('de-duplicates a sheet instantiated more than once', () => {
    const schematic = { sheets: [sheet('power.kicad_sch', 'A'), sheet('power.kicad_sch', 'B')] }
    expect(sheetReferences(schematic, 'main.kicad_sch')).toHaveLength(1)
  })

  it('accepts the older Sheetfile property spelling', () => {
    const schematic = { sheets: [{ properties: [{ name: 'Sheetfile', text: 'old.kicad_sch' }] }] }
    expect(sheetReferences(schematic, 'main.kicad_sch')[0]?.declared).toBe('old.kicad_sch')
  })

  it('survives a malformed sheet list without throwing', () => {
    expect(sheetReferences({ sheets: 'nope' }, 'main.kicad_sch')).toEqual([])
    expect(sheetReferences({ sheets: [null, 7, { properties: 'x' }] }, 'main.kicad_sch')).toEqual([])
  })
})

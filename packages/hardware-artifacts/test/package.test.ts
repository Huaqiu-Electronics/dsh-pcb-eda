/**
 * Fabrication package validation.
 *
 * The plotter exits 0 for a package it did not finish; these cases are the
 * three shapes that produce a real, wrong board if nothing checks them.
 */
import { describe, expect, it } from 'vitest'
import { expectedCopperLayers, validateFabricationPackage, validationSummary } from '../src/package.js'
import type { BoardFacts } from '../src/order.js'

const FACTS: BoardFacts = {
  layers: 4,
  widthMm: 60,
  heightMm: 40,
  thicknessMm: 1.6,
}

function pkg(...names: readonly string[]): { name: string; bytes: number }[] {
  return names.map(name => ({ name, bytes: 128 }))
}

const COMPLETE = [
  'main-F_Cu.gbr',
  'main-In1_Cu.gbr',
  'main-In2_Cu.gbr',
  'main-B_Cu.gbr',
  'main-Edge_Cuts.gbr',
  'main.drl',
]

describe('copper layers', () => {
  it('expects front, inner and back in order for a 4-layer stackup', () => {
    expect(expectedCopperLayers(4)).toEqual(['F_Cu', 'In1_Cu', 'In2_Cu', 'B_Cu'])
    expect(expectedCopperLayers(2)).toEqual(['F_Cu', 'B_Cu'])
    expect(expectedCopperLayers(6)).toEqual(['F_Cu', 'In1_Cu', 'In2_Cu', 'In3_Cu', 'In4_Cu', 'B_Cu'])
  })

  it('accepts a complete 4-layer package', () => {
    const validation = validateFabricationPackage(pkg(...COMPLETE), FACTS)
    expect(validation.ok).toBe(true)
    expect(validation.errors).toEqual([])
    expect(validation.copperLayers).toEqual(['F_Cu', 'In1_Cu', 'In2_Cu', 'B_Cu'])
    expect(validation.hasOutline).toBe(true)
    expect(validation.hasDrill).toBe(true)
  })

  it('refuses a package missing a plotted inner layer', () => {
    const validation = validateFabricationPackage(
      pkg('main-F_Cu.gbr', 'main-In1_Cu.gbr', 'main-B_Cu.gbr', 'main-Edge_Cuts.gbr', 'main.drl'),
      FACTS,
    )
    expect(validation.ok).toBe(false)
    expect(validation.missingLayers).toEqual(['In2_Cu'])
    expect(validation.errors.map(issue => issue.code)).toEqual(['missing-copper-layer'])
    expect(validationSummary(validation)).toContain('In2_Cu')
  })

  it('refuses a package with no copper at all', () => {
    const validation = validateFabricationPackage(pkg('main-Edge_Cuts.gbr', 'main.drl'), FACTS)
    expect(validation.ok).toBe(false)
    expect(validation.errors.map(issue => issue.code)).toEqual(['no-copper'])
  })

  it('only warns about a copper layer the stackup does not declare', () => {
    const validation = validateFabricationPackage(pkg(...COMPLETE, 'main-In3_Cu.gbr'), FACTS)
    expect(validation.ok).toBe(true)
    expect(validation.warnings.map(issue => issue.code)).toContain('unexpected-copper-layer')
  })
})

describe('outline and geometry', () => {
  it('refuses a package with no Edge.Cuts plot', () => {
    const validation = validateFabricationPackage(
      pkg('main-F_Cu.gbr', 'main-In1_Cu.gbr', 'main-In2_Cu.gbr', 'main-B_Cu.gbr', 'main.drl'),
      FACTS,
    )
    expect(validation.ok).toBe(false)
    expect(validation.errors.map(issue => issue.code)).toEqual(['no-board-outline'])
    expect(validation.hasOutline).toBe(false)
  })

  it('refuses a package whose board outline could not be measured', () => {
    const validation = validateFabricationPackage(pkg(...COMPLETE), { ...FACTS, widthMm: 0, heightMm: 0 })
    expect(validation.ok).toBe(false)
    expect(validation.errors.map(issue => issue.code)).toEqual(['zero-area'])
  })

  it('refuses a zero-byte plot, which the plotter writes but never fills', () => {
    const files = pkg(...COMPLETE).map(file => (file.name === 'main.drl' ? { ...file, bytes: 0 } : file))
    const validation = validateFabricationPackage(files, FACTS)
    expect(validation.ok).toBe(false)
    expect(validation.errors).toContainEqual(expect.objectContaining({ code: 'empty-file', file: 'main.drl' }))
  })
})

describe('KiCad plot naming', () => {
  // KiCad's default plotter uses the Protel suffix set, not `.gbr`: outer
  // copper is `.gtl`/`.gbl`, inner copper is `.g1`…, the outline is `.gm1`.
  // Verified against `kicad-cli 10.0.7 pcb export gerbers` output.
  const PROTEL = [
    'board-F_Cu.gtl',
    'board-In1_Cu.g1',
    'board-In2_Cu.g2',
    'board-In3_Cu.g3',
    'board-In4_Cu.g4',
    'board-B_Cu.gbl',
    'board-F_Mask.gts',
    'board-B_Mask.gbs',
    'board-Edge_Cuts.gm1',
    'board-job.gbrjob',
    'board.drl',
  ]

  it('reads the layer from a Protel-named plot', () => {
    const validation = validateFabricationPackage(pkg(...PROTEL), { ...FACTS, layers: 6 })
    expect(validation.ok).toBe(true)
    expect(validation.copperLayers).toEqual(['F_Cu', 'In1_Cu', 'In2_Cu', 'In3_Cu', 'In4_Cu', 'B_Cu'])
    expect(validation.warnings).toEqual([])
  })

  it('keeps the layer when the board name has hyphens', () => {
    const validation = validateFabricationPackage(
      pkg('mini-motor-controller-F_Cu.gtl', 'mini-motor-controller-B_Cu.gbl', 'mini-motor-controller-Edge_Cuts.gm1'),
      { ...FACTS, layers: 2 },
    )
    expect(validation.copperLayers).toEqual(['F_Cu', 'B_Cu'])
    expect(validation.ok).toBe(true)
  })

  it('does not read a plain text file as a plot', () => {
    const validation = validateFabricationPackage(pkg(...PROTEL, 'notes-F_Cu.txt'), { ...FACTS, layers: 6 })
    expect(validation.copperLayers).toEqual(['F_Cu', 'In1_Cu', 'In2_Cu', 'In3_Cu', 'In4_Cu', 'B_Cu'])
    expect(validation.ok).toBe(true)
  })
})

describe('renamed layers', () => {
  // A board file may rename its copper layers, and KiCad then plots that
  // display name into the filename: `(0 "F.Cu" power "top_copper")` plots
  // `board-top_copper.gtl`. The Protel suffix still names the layer, so such a
  // package must not be reported as having no copper.
  const RENAMED = [
    'actionneur-top_copper.gtl',
    'actionneur-bottom_copper.gbl',
    'actionneur-F_Mask.gts',
    'actionneur-B_Mask.gbs',
    'actionneur-F_Silkscreen.gto',
    'actionneur-B_Silkscreen.gbo',
    'actionneur-Edge_Cuts.gm1',
    'actionneur-job.gbrjob',
    'actionneur.drl',
  ]

  it('reads renamed outer copper from the Protel suffix', () => {
    const validation = validateFabricationPackage(pkg(...RENAMED), { ...FACTS, layers: 2 })
    expect(validation.ok).toBe(true)
    expect(validation.errors).toEqual([])
    expect(validation.copperLayers).toEqual(['F_Cu', 'B_Cu'])
    expect(validation.hasOutline).toBe(true)
    expect(validation.hasDrill).toBe(true)
    // The renamed plots are plots: nothing to report as a stray file.
    expect(validation.warnings).toEqual([])
  })

  it('reads a renamed inner copper layer from its numbered suffix', () => {
    const validation = validateFabricationPackage(
      pkg('main-F_Cu.gbr', 'main-inner_ground.g1', 'main-In2_Cu.gbr', 'main-B_Cu.gbr',
        'main-Edge_Cuts.gbr', 'main.drl'),
      FACTS,
    )
    expect(validation.ok).toBe(true)
    expect(validation.copperLayers).toEqual(['F_Cu', 'In1_Cu', 'In2_Cu', 'B_Cu'])
  })

  it('falls back to the board\'s declared names for an extended-name plot', () => {
    // Extended (`.gbr`) names carry no layer identity in the suffix, so a
    // renamed layer can only be read through the board's own layer table.
    const validation = validateFabricationPackage(
      pkg('main-top_copper.gbr', 'main-bottom_copper.gbr', 'main-Edge_Cuts.gbr', 'main.drl'),
      { ...FACTS, layers: 2, copperAliases: { top_copper: 'F_Cu', bottom_copper: 'B_Cu' } },
    )
    expect(validation.ok).toBe(true)
    expect(validation.copperLayers).toEqual(['F_Cu', 'B_Cu'])
    expect(validation.warnings).toEqual([])
  })

  it('still refuses a package whose copper really is absent', () => {
    const validation = validateFabricationPackage(
      pkg('main-top_copper.gbr', 'main-Edge_Cuts.gbr', 'main.drl'),
      { ...FACTS, layers: 2 },
    )
    expect(validation.ok).toBe(false)
    expect(validation.errors.map(issue => issue.code)).toEqual(['no-copper'])
  })
})

describe('drill and stray files', () => {
  it('warns rather than refuses when there is no drill file', () => {
    const validation = validateFabricationPackage(
      pkg('main-F_Cu.gbr', 'main-In1_Cu.gbr', 'main-In2_Cu.gbr', 'main-B_Cu.gbr', 'main-Edge_Cuts.gbr'),
      FACTS,
    )
    expect(validation.ok).toBe(true)
    expect(validation.warnings.map(issue => issue.code)).toEqual(['no-drill'])
  })

  it('accepts alternate drill suffixes and job metadata', () => {
    const validation = validateFabricationPackage(pkg(...COMPLETE, 'main-job.gbrjob', 'readme.txt'), FACTS)
    expect(validation.ok).toBe(true)
    expect(validation.warnings).toEqual([])
    const xln = validateFabricationPackage(
      pkg('main-F_Cu.gbr', 'main-In1_Cu.gbr', 'main-In2_Cu.gbr', 'main-B_Cu.gbr', 'main-Edge_Cuts.gbr', 'main-PTH.xln'),
      FACTS,
    )
    expect(xln.hasDrill).toBe(true)
  })

  it('reports a file whose role it cannot establish, without failing the package', () => {
    const validation = validateFabricationPackage(pkg(...COMPLETE, 'notes.bin'), FACTS)
    expect(validation.ok).toBe(true)
    expect(validation.warnings.map(issue => issue.code)).toContain('unexpected-file')
  })

  it('has nothing to say about a valid package without warnings', () => {
    expect(validationSummary(validateFabricationPackage(pkg(...COMPLETE), FACTS))).toBeUndefined()
  })
})

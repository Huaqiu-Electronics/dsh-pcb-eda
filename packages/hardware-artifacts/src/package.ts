/**
 * Fabrication package validation.
 *
 * The exporter (`kicad-cli pcb export gerbers|drill`) reports success when it
 * wrote *something*; it does not claim the result is a fabricable board. Three
 * failures survive that exit code and are only visible by reading the file set:
 *
 *   - a copper layer in the stackup with no plotted gerber, which fabricates a
 *     board missing that layer;
 *   - no `Edge.Cuts` plot, which means no board outline — the order form is
 *     then submitted with a 0 × 0 size;
 *   - a zero-byte plot, which the plotter writes when a layer had nothing to
 *     draw and the profile still lists the file.
 *
 * Layer identity is read from the plot's Protel suffix first (`.gtl`, `.gbl`,
 * `.g1`…), because the text KiCad writes between the board name and the suffix
 * is the board's *display* name for that layer and is user-editable: a board
 * that renamed `F.Cu` to `top_copper` plots `board-top_copper.gtl`. Reading the
 * name alone would report that package as having no copper at all. For a plot
 * written with extended (`.gbr`) names, where the suffix carries no layer
 * identity, the board's own display names are matched through `facts`.
 *
 * The checks are pure functions over `{ name, bytes }` and the board facts the
 * file itself declares, so a caller can validate an archive it did not produce
 * (a colleague's zip, a cached revision) and get the same answer.
 *
 * @module
 */

import type { BoardFacts, PackageFile } from './order.js'

/** Every way a package can be judged unfit to fabricate. */
export type PackageIssueCode =
  | 'no-copper'
  | 'missing-copper-layer'
  | 'unexpected-copper-layer'
  | 'no-board-outline'
  | 'zero-area'
  | 'no-drill'
  | 'empty-file'
  | 'unexpected-file'

export interface PackageIssue {
  readonly code: PackageIssueCode
  /** `error` blocks an order; `warning` is reported and left to the user. */
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly file?: string
}

export interface PackageValidation {
  /** True when no issue is an error; warnings may still be present. */
  readonly ok: boolean
  readonly checkedAt: string
  readonly errors: readonly PackageIssue[]
  readonly warnings: readonly PackageIssue[]
  /** Copper layers found in the package, in the file's own naming. */
  readonly copperLayers: readonly string[]
  /** Layers the stackup expects but the package does not contain. */
  readonly missingLayers: readonly string[]
  readonly hasOutline: boolean
  readonly hasDrill: boolean
}

/**
 * Gerber/drill suffixes that carry no fabrication intent.
 *
 * A `.gbrjob` is KiCad's job metadata and is written next to the plots; it is
 * neither a layer nor an error.
 */
const NON_LAYER_SUFFIXES = new Set(['gbrjob', 'txt', 'csv', 'json'])

const DRILL_SUFFIXES = new Set(['drl', 'xln', 'exc', 'ncd'])

/**
 * Plot file suffixes.
 *
 * KiCad writes `.gbr` when the plotter is set to extended names, but its
 * default is the Protel set: `.gtl`/`.gbl` for outer copper, `.g1`…`.g32` for
 * inner copper, `.gm1` for the outline, and letters for the technical layers.
 * Both spellings appear in real packages — a validator that knows only `.gbr`
 * declares every inner layer missing.
 */
const GERBER_SUFFIXES = /^(?:gbr|g\d{1,2}|gm\d{1,2}|gko|gml|g[tsbop][a-z])$/iu

/** The layer names KiCad puts between the board name and the suffix. */
const LAYER_TOKENS = /^(?:[FB]_[A-Za-z0-9_]+|In\d+_Cu|Edge_Cuts|Margin|User_[A-Za-z0-9_]+|[A-Za-z0-9]+_User)$/u

/**
 * Protel plot suffixes that name their own layer.
 *
 * KiCad's default plotter writes the Protel set. The suffix is a fixed function
 * of the layer, while the text before it is the board's *display* name for that
 * layer and is therefore whatever the designer typed. A board that renamed
 * `F.Cu` to `top_copper` plots `board-top_copper.gtl`, and one that renamed
 * `In1.Cu` plots `board-inner_ground.g1` — both perfectly fabricable, and both
 * unreadable from the name alone.
 */
const PROTEL_LAYERS: Readonly<Record<string, string>> = Object.freeze({
  gtl: 'F_Cu',
  gbl: 'B_Cu',
  gts: 'F_Mask',
  gbs: 'B_Mask',
  gto: 'F_SilkS',
  gbo: 'B_SilkS',
  gtp: 'F_Paste',
  gbp: 'B_Paste',
  gta: 'F_Adhes',
  gba: 'B_Adhes',
  gm1: 'Edge_Cuts',
})

/** `gtl` → `F_Cu`; `g3` → `In3_Cu`; `undefined` for a suffix that names no layer. */
function protelLayer(suffix: string): string | undefined {
  const fixed = PROTEL_LAYERS[suffix]
  if (fixed !== undefined) return fixed
  const inner = /^g(\d{1,2})$/u.exec(suffix)
  if (inner === null) return undefined
  // Inner copper is numbered from 1 in both spellings: `.g1` is `In1_Cu`.
  const index = Number(inner[1])
  return index >= 1 ? `In${String(index)}_Cu` : undefined
}

/**
 * `board-F_Cu.gbr` → `F_Cu`; `undefined` for a file that is not a plot.
 *
 * `aliases` maps a board's display names back onto the canonical ones
 * (`{ top_copper: 'F_Cu' }`). It is the only way to read a plot whose layer was
 * renamed *and* written with extended (`.gbr`) names, where the suffix carries
 * no layer identity.
 */
function gerberLayer(name: string, aliases?: Readonly<Record<string, string>>): string | undefined {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  const suffix = name.slice(dot + 1).toLowerCase()
  if (!GERBER_SUFFIXES.test(suffix)) return undefined
  const protel = protelLayer(suffix)
  if (protel !== undefined) return protel
  const stem = name.slice(0, dot)
  // KiCad names every plot `<board>-<layer>`, and a board name may itself
  // contain hyphens, so the layer is what follows the last one.
  const dash = stem.lastIndexOf('-')
  const layer = dash === -1 ? stem : stem.slice(dash + 1)
  if (LAYER_TOKENS.test(layer)) return layer
  const alias = aliases?.[layer]
  return alias !== undefined && LAYER_TOKENS.test(alias) ? alias : undefined
}

function suffixOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** The copper layers a KiCad stackup of this size must contain, in order. */
export function expectedCopperLayers(layers: number): string[] {
  const count = Number.isFinite(layers) && layers >= 2 ? Math.floor(layers) : 2
  const inner: string[] = []
  for (let index = 1; index <= count - 2; index += 1) inner.push(`In${String(index)}_Cu`)
  return ['F_Cu', ...inner, 'B_Cu']
}

/**
 * Judge one package against the board facts it was plotted from.
 *
 * `facts` must come from the same board file (`readBoardFacts`); measuring a
 * package against another board's stackup is the very mistake this catches.
 *
 * @param files - every member of the archive, with its uncompressed size.
 * @param facts - geometry and stackup declared by the source board.
 */
export function validateFabricationPackage(
  files: readonly PackageFile[],
  facts: BoardFacts,
): PackageValidation {
  const errors: PackageIssue[] = []
  const warnings: PackageIssue[] = []

  const layers = new Set<string>()
  let hasOutline = false
  let hasDrill = false
  let unreadable = 0

  for (const file of files) {
    if (file.bytes === 0) {
      errors.push({
        code: 'empty-file',
        severity: 'error',
        message: `${file.name} is empty; the plotter wrote a file it did not fill`,
        file: file.name,
      })
    }
    const layer = gerberLayer(file.name, facts.copperAliases)
    if (layer !== undefined) {
      layers.add(layer)
      if (layer === 'Edge_Cuts') hasOutline = true
      continue
    }
    if (DRILL_SUFFIXES.has(suffixOf(file.name))) hasDrill = true
    else if (!NON_LAYER_SUFFIXES.has(suffixOf(file.name))) unreadable += 1
  }

  const copperLayers = [...layers].filter(layer => layer.endsWith('_Cu'))
  const expected = expectedCopperLayers(facts.layers)
  const missing = expected.filter(layer => !layers.has(layer))

  if (copperLayers.length === 0) {
    errors.push({
      code: 'no-copper',
      severity: 'error',
      message: 'no copper gerber in the package; nothing would be etched',
    })
  } else if (missing.length > 0) {
    errors.push({
      code: 'missing-copper-layer',
      severity: 'error',
      message: `the board declares ${String(facts.layers)} copper layers but ${missing.join(', ')} `
        + `${missing.length === 1 ? 'was' : 'were'} not plotted; ordering this package would produce a `
        + 'board missing that layer',
    })
  }

  const extra = copperLayers.filter(layer => !expected.includes(layer))
  if (extra.length > 0) {
    warnings.push({
      code: 'unexpected-copper-layer',
      severity: 'warning',
      message: `the package plots ${extra.join(', ')}, which the declared stackup does not contain`,
    })
  }

  if (!hasOutline) {
    errors.push({
      code: 'no-board-outline',
      severity: 'error',
      message: 'no Edge.Cuts gerber in the package; the fabricator would have no board outline to cut',
    })
  }

  if (!(facts.widthMm > 0) || !(facts.heightMm > 0)) {
    errors.push({
      code: 'zero-area',
      severity: 'error',
      message: 'the board outline could not be measured, so the order form would carry a 0 × 0 size',
    })
  }

  // A board may legitimately be SMD-only, so a missing drill file is reported
  // rather than refused: the fabricator still needs to know there are no holes.
  if (!hasDrill) {
    warnings.push({
      code: 'no-drill',
      severity: 'warning',
      message: 'no drill file in the package; it is only correct for a board with no through-holes',
    })
  }

  if (unreadable > 0) {
    warnings.push({
      code: 'unexpected-file',
      severity: 'warning',
      message: `${String(unreadable)} file(s) are neither gerber, drill nor job metadata and were ignored`,
    })
  }

  return {
    ok: errors.length === 0,
    checkedAt: new Date().toISOString(),
    errors,
    warnings,
    copperLayers,
    missingLayers: missing,
    hasOutline,
    hasDrill,
  }
}

/** One sentence a human or agent can act on, or `undefined` when valid. */
export function validationSummary(validation: PackageValidation): string | undefined {
  if (validation.ok && validation.warnings.length === 0) return undefined
  const parts = [...validation.errors, ...validation.warnings].map(issue => issue.message)
  return parts.join('; ')
}

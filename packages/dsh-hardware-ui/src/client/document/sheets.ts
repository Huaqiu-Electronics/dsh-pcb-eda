/**
 * Hierarchical child-sheet discovery for a standalone `.kicad_sch`.
 *
 * The rule this module exists to enforce: a child sheet is a sheet the file
 * *declares*, never a `.kicad_sch` that happens to sit next to it. A workspace
 * routinely holds several unrelated schematics in one directory, and merging
 * them by proximity would invent a hierarchy the designer never drew.
 *
 * What KiCad actually writes is a `sheet` node whose `Sheet file` property names
 * the child document, relative to the sheet that declares it:
 *
 * ```sexpr
 * (sheet (at 63.5 45.72) (size 25.4 19.05)
 *   (property "Sheetname" "Power" …)
 *   (property "Sheet file" "power.kicad_sch" …)
 *   (instances …))
 * ```
 *
 * `I_SchematicSheet.properties` carries those pairs verbatim
 * (`@huaqiu/kicad-sexpr-parser/dist/proto/schematic.d.ts:274-296`), so discovery
 * needs no second parser and no project file.
 *
 * @module @huaqiu/dsh-hardware-ui/client/document/sheets
 */

import { resolveReference } from './paths.js'

/** One child sheet a schematic declares. */
export interface SheetReference {
  /** `Sheetname` as drawn, for display; falls back to the file name. */
  readonly label: string
  /** Path as written in the file. */
  readonly declared: string
  /** Resolved against the owning document; undefined when the reference is unusable. */
  readonly resolved?: string
}

/** Property names KiCad has used for the child document across format versions. */
const FILE_PROPERTY_NAMES = ['Sheet file', 'Sheetfile', 'SheetFile'] as const
/** Property names KiCad has used for the sheet's displayed name. */
const NAME_PROPERTY_NAMES = ['Sheetname', 'Sheet name', 'SheetName'] as const

interface PropertyLike {
  readonly name?: unknown
  readonly text?: unknown
}

interface SheetLike {
  readonly properties?: readonly PropertyLike[]
}

function propertyText(properties: readonly PropertyLike[], names: readonly string[]): string | undefined {
  for (const name of names) {
    const hit = properties.find(property => property.name === name)
    if (hit !== undefined && typeof hit.text === 'string' && hit.text.trim() !== '') return hit.text
  }
  return undefined
}

/**
 * List the child documents a parsed schematic declares, in declaration order.
 * @param schematic - parsed schematic (`I_KicadSch`); only `sheets` is read.
 * @param ownerPath - path of the document these sheets belong to.
 * @returns one entry per declared sheet, de-duplicated by resolved path.
 */
export function sheetReferences(schematic: unknown, ownerPath: string): readonly SheetReference[] {
  const sheets = (schematic as { sheets?: unknown } | undefined)?.sheets
  if (!Array.isArray(sheets)) return []
  const seen = new Set<string>()
  const references: SheetReference[] = []
  for (const candidate of sheets as readonly SheetLike[]) {
    const properties = Array.isArray(candidate?.properties) ? candidate.properties : []
    const declared = propertyText(properties, FILE_PROPERTY_NAMES)
    if (declared === undefined) continue
    const resolved = resolveReference(ownerPath, declared)
    const key = resolved ?? declared
    if (seen.has(key)) continue
    seen.add(key)
    const label = propertyText(properties, NAME_PROPERTY_NAMES) ?? declared
    references.push({ label, declared, ...(resolved === undefined ? {} : { resolved }) })
  }
  return references
}

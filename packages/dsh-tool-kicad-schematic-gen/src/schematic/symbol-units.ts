/** Normalize a standalone common-only symbol without changing pins or graphics. */
import { applyEdits, children, parse, quote, value, type Form } from './sexpr.ts'

export function isCommonOnlyUnit(names: string[], name: string, pinCount: number, standalone: boolean): boolean {
  return standalone && pinCount > 0 && names.length > 0 && new Set(names).size === names.length
    && names.every(section => section === `${name}_0_0` || section === `${name}_0_1`)
}

/** Accept either a full library or one expanded symbol definition. */
export function normalizeCommonUnits(text: string): string {
  const root = parse(text)
  const symbols = root.head === 'symbol' ? [root] : children(root, 'symbol')
  const edits = symbols.flatMap(symbol => {
    const sections = children(symbol, 'symbol'), name = value(symbol)
    const pins = sections.reduce((sum, section) => sum + children(section, 'pin').length, 0)
    if (!isCommonOnlyUnit(sections.map(valueOf), name, pins,
      children(symbol, 'extends').length === 0 && children(symbol, 'pin').length === 0
      && sections.every(section => children(section, 'symbol').length === 0))) return []
    return sections.map(section => {
      const token = /^\(\s*symbol\s+("(?:[^"\\]|\\.)*"|[^\s()]+)/u.exec(text.slice(section.start))
      if (!token) throw new Error('Cannot locate common symbol unit name')
      const start = section.start + token[0].length - token[1]!.length
      return { start, end: start + token[1]!.length, text: quote(`${name}_1_${value(section).slice(-1)}`) }
    })
  })
  return applyEdits(text, edits)
}

function valueOf(form: Form): string { return value(form) }

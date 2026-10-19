/** Lossless KiCad s-expression ranges for targeted edits of a copied schematic. */

/** One parsed list; child ranges always refer to the original text. */
export interface Form {
  head: string
  items: Array<string | Form>
  start: number
  end: number
}

/** A non-overlapping replacement of source text. */
export interface TextEdit {
  start: number
  end: number
  text: string
}

function tokens(source: string): Array<{ value: string; start: number; end: number }> {
  const result: Array<{ value: string; start: number; end: number }> = []
  const pattern = /"(?:[^"\\]|\\.)*"|\(|\)|[^\s()]+/gu
  for (const match of source.matchAll(pattern)) {
    const start = match.index
    result.push({ value: match[0], start, end: start + match[0].length })
  }
  return result
}

/** Parse a complete schematic or symbol library without normalizing its text. */
export function parse(source: string): Form {
  const stream = tokens(source)
  const stack: Form[] = []
  let root: Form | undefined
  for (const token of stream) {
    if (token.value === '(') {
      const form: Form = { head: '', items: [], start: token.start, end: -1 }
      if (stack.length > 0) stack.at(-1)?.items.push(form)
      else if (root === undefined) root = form
      else throw new Error('KiCad text contains multiple root forms')
      stack.push(form)
    } else if (token.value === ')') {
      const form = stack.pop()
      if (form === undefined || form.items.length === 0 || typeof form.items[0] !== 'string') {
        throw new Error('KiCad text has an empty or unbalanced form')
      }
      form.head = form.items[0]
      form.end = token.end
    } else {
      const form = stack.at(-1)
      if (form === undefined) throw new Error('KiCad text has an atom outside a form')
      form.items.push(token.value)
    }
  }
  if (stack.length > 0 || root === undefined) throw new Error('KiCad text has an unbalanced or empty root')
  return root
}

/** Return direct child forms with a given head. */
export function children(parent: Form, head: string): Form[] {
  return parent.items.filter((item): item is Form => typeof item !== 'string' && item.head === head)
}

/** Return a required direct child form. */
export function required(parent: Form, head: string): Form {
  const matches = children(parent, head)
  if (matches.length !== 1) throw new Error(`expected one (${head} ...) in (${parent.head} ...), found ${matches.length}`)
  return matches[0]!
}

/** Return an unquoted atom, including escaped Unicode text and newlines. */
export function value(form: Form, index = 1): string {
  const item = form.items[index]
  if (typeof item !== 'string') throw new Error(`expected atom ${index} in (${form.head} ...)`)
  if (!item.startsWith('"')) return item
  try { return JSON.parse(item) as string } catch { throw new Error(`invalid quoted atom in (${form.head} ...)`) }
}

/** Quote text for a KiCad string atom. */
export function quote(value: string): string { return JSON.stringify(value) }

/** Replace disjoint ranges; equal-position inserts are deliberately unsupported. */
export function applyEdits(source: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end)
  let cursor = source.length
  let result = source
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > cursor) {
      throw new Error('KiCad edits overlap or escape the source text')
    }
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
    cursor = edit.start
  }
  return result
}

/** Keep surrounding text byte-for-byte while removing one complete form. */
export function deleteForm(source: string, form: Form): TextEdit {
  let start = form.start
  while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) start--
  if (start > 0 && source[start - 1] === '\n') start--
  return { start, end: form.end, text: '' }
}

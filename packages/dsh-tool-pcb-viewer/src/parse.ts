/**
 * parse.ts — the single parse entry point for the whole package.
 *
 * Both available engines produce the same `BoardModel`:
 *   - `./pcb/parseKicad.js`  — this package's own linear parser (DEFAULT)
 *   - `./adapter.js`         — `@huaqiu/kicad-sexpr-parser` + adaptation
 *
 * Why our own engine is the default: it stays linear as board size grows, while
 * the upstream path scales worse on multi-megabyte boards (measured on an 81MB
 * board: seconds vs. over a minute). Both engines are held to the same model by
 * test/parity.test.ts, so this choice is reversible and cheap to re-evaluate.
 *
 * Switching engines is this one line once the upstream quadratic is fixed:
 *   return adaptBoard(new BoardParser().parse(text))
 * test/parity.test.ts keeps both engines in lockstep, so the switch is safe.
 *
 * @module @huaqiu/dsh-tool-pcb-viewer/parse
 */
import type { BoardModel } from './model.js'
import { parseKicad } from './pcb/parseKicad.js'

export function parseBoard(text: string): BoardModel {
  return parseKicad(text)
}

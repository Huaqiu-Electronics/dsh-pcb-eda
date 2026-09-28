import { SchematicParser, type schematicProto } from '@huaqiu/kicad-sexpr-parser'

export function symbolPinCount(source: string): number {
  const symbols = new SchematicParser().parseLibSymbols(source)
  const numbers = new Set<string>()
  const collect = (symbol: schematicProto.I_LibSymbol): void => {
    for (const pin of symbol.pins ?? []) numbers.add(pin.number.text)
    for (const child of symbol.children ?? []) collect(child)
  }
  for (const symbol of symbols) collect(symbol)
  return numbers.size
}

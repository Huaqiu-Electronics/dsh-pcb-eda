/** Read only the explicit sheet interface declared by KiCad hierarchical labels. */
import { children, parse, required, value, type Form } from './sexpr.ts'

/** One named interface port on a schematic sheet. */
export interface ModulePort {
  name: string
  direction: 'input' | 'output' | 'bidirectional' | 'passive'
}

/** Source directions of one repeated label represented as a passive port. */
export interface DirectionConflict { name: string; sourceDirections: ModulePort['direction'][] }

/** Collect distinct hierarchy ports and report inconsistent source directions. */
export function readModulePorts(root: Form): { ports: ModulePort[]; directionConflicts: DirectionConflict[] } {
  if (root.head !== 'kicad_sch') throw new Error('schematicPath is not a KiCad schematic')
  const found = new Map<string, Set<ModulePort['direction']>>()
  for (const label of children(root, 'hierarchical_label')) {
    const name = value(label)
    const direction = value(required(label, 'shape'))
    if (!name.trim() || !['input', 'output', 'bidirectional', 'passive'].includes(direction)) {
      throw new Error(`hierarchical label has an invalid name or direction: ${name} (${direction})`)
    }
    const directions = found.get(name) ?? new Set<ModulePort['direction']>()
    directions.add(direction as ModulePort['direction'])
    found.set(name, directions)
  }
  const ports: ModulePort[] = []
  const directionConflicts: DirectionConflict[] = []
  for (const [name, directions] of found) {
    if (directions.size > 1) directionConflicts.push({ name, sourceDirections: [...directions] })
    ports.push({ name, direction: 'passive' })
  }
  return { ports, directionConflicts }
}

/** Return distinct hierarchy ports without inferring connector pins or ordinary labels. */
export function getModulePorts(text: string): ModulePort[] {
  return readModulePorts(parse(text)).ports
}

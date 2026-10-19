/** Validate model-supplied edit plans before reading or writing files. */
import type { EditPlan, Point } from './edit.ts'
import type { Port } from './project.ts'
import type { ExpectedPin } from './verify.ts'
import type { PortConnection } from './assembly.ts'

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: string[], name: string): void {
  const extra = Object.keys(value).filter(key => !allowed.includes(key))
  if (extra.length > 0) throw new Error(`${name} has unexpected fields: ${extra.join(', ')}`)
}

function string(value: unknown, name: string, max = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters`)
  return value
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error(`${name} must be an array of at most 1000 items`)
  return value as unknown[]
}

function uuid(value: unknown, name: string): string {
  const result = string(value, name, 36)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(result)) throw new Error(`${name} must be a UUID`)
  return result
}

function point(value: unknown, name: string, grid = false): Point {
  if (!Array.isArray(value) || value.length !== 2 || value.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1000)) {
    throw new Error(`${name} must be [x, y] millimetres within the page`)
  }
  const result = value as Point
  if (grid && result.some(n => Math.abs(n / 1.27 - Math.round(n / 1.27)) > 0.00001)) {
    throw new Error(`${name} must lie on the 1.27 mm connection grid`)
  }
  return result
}

function angle(value: unknown, name: string): number {
  if (value !== 0 && value !== 90 && value !== 180 && value !== 270) throw new Error(`${name} must be 0, 90, 180, or 270`)
  return value
}

function direction(value: unknown, name: string): Port['direction'] {
  if (value !== 'input' && value !== 'output' && value !== 'bidirectional' && value !== 'passive') {
    throw new Error(`${name} must be input, output, bidirectional, or passive`)
  }
  return value
}

function optionalStrings(value: unknown, name: string, id = false): string[] {
  return value === undefined ? [] : array(value, name).map((item, index) => id ? uuid(item, `${name}[${index}]`) : string(item, `${name}[${index}]`, 128))
}

function parseNotes(value: unknown, name: string): NonNullable<EditPlan['addNotes']> {
  return array(value, name).map((item, index) => {
    const field = record(item, `${name}[${index}]`)
    keys(field, ['text', 'at', 'size'], `${name}[${index}]`)
    const size = field.size === undefined ? 1.27 : field.size
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0.5 || size > 5) {
      throw new Error(`${name}[${index}].size must be 0.5 to 5 mm`)
    }
    return { text: string(field.text, `${name}[${index}].text`, 2000),
      at: point(field.at, `${name}[${index}].at`), size }
  })
}

/** Validate the exact edit operations for a single source sheet. */
export function parseEditPlan(value: unknown): EditPlan {
  const input = record(value, 'editPlan')
  keys(input, ['remove', 'moveLabels', 'addLabels', 'addWires', 'addJunctions', 'replaceNotes', 'addNotes', 'pinTypes'], 'editPlan')
  const plan: EditPlan = {}
  if (input.remove !== undefined) {
    const remove = record(input.remove, 'editPlan.remove')
    keys(remove, ['references', 'wires', 'junctions', 'labels', 'noConnects', 'notes'], 'editPlan.remove')
    plan.remove = {
      references: optionalStrings(remove.references, 'remove.references'),
      wires: optionalStrings(remove.wires, 'remove.wires', true),
      junctions: optionalStrings(remove.junctions, 'remove.junctions', true),
      labels: optionalStrings(remove.labels, 'remove.labels', true),
      noConnects: optionalStrings(remove.noConnects, 'remove.noConnects', true),
      notes: optionalStrings(remove.notes, 'remove.notes', true),
    }
  }
  if (input.moveLabels !== undefined) plan.moveLabels = array(input.moveLabels, 'moveLabels').map((item, index) => {
    const field = record(item, `moveLabels[${index}]`)
    keys(field, ['uuid', 'at', 'angle'], `moveLabels[${index}]`)
    return { uuid: uuid(field.uuid, `moveLabels[${index}].uuid`), at: point(field.at, `moveLabels[${index}].at`, true),
      ...(field.angle === undefined ? {} : { angle: angle(field.angle, `moveLabels[${index}].angle`) }) }
  })
  if (input.addLabels !== undefined) plan.addLabels = array(input.addLabels, 'addLabels').map((item, index) => {
    const field = record(item, `addLabels[${index}]`)
    keys(field, ['name', 'direction', 'at', 'angle'], `addLabels[${index}]`)
    return { name: string(field.name, `addLabels[${index}].name`, 128),
      direction: direction(field.direction, `addLabels[${index}].direction`),
      at: point(field.at, `addLabels[${index}].at`, true), angle: angle(field.angle, `addLabels[${index}].angle`) }
  })
  if (input.addWires !== undefined) plan.addWires = array(input.addWires, 'addWires').map((item, index) => {
    const field = record(item, `addWires[${index}]`)
    keys(field, ['from', 'to'], `addWires[${index}]`)
    return { from: point(field.from, `addWires[${index}].from`, true), to: point(field.to, `addWires[${index}].to`, true) }
  })
  if (input.addJunctions !== undefined) plan.addJunctions = array(input.addJunctions, 'addJunctions').map(
    (item, index) => point(item, `addJunctions[${index}]`, true))
  if (input.replaceNotes !== undefined) plan.replaceNotes = parseNotes(input.replaceNotes, 'replaceNotes')
  if (input.addNotes !== undefined) plan.addNotes = parseNotes(input.addNotes, 'addNotes')
  if (input.pinTypes !== undefined) plan.pinTypes = array(input.pinTypes, 'pinTypes').map((item, index) => {
    const field = record(item, `pinTypes[${index}]`)
    keys(field, ['reference', 'number', 'type'], `pinTypes[${index}]`)
    const type = string(field.type, `pinTypes[${index}].type`, 20)
    if (!['input', 'output', 'bidirectional', 'passive', 'power_in', 'power_out', 'unspecified', 'no_connect'].includes(type)) {
      throw new Error(`pinTypes[${index}].type is not a KiCad electrical pin type`)
    }
    return { reference: string(field.reference, `pinTypes[${index}].reference`, 128),
      number: string(field.number, `pinTypes[${index}].number`, 32), type: type as NonNullable<EditPlan['pinTypes']>[number]['type'] }
  })
  return plan
}

/** Validate the requested child-sheet pins against the edited labels. */
export function parsePorts(value: unknown): Port[] {
  return array(value, 'expectedPorts').map((item, index) => {
    const field = record(item, `expectedPorts[${index}]`)
    keys(field, ['name', 'direction'], `expectedPorts[${index}]`)
    return { name: string(field.name, `expectedPorts[${index}].name`, 128),
      direction: direction(field.direction, `expectedPorts[${index}].direction`) }
  })
}

/** Validate a tool's top-level object and return its named string field. */
export function requiredString(input: Record<string, unknown>, key: string, max = 300): string {
  return string(input[key], key, max)
}

/** Reject unexpected top-level arguments rather than silently ignoring a misspelling. */
export function validateKeys(input: unknown, allowed: string[], name: string): Record<string, unknown> {
  const fields = record(input, name)
  keys(fields, allowed, name)
  return fields
}

/** Parse an optional list of driven input labels. */
export function parseDrivenInputs(value: unknown): string[] { return optionalStrings(value, 'drivenInputs') }

/** Validate explicit child-sheet flag locations against the connection grid. */
export function parseChildPowerFlags(value: unknown): Array<{ connectAt: Point; symbolAt: Point }> {
  return value === undefined ? [] : array(value, 'childPowerFlags').map((item, index) => {
    const field = record(item, `childPowerFlags[${index}]`)
    keys(field, ['connectAt', 'symbolAt'], `childPowerFlags[${index}]`)
    return {
      connectAt: point(field.connectAt, `childPowerFlags[${index}].connectAt`, true),
      symbolAt: point(field.symbolAt, `childPowerFlags[${index}].symbolAt`, true),
    }
  })
}

/** Validate the pin-to-net claims that KiCad's exported netlist must satisfy. */
export function parseExpectedPins(value: unknown): ExpectedPin[] {
  if (value === undefined) return []
  const pins = array(value, 'expectedPins').map((item, index) => {
    const field = record(item, `expectedPins[${index}]`)
    keys(field, ['reference', 'pin', 'net'], `expectedPins[${index}]`)
    return {
      reference: string(field.reference, `expectedPins[${index}].reference`, 128),
      pin: string(field.pin, `expectedPins[${index}].pin`, 32),
      net: string(field.net, `expectedPins[${index}].net`, 128),
    }
  })
  const keysSeen = new Set(pins.map(pin => `${pin.reference}\0${pin.pin}`))
  if (keysSeen.size !== pins.length) throw new Error('expectedPins repeats a reference and pin number')
  return pins
}

/** Validate connected child-port entries for an assembly request. */
export function parsePortConnections(value: unknown, name: string): PortConnection[] {
  return array(value, name).map((item, index) => {
    const field = record(item, `${name}[${index}]`)
    keys(field, ['port', 'net'], `${name}[${index}]`)
    return { port: string(field.port, `${name}[${index}].port`, 128),
      net: string(field.net, `${name}[${index}].net`, 128) }
  })
}

/** Validate names of child ports intentionally left without root nets. */
export function parseUnconnectedPorts(value: unknown, name: string): string[] {
  return optionalStrings(value, name)
}

/**
 * Semantic netlist types for `@huaqiu/dsh-eda-host`.
 *
 * Self-contained structural mirror of `hq.ir.schematic.v1` (the hq-edge-owned
 * semantic protobuf contract). The plugin intentionally does NOT depend on
 * `@hqedge/*` — this file is the only place the wire shapes are named, so
 * keeping them aligned with the proto is a one-file concern.
 *
 * @module
 */

/** Electrical type of a pin — mirrors `hq.ir.logical.v1.ElectricalType`. */
export type ElectricalType =
  | 'ELECTRICAL_TYPE_UNSPECIFIED'
  | 'ELECTRICAL_TYPE_INPUT'
  | 'ELECTRICAL_TYPE_OUTPUT'
  | 'ELECTRICAL_TYPE_BIDIRECTIONAL'
  | 'ELECTRICAL_TYPE_TRISTATE'
  | 'ELECTRICAL_TYPE_PASSIVE'
  | 'ELECTRICAL_TYPE_POWER_IN'
  | 'ELECTRICAL_TYPE_POWER_OUT'
  | 'ELECTRICAL_TYPE_OPEN_COLLECTOR'
  | 'ELECTRICAL_TYPE_OPEN_EMITTER'
  | 'ELECTRICAL_TYPE_NO_CONNECT'

export interface PinDefinition {
  pinNumber: string
  pinName: string
  electricalType: ElectricalType
}

export interface SchematicComponent {
  referenceDesignators: string[]
  value: string
  manufacturerPartNumber: string
  footprint: string
  description: string
  pins: PinDefinition[]
}

export interface PinReference {
  referenceDesignator: string
  pinNumber: string
}

export interface ElectricalNet {
  name: string
  portName?: string
  pinReferences: PinReference[]
}

export interface SchematicNetlist {
  components: SchematicComponent[]
  nets: ElectricalNet[]
}

/**
 * Semantic error categories for netlist retrieval. Mirrors the gRPC status
 * contract of `hq.ir.schematic.v1.NetListService` so an agent can distinguish
 * "valid but empty" from "cannot answer at all".
 */
export type NetlistErrorKind =
  /** No EDA host is reachable (hq-edge not configured / host down). */
  | 'FAILED_PRECONDITION'
  /** The host does not implement this scope (e.g. active page on KiCad). */
  | 'UNIMPLEMENTED'
  /** Host-side runtime failure. */
  | 'INTERNAL'
  /** Host unavailable (connection refused). */
  | 'UNAVAILABLE'

export class NetlistError extends Error {
  readonly kind: NetlistErrorKind

  constructor(kind: NetlistErrorKind, message: string) {
    super(message)
    this.name = 'NetlistError'
    this.kind = kind
  }
}

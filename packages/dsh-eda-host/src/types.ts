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
 * Semantic PCB selection types.
 *
 * Self-contained structural mirror of `hq.pcb.v1` (the hq-edge-owned semantic
 * protobuf contract for `PcbSelectionService.GetSelection`). Units follow the
 * hq.pcb.v1 convention: positions/sizes/lengths in mm, rotations in degrees,
 * `id` is the KiCad native object identity.
 */

export interface PcbPoint {
  x: number
  y: number
}

export interface PcbNetRef {
  name: string
  code: number
}

export interface PcbPad {
  id: string
  pin: string
  type: string
  shape: string
  position?: PcbPoint
  widthMm: number
  heightMm: number
  rotationDeg: number
  layer: string
  net?: PcbNetRef
}

export interface PcbFootprint {
  id: string
  reference: string
  value: string
  footprint: string
  position?: PcbPoint
  rotationDeg: number
  pads: PcbPad[]
}

export interface PcbTrack {
  id: string
  layer: string
  start?: PcbPoint
  end?: PcbPoint
  widthMm: number
  lengthMm: number
  net?: PcbNetRef
}

export interface PcbArc {
  id: string
  layer: string
  start?: PcbPoint
  end?: PcbPoint
  mid?: PcbPoint
  net?: PcbNetRef
}

export interface PcbVia {
  id: string
  layers: string[]
  drillMm: number
  viaType: string
  start?: PcbPoint
  end?: PcbPoint
}

export interface PcbSegment {
  start?: PcbPoint
  end?: PcbPoint
}

export interface PcbZone {
  id: string
  layer: string
  net?: PcbNetRef
  outline: PcbSegment[]
}

export interface PcbShape {
  id: string
  layer: string
  shapeType: string
  start?: PcbPoint
  end?: PcbPoint
  center?: PcbPoint
  radiusMm: number
  mid?: PcbPoint
  widthMm: number
}

export interface PcbText {
  id: string
  layer: string
  text: string
  position?: PcbPoint
  rotationDeg: number
  hJustify: string
  vJustify: string
}

export interface PcbDimension {
  id: string
  layer: string
  start?: PcbPoint
  end?: PcbPoint
  value: string
  dimType: string
}

export interface PcbGroup {
  id: string
  itemIds: string[]
}

export interface PcbSelection {
  footprints: PcbFootprint[]
  pads: PcbPad[]
  tracks: PcbTrack[]
  arcs: PcbArc[]
  vias: PcbVia[]
  zones: PcbZone[]
  shapes: PcbShape[]
  texts: PcbText[]
  dimensions: PcbDimension[]
  groups: PcbGroup[]
  nets: PcbNetRef[]
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
  /** The host did not answer within the request budget. */
  | 'DEADLINE_EXCEEDED'

export class NetlistError extends Error {
  readonly kind: NetlistErrorKind

  constructor(kind: NetlistErrorKind, message: string) {
    super(message)
    this.name = 'NetlistError'
    this.kind = kind
  }
}

// ---------------------------------------------------------------------------
// EDA host discovery — structural mirror of `hq.host.v1`
// ---------------------------------------------------------------------------

/**
 * `hq.host.v1` carries **no availability flags**.
 *
 * A host that answers `GetEdaHostInfo` is, by definition, available, and every
 * executable it lists is one it can actually run. Unavailability is therefore
 * never a field to check — it is a failed request, surfaced as `ok:false` with
 * `error.kind` `UNAVAILABLE` / `FAILED_PRECONDITION` / `DEADLINE_EXCEEDED`.
 *
 * Consequence for consumers: never infer "unavailable" from a missing or empty
 * value. Absence of `identity`/`installation` just means proto3 omitted
 * defaults (see `parseEdaHostInfo`), and empty `path` only means the host could
 * not resolve an absolute location — the tool is still runnable by name.
 */

/**
 * Which EDA application sits behind the semantic host boundary.
 *
 * Deliberately EDA-independent: a new host adds a value here rather than
 * introducing host-specific messages or tools.
 */
export type EdaHostType =
  | 'EDA_HOST_TYPE_UNSPECIFIED'
  | 'EDA_HOST_TYPE_KICAD'
  | 'EDA_HOST_TYPE_HQ_EDA'

/**
 * A capability an EDA host may provide.
 *
 * A capability is advertised only when the host can actually provide it —
 * discovering a capability is not the same as implementing it. Unknown values
 * MUST be treated as "not supported" so a newer host cannot confuse an older
 * plugin.
 */
export type EdaHostCapability =
  | 'EDA_HOST_CAPABILITY_UNSPECIFIED'
  | 'EDA_HOST_CAPABILITY_SCHEMATIC'
  | 'EDA_HOST_CAPABILITY_PCB'
  | 'EDA_HOST_CAPABILITY_NETLIST'
  | 'EDA_HOST_CAPABILITY_NETLIST_SELECTION'
  | 'EDA_HOST_CAPABILITY_NETLIST_ACTIVE_PAGE'
  | 'EDA_HOST_CAPABILITY_ERC'
  | 'EDA_HOST_CAPABILITY_DRC'
  | 'EDA_HOST_CAPABILITY_BOM'
  | 'EDA_HOST_CAPABILITY_PLACEMENT'

/** A host-provided command line tool. */
export interface EdaHostExecutable {
  /** Stable tool name, e.g. "kicad-cli". */
  name: string
  /**
   * Absolute path when the host could resolve one.
   *
   * Empty means "resolvable by name only" (e.g. found on `PATH` but the host
   * did not report a location) — never "not installed" or "unusable".
   */
  path: string
}

/** Where the host application lives on disk. */
export interface EdaHostInstallation {
  applicationPath: string
  /**
   * Executables the host can run. Being listed here IS the availability
   * signal: there is no per-executable availability flag.
   */
  executables: EdaHostExecutable[]
}

/** Which EDA host is connected. */
export interface EdaHostIdentity {
  hostType: EdaHostType
  hostName: string
  version: string
}

/**
 * EDA-independent description of the connected host.
 *
 * Answering this message is the host's way of saying it is available — there is
 * no `available` field to inspect.
 */
export interface EdaHostInfo {
  identity: EdaHostIdentity
  installation: EdaHostInstallation
}

/**
 * Shared domain types for the SVG footprint editor — ported from NextChat's
 * `editFootprint/interfaces.ts`, adapted to the DSH plugin module layout.
 */

/** One editable data point positioned on the package SVG background. */
export interface DataPoint {
  id: string
  /** X offset in pixels relative to the SVG origin. */
  x: number
  /** Y offset in pixels relative to the SVG origin. */
  y: number
  /** Default value shown when the backend returns nothing for this key. */
  value: string | number
  /** Edit control type. */
  type: 'input' | 'select'
  /** Options for a `select` point. */
  options?: string[]
  /** Reserved field — forwards backend-specific hints. */
  others?: unknown
}

/** Decorative dimension-divider tick rendered between paired min/max points. */
export interface Divider {
  x: number
  y: number
  direction?: 'horizontal' | 'vertical'
}

/** One extra form field shown below the SVG diagram (package-type select, pin counts, …). */
export interface ExtraField {
  name: string
  label: string
  type: 'input' | 'select'
  value: string | number
  options?: Array<{ value: string; label: string }>
  required?: boolean
}

/** The full per-package-type configuration — imported from NextChat one-pkg-per-file. */
export interface PkgConfig {
  DataPointList: DataPoint[]
  dividerList: Divider[]
  extraFieldsList?: ExtraField[]
}

/** Generic key/value form data (dimensions or extra fields). */
export interface FormData {
  [key: string]: string | number
}

/** All supported package families — matches the Node-side `packageTypes`. */
export const PKG_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'bga', label: 'BGA' },
  { value: 'dip', label: 'DIP' },
  { value: 'plcc', label: 'PLCC' },
  { value: 'qfn', label: 'QFN' },
  { value: 'son', label: 'SON' },
  { value: 'qfp', label: 'QFP' },
  { value: 'sop', label: 'SOP' },
  { value: 'sot23', label: 'SOT23' },
]

/** Resolve the per-family config, returning a safe empty one for unknown types. */
export function resolvePkgConfig(pkgType: string | null): PkgConfig {
  if (!pkgType) return { DataPointList: [], dividerList: [], extraFieldsList: [] }
  const map = ALL_CONFIGS as Record<string, PkgConfig | undefined>
  return map[pkgType.toLowerCase()] ?? { DataPointList: [], dividerList: [], extraFieldsList: [] }
}

// The registry is populated at the bottom of this file after all per-pkg
// modules are imported. Import ordering is irrelevant — each module registers
// into this map at its own top level.
export const ALL_CONFIGS: Record<string, PkgConfig> = {}

/**
 * Central registry for per-package-type configurations.
 *
 * Each per-pkg module registers itself into `ALL_CONFIGS` at import time,
 * so importing the config index is sufficient to populate the map used by
 * `resolvePkgConfig()`.
 */
import './bga.js'
import './dip.js'
import './plcc.js'
import './qfn.js'
import './qfp.js'
import './son.js'
import './sop.js'
import './sot23.js'
import './notfound.js'

export { ALL_CONFIGS, PKG_TYPE_OPTIONS, resolvePkgConfig, type PkgConfig, type DataPoint, type Divider, type ExtraField, type FormData } from '../types.js'

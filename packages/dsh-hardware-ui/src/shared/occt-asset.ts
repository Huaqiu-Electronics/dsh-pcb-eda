/**
 * Route and file name of the packaged STEP reader, shared by both halves.
 *
 * The browser half must fetch the `.wasm` from a same-origin URL and the Node
 * half is the only side that can read the installed package's `dist` directory,
 * so the two must agree on exactly one string. Sharing it here is cheaper than
 * a protocol and impossible to drift: a change breaks both bundles or neither.
 *
 * Why a plugin route rather than a CDN or an inline base64 blob: the ordering
 * spec requires the preview to work with no network access (§7.4, §12.3), and
 * base64-inlining 7.6 MB into the client bundle would parse on every DSH start
 * whether or not a STEP document is ever opened.
 *
 * @module @huaqiu/dsh-hardware-ui/shared/occt-asset
 */

/** Absolute route the Host serves the reader wasm from; also the browser's fetch URL. */
export const OCCT_WASM_ROUTE = '/hardware-ui/assets/occt-import-js.wasm'

/** File name inside the installed `occt-import-js` package. */
export const OCCT_WASM_FILE = 'occt-import-js.wasm'

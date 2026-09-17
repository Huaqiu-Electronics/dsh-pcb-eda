/**
 * Browser half entry — DSH client plugin (turn-tail card + singleton panel).
 * Everything lives in ./panel.tsx; this entry exists so the tsdown client
 * bundle has a stable, conventional entry path (matches the other plugins).
 */
export { apply, inject } from './panel.js'

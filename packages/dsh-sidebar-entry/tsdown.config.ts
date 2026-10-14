import { defineConfig } from 'tsdown'

/**
 * One ESM entry with types.
 *
 * This package is a PLAIN LIBRARY module, not a DSH client plugin: it never
 * registers itself in the DSH client module table. Every consumer's client
 * bundle must therefore `alwaysBundle` it (see
 * `dsh-tool-symbol-footprint/tsdown.config.ts`), or the browser runtime fails
 * with "require(...) missed the module table".
 */
export default defineConfig([
  {
    entry: ['./src/index.ts'],
    format: ['esm'],
    dts: true,
    outDir: 'lib',
  },
])

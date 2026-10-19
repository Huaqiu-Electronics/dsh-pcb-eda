import {defineConfig} from 'tsup'

export default defineConfig({
  entry: {index: 'src/index.ts', builder: 'src/builder.ts'},
  format: ['esm'], platform: 'node', target: 'node22', outDir: 'lib',
  bundle: true, splitting: false, clean: true,
  dts: true, tsconfig: 'tsconfig.build.json',
  // Host services retain their identity. Native modules and PDF.js assets are
  // copied alongside the bundle by vendor-runtime.mjs instead of installed by DSH.
  external: [/^@deepseek-ai\/(?!schemastery$|cosmokit$)/, 'sharp', 'pdfjs-dist'],
  noExternal: [/^(?!@deepseek-ai\/|sharp(?:\/|$)|pdfjs-dist(?:\/|$))/, '@deepseek-ai/schemastery', '@deepseek-ai/cosmokit'],
  banner: {js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"},
})

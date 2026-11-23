import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/index.ts', './src/service.ts', './src/routes.ts'],
  format: ['esm'],
  dts: true,
  deps: { neverBundle: [/^@deepseek-ai\//] },
  outDir: 'lib',
})

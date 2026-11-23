import { defineConfig } from 'tsdown'

const CLIENT_ID = '@huaqiu/dsh-hardware-ui'

export default defineConfig([
  {
    entry: ['./src/index.ts'],
    format: ['esm'],
    dts: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
    outDir: 'lib',
  },
  {
    name: `${CLIENT_ID}/client`,
    entry: { client: './src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: [/^@deepseek-ai\//, 'react', 'react-dom', /^react\//],
      // Browser-only rendering deps must be inlined: the DSH client ModuleLoader
      // can only `require` its own injected modules, not arbitrary npm packages.
      alwaysBundle: [
        /^@huaqiu\/(ecad-renderer|ecad-viewer-app)(\/|$)/,
        /^@huaqiu\/kicad-sexpr-parser(\/|$)/,
        'immutable',
        'jszip',
        'three',
        /^three\//,
      ],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])

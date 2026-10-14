import { defineConfig } from 'tsdown'

const CLIENT_ID = '@huaqiu/dsh-eda-selection'

export default defineConfig([
  {
    // Node half: ESM prompt-section entry.
    entry: ['./src/index.ts'],
    format: ['esm'],
    dts: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
    outDir: 'lib',
  },
  {
    // Browser half: DSH client-module bundle (classic script, self-registering).
    name: `${CLIENT_ID}/client`,
    entry: { client: './src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    // react stays external (platform seed word), @deepseek-ai stays external
    // (provided by the DSH platform). There are no plain-library @huaqiu/*
    // modules here — the whole browser half is our own source — so no
    // alwaysBundle entry is needed.
    deps: {
      neverBundle: [/^react$/, /^react\//, /^@deepseek-ai\//],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])

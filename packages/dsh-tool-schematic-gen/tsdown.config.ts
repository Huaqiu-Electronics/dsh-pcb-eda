import { defineConfig } from 'tsdown'

const CLIENT_ID = '@huaqiu/dsh-tool-schematic-gen'

export default defineConfig([
  {
    // Node half: ESM tool entry (tool definitions).
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
    // (provided by the DSH platform). The browser-safe
    // @huaqiu/dsh-artifacts/placement subpath is a plain library module (not a
    // DSH client plugin) that never registers itself in the DSH client module
    // table, so it MUST be bundled into this client bundle or the runtime
    // fails with "missed the module table". Note the subpath-aware pattern: an
    // anchored `^...$` regex would NOT match `@huaqiu/dsh-artifacts/placement`
    // and would silently externalize it. Force-bundle it here.
    deps: {
      neverBundle: [/^react$/, /^react\//, /^@deepseek-ai\//],
      alwaysBundle: [
        /^@huaqiu\/dsh-artifacts(\/|$)/,
        // Shared family sidebar-entry helper: a plain library module, so it
        // must be bundled or the runtime fails with "missed the module table".
        /^@huaqiu\/dsh-sidebar-entry$/,
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

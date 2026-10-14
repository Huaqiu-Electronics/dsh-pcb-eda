import type { UserConfig } from 'tsdown';
import { readFile } from 'node:fs/promises';
const external = [/^@deepseek-ai\//, /^react(?:\/|$)/, /^react-dom(?:\/|$)/];
const host: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  external,
  outputOptions: { entryFileNames: 'index.js' },
};
const client: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  // The DSH module loader loads JS only; bundle the CSS text for local injection.
  plugins: [
    {
      name: 'routing-card-css',
      async load(id) {
        if (!id.endsWith('.css?inline')) {
          return;
        }
        const css = await readFile(id.slice(0, -'?inline'.length), 'utf8');
        return `export default ${JSON.stringify(css)};`;
      },
    },
  ],
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'chrome110',
  dts: false,
  clean: false,
  sourcemap: true,
  external,
  noExternal: [/^zod(?:\/|$)/],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@huaqiu/dsh-tool-freerouting", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
};
export default [host, client];

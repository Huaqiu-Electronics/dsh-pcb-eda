import { defineConfig } from 'tsdown'

const CLIENT_ID = '@huaqiu/dsh-tool-pcb-viewer'

export default defineConfig([
  {
    // Node 半边：host 插件入口（工具 + 路由）。
    entry: ['./src/index.ts'],
    format: ['esm'],
    dts: true,
    deps: { neverBundle: [/^@deepseek-ai\//, /^@huaqiu\//] },
    outDir: 'lib',
  },
  {
    // 浏览器半边：DSH client-module bundle（自注册 classic script）。
    name: `${CLIENT_ID}/client`,
    entry: { client: './src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    // 发布物不带 sourcemap（4MB map 对终端用户没有价值）
    sourcemap: false,
    clean: false,
    // react 由 shell 注册表提供；@deepseek-ai 由平台提供；three 与渲染器打进来。
    deps: {
      neverBundle: [/^react$/, /^react\//, /^@deepseek-ai\//],
      // three 与渲染器、parser 全打进来（DSH shell 只提供 react/react-dom）
      alwaysBundle: [/^three(\/|$)/, /^@huaqiu\/kicad-sexpr-parser/],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
  {
    // 独立整页 bundle（/pcb-viewer/view 的 <script src>）—— 纯 IIFE，无 ModuleLoader 包装。
    name: `${CLIENT_ID}/standalone`,
    entry: { standalone: './src/client/standalone.ts' },
    outDir: 'lib',
    format: 'iife',
    platform: 'browser',
    dts: false,
    sourcemap: false,
    clean: false,
    // 独立页完全自包含：three、parser、渲染器全打进来（无 react 依赖）
    deps: { neverBundle: [], alwaysBundle: [/^three(\/|$)/, /^@huaqiu\/kicad-sexpr-parser/] },
    outputOptions: { entryFileNames: 'standalone.js' },
  },
])

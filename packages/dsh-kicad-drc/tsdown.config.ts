import { defineConfig, type UserConfig } from 'tsdown'

/** host 半边：Node ESM bundle（DSH 插件入口）。 */
const host: UserConfig = {
  name: 'dsh-kicad-drc',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  dts: true,
  clean: true,
  hash: false,
  fixedExtension: false,
  sourcemap: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/schemastery',
    ],
  },
}

/**
 * client 半边：浏览器 CJS factory bundle（window.__ModuleLoader__.load 包装）。
 * react / react/jsx-runtime 不打进 bundle，运行时从 DSH 模块表 require（shell 提供单例）。
 */
const client: UserConfig = {
  name: 'dsh-kicad-drc-client',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  dts: false,
  clean: false, // host 配置已负责清空 lib/
  hash: false,
  fixedExtension: true,
  outExtension: () => ({ js: '.js', css: '.css' }), // 输出 lib/client.js（与 @huaqiu/dsh-tool-pcb-viewer 命名一致）
  sourcemap: true,
  external: ['react', 'react/jsx-runtime'],
  banner:
    'window.__ModuleLoader__.load({\n'
    + '\tid: "dsh-kicad-drc",\n'
    + '\tfactory: (require) => {\n'
    + '\tvar module = { exports: {} };\n'
    + '\tvar exports = module.exports;',
  footer: '\treturn module.exports;\n}\n});',
}

export default defineConfig([host, client])

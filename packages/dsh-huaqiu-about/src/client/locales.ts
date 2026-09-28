/** About-section dictionaries. */

export const zh = {
  nav: '关于',
  slogan: '电子设计智能体平台',
  runtimeLabel: 'DSH 运行时',
  distributionLabel: '发行版本',
  builtinPluginLabel: '内置插件版本',
  copyMetadata: '复制元数据 (Metadata)',
  copied: '版本信息已复制',
  copyright: '© 2026 深圳华秋智联股份有限公司',
  poweredBy: '由 DSH 提供支持',
} as const

export type AboutKey = keyof typeof zh

export const en: Record<AboutKey, string> = {
  nav: 'About',
  slogan: 'Electronic Design Agent Platform',
  runtimeLabel: 'DSH Runtime',
  distributionLabel: 'Distribution',
  builtinPluginLabel: 'Builtin plugin version',
  copyMetadata: 'Copy metadata',
  copied: 'Metadata copied',
  copyright: '© 2026 Shenzhen Huaqiu Zhilian Co., Ltd.',
  poweredBy: 'Powered by DSH',
}

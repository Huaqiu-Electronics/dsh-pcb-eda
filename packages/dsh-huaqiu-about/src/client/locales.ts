/** About-section dictionaries. */

export const zh = {
  nav: '关于',
} as const

export type AboutKey = keyof typeof zh

export const en: Record<AboutKey, string> = {
  nav: 'About',
}

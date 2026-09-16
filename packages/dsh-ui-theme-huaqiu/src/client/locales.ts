/** HuaQiu brand dictionaries. */

export const zh = {
  name: '华秋',
  slogan: '电子设计智能体平台',
} as const

export type HuaqiuBrandKey = keyof typeof zh

export const en: Record<HuaqiuBrandKey, string> = {
  name: 'HuaQiu',
  slogan: 'Electronic Design Agent Platform',
}

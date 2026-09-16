/** HuaQiu color tokens and HQ brand occupants for a DSH Web client. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import { createElement } from 'react'
import { HuaqiuBrandMark, HuaqiuBrandName } from './HuaqiuBrand'
import { installLegacyHeroBranding } from './legacyHeroBranding'
import { en, zh, type HuaqiuBrandKey } from './locales'

export const inject = ['theme', 'slots', 'locale']
export const HUAQIU_BRAND_NS = 'brand.huaqiu'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'brand.huaqiu': HuaqiuBrandKey
  }
}

export const HUAQIU_TOKENS: ThemeTokenOverrides = {
  '--dsw-alias-brand-primary': { light: '#C7000B', dark: '#FF6B74' },
  '--dsw-alias-brand-primary-invert': { light: '#FFFFFF', dark: '#210002' },
  '--dsw-alias-brand-primary-new-colorprimary-new-color': { light: '#C7000B', dark: '#FF6B74' },
  '--dsw-alias-brand-text': { light: '#C7000B', dark: '#FF6B74' },
  '--dsw-alias-button-info-fill': { light: '#C7000B', dark: '#FF6B74' },
  '--dsw-alias-button-info-hover': { light: '#E53935', dark: '#FF8A92' },
  '--dsw-alias-button-primary-dimmed': { light: '#FFCDD2', dark: '#5C1118' },
  '--dsw-alias-button-primary-fill': { light: '#C7000B', dark: '#FF6B74' },
  '--dsw-alias-button-primary-hover': { light: '#E53935', dark: '#FF8A92' },
  '--dsw-alias-interactive-bg-hover-accent': { light: 'rgb(199 0 11 / 12%)', dark: 'rgb(255 107 116 / 22%)' },
  '--dsw-alias-link': { light: '#C7000B', dark: '#FF8A92' },
  '--dsw-alias-state-business-primary': { light: '#C7000B', dark: '#FF6B74' },
  '--dsw-alias-state-business-tertiary': { light: '#FFCDD2', dark: '#5C1118' },
  '--dsw-specific-bubble': { light: '#FFF5F5', dark: '#351116' },
  '--dsw-specific-bubble-highlight': { light: '#FFCDD2', dark: '#5C1118' },
  '--dsw-specific-sidebar-fill': { light: '#FAFAFA', dark: '#211316' },
  '--dsw-specific-sidebar-nav-item-active-accent': { light: '#FFCDD2', dark: '#5C1118' },
  '--dsw-static-deepseek-50': { light: '#FFF5F5', dark: '#351116' },
  '--dsw-static-deepseek-100': { light: '#FFEBEE', dark: '#5C1118' },
  '--dsw-static-deepseek-200': { light: '#FFCDD2', dark: '#7A1E28' },
  '--dsw-static-deepseek-300': { light: '#EF9A9A', dark: '#A52B37' },
  '--dsw-static-deepseek-400': { light: '#E53935', dark: '#FF8A92' },
  '--dsw-static-deepseek-450': { light: '#D32F2F', dark: '#FF6B74' },
  '--dsw-static-deepseek-500': { light: '#C7000B', dark: '#FF6B74' },
  '--dsw-static-deepseek-600': { light: '#C62828', dark: '#FF555F' },
  '--dsw-static-deepseek-700-delete': { light: '#B71C1C', dark: '#FF3F4B' },
  '--dsw-static-deepseek-800': { light: '#8E111A', dark: '#FFCDD2' },
  '--dsw-static-deepseek-900': { light: '#5F0007', dark: '#FFE7E9' },
}

/** Install HuaQiu colors and brand occupants without altering the host source. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.theme.overrideTokens('@huaqiu/dsh-ui-theme-huaqiu', HUAQIU_TOKENS), 'huaqiu theme: token override')
  ctx.effect(() => ctx.locale.register(HUAQIU_BRAND_NS, { zh, en }), 'huaqiu theme: brand dictionaries')
  const t = ctx.locale.bind(HUAQIU_BRAND_NS)
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, ({ size }) => createElement(HuaqiuBrandMark, { size })))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name' }, () => createElement(HuaqiuBrandName, { label: t('name') })))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, ({ size, className }) => createElement(HuaqiuBrandMark, { className, size })))
  ctx.effect(() => installLegacyHeroBranding(() => t('slogan')), 'huaqiu theme: legacy hero branding')
}

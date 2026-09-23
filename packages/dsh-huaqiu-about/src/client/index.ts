/**
 * `@huaqiu/dsh-huaqiu-about` — browser half.
 *
 * Contributes an "About" row to the DSH settings page through the
 * `settings.section` slot (the same mechanism the community `dsh-market`
 * plugin uses). The row shows the original DSH fish mark, the DSH version
 * bundled with the running harness (fetched from the node half's
 * same-origin route), and the "Powered by DSH" claim.
 */
import { createElement } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AboutSection } from './AboutSection'
import { en, zh, type AboutKey } from './locales'

export const inject = ['slots', 'locale'] as const

export const ABOUT_NS = 'about.huaqiu'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'about.huaqiu': AboutKey
  }
}

/**
 * Minimal structural client context (the DSH client runtime provides these
 * faces). Declared structurally, never imported, so the package stays
 * independently installable — the same pattern as
 * `@huaqiu/dsh-tool-schematic-gen`.
 */
export interface ClientContext {
  slots?: {
    inject(key: string, callback: () => () => void): () => void
    register(spec: {
      name: string
      id?: string
      order?: number
      label?: () => string
      locale?: string
    }, component: unknown): () => void
  }
  locale?: {
    register(namespace: string, dictionaries: unknown): unknown
    bind(namespace: string): (key: string) => string
  }
  effect?(fn: () => (() => void) | void, label?: string): void
}

/**
 * Install the About row on the running client context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect?.(() => { ctx.locale?.register(ABOUT_NS, { zh, en }) }, 'huaqiu about: dictionaries')
  const t = ctx.locale?.bind(ABOUT_NS) ?? (() => 'About')
  const slots = ctx.slots
  if (!slots) return
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'huaqiu-about',
    order: 90,
    label: () => t('nav'),
    locale: ABOUT_NS,
  }, () => createElement(AboutSection)))
}

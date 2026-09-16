/** DOM-level replacement for the shipped blank-session headline and preview badge. */

const HERO_HEADLINES = new Set(['探索未至之境', 'Into the Unknown'])
const PREVIEW_BADGES = new Set(['预览版', 'Preview'])
const TITLE_ATTRIBUTE = 'data-huaqiu-hero-title'
const TITLE_ORIGINAL_ATTRIBUTE = 'data-huaqiu-hero-title-original'
const BADGE_ATTRIBUTE = 'data-huaqiu-hero-badge'
const BADGE_DISPLAY_ATTRIBUTE = 'data-huaqiu-hero-badge-display'

function leafText(node: HTMLSpanElement): string | undefined {
  return node.childElementCount === 0 ? node.textContent?.trim() : undefined
}

function replaceHeroTitle(title: HTMLSpanElement, slogan: string): void {
  const parent = title.parentElement
  if (parent === null) return
  const badge = [...parent.querySelectorAll('span')].find(node => PREVIEW_BADGES.has(leafText(node) ?? ''))
  if (badge === undefined) return
  if (!title.hasAttribute(TITLE_ATTRIBUTE)) {
    title.setAttribute(TITLE_ORIGINAL_ATTRIBUTE, title.textContent ?? '')
    title.setAttribute(TITLE_ATTRIBUTE, '')
  }
  if (title.textContent !== slogan) title.textContent = slogan
  if (!badge.hasAttribute(BADGE_ATTRIBUTE)) {
    badge.setAttribute(BADGE_DISPLAY_ATTRIBUTE, badge.style.display)
    badge.setAttribute(BADGE_ATTRIBUTE, '')
  }
  if (badge.style.display !== 'none') badge.style.display = 'none'
}

function applyHeroBranding(slogan: string): void {
  for (const title of document.querySelectorAll<HTMLSpanElement>('span')) {
    const text = leafText(title)
    if (HERO_HEADLINES.has(text ?? '') || title.hasAttribute(TITLE_ATTRIBUTE)) replaceHeroTitle(title, slogan)
  }
}

function restoreHeroBranding(): void {
  for (const title of document.querySelectorAll<HTMLSpanElement>(`span[${TITLE_ATTRIBUTE}]`)) {
    title.textContent = title.getAttribute(TITLE_ORIGINAL_ATTRIBUTE) ?? ''
    title.removeAttribute(TITLE_ATTRIBUTE)
    title.removeAttribute(TITLE_ORIGINAL_ATTRIBUTE)
  }
  for (const badge of document.querySelectorAll<HTMLSpanElement>(`span[${BADGE_ATTRIBUTE}]`)) {
    badge.style.display = badge.getAttribute(BADGE_DISPLAY_ATTRIBUTE) ?? ''
    badge.removeAttribute(BADGE_ATTRIBUTE)
    badge.removeAttribute(BADGE_DISPLAY_ATTRIBUTE)
  }
}

/**
 * Brand the stock blank-session hero without a host-source modification.
 * @param slogan localized HuaQiu slogan for the active browser locale.
 * @returns disposer restoring modified DOM nodes when the plugin unloads.
 */
export function installLegacyHeroBranding(slogan: () => string): () => void {
  applyHeroBranding(slogan())
  const observer = new MutationObserver(() => { applyHeroBranding(slogan()) })
  observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true })
  return () => {
    observer.disconnect()
    restoreHeroBranding()
  }
}

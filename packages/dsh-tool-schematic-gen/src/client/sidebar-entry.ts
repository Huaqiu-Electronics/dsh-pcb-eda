/**
 * `@huaqiu/dsh-tool-schematic-gen` — the `Schematic Gen` sidebar toolbutton.
 *
 * Mounts one row through the shared family helper
 * (`@huaqiu/dsh-sidebar-entry`), in the same block and with the same look as
 * the component-gen rows (封装生成 / Symbol 生成). Unlike those, clicking this
 * row does NOT open a workspace: it inserts a `Generate schematic` reference
 * chip into the current session's composer.
 *
 * The row is plain DOM; the chip it inserts is real DSH composer state.
 *
 * @module
 */
import {
  HUAQIU_SIDEBAR_ENTRY_FAMILY,
  detectHostLocale,
  mountSidebarEntry,
  observeHostLocale,
  type HostLocale,
  type SidebarEntryOptions,
} from '@huaqiu/dsh-sidebar-entry'

/** Stable data attribute identifying the injected row. */
export const SCHEMATIC_ENTRY_SELECTOR = '[data-hqcg-schematic-entry]'

/** Full attribute name (the helper's idempotency key). */
export const SCHEMATIC_ENTRY_ATTRIBUTE = 'data-hqcg-schematic-entry'

/** L2 semantic plugin id: rows carry data-dsh-plugin + data-dsh-part. */
const PLUGIN_ID = 'huaqiu-schematic-gen'

/** Row class names (defined by {@link ENTRY_CSS_TEXT}). */
const ENTRY_CSS: Record<string, string> = {
  entry: 'hqcg-schematic-sidebar-entry',
  entryIcon: 'hqcg-schematic-sidebar-entry__icon',
  entryLabel: 'hqcg-schematic-sidebar-entry__label',
}

/** Localized row copy: zh is the fallback, matching the HIT card. */
const COPY = {
  zh: {
    label: '原理图生成',
    tooltip: '在输入框插入「生成原理图」引用',
  },
  en: {
    label: 'Schematic Gen',
    tooltip: 'Insert a "Generate schematic" reference into the composer',
  },
} as const

/**
 * Resolve the row copy for one language.
 * @param lang - resolved host language; undefined falls back to zh.
 * @returns the label/tooltip pair.
 */
export function schematicEntryCopy(lang: HostLocale | undefined): { label: string; tooltip: string } {
  return lang === 'en' ? COPY.en : COPY.zh
}

/**
 * Inline schematic glyph — cropped to the artwork's ink, `currentColor` so it
 * inherits the sidebar text/theme colour, 16×16 like the shell's nav glyphs
 * (18×18 on the collapsed rail).
 */
export const SCHEMATIC_ICON =
`
<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Schematic Sheet Frame -->
  <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  
  <!-- Circuit Wires & Connection Nodes -->
  <path d="M7 8H10M14 8H17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M10 16H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M10 8V16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  
  <!-- Component Symbol (Resistor / Block representation) -->
  <path d="M10 10L11 11L12 9L13 11L14 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  
  <!-- Junction Nodes / Pins -->
  <circle cx="7" cy="8" r="1.5" fill="currentColor"/>
  <circle cx="17" cy="8" r="1.5" fill="currentColor"/>
  <circle cx="10" cy="16" r="1.5" fill="currentColor"/>
  <circle cx="14" cy="16" r="1.5" fill="currentColor"/>
</svg>
`


/**
 * Row styles — matched to the shipped `sidebar.panellist` rows and to the
 * component-gen rows, so the family block sits flush with the shell's own
 * entries.
 */
const ENTRY_CSS_TEXT = `
.hqcg-schematic-sidebar-entry {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin: 0 2px;
  min-height: 36px;
  padding: 7px 8px;
  background: transparent;
  border: none;
  border-radius: 12px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font: inherit;
  line-height: 22px;
  text-align: left;
  white-space: nowrap;
}
.hqcg-schematic-sidebar-entry:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.hqcg-schematic-sidebar-entry[data-active] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.hqcg-schematic-sidebar-entry__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.hqcg-schematic-sidebar-entry__icon svg {
  display: block;
  width: 16px;
  height: 16px;
}
.hqcg-schematic-sidebar-entry__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Collapsed rail: icon-only, centered — the same 36px square the shell uses. */
[data-dsh-frame][data-sidebar-collapsed] .hqcg-schematic-sidebar-entry,
[data-sidebar-collapsed] .hqcg-schematic-sidebar-entry {
  justify-content: center;
  width: 36px;
  height: 36px;
  margin: 0;
  padding: 0;
}
[data-dsh-frame][data-sidebar-collapsed] .hqcg-schematic-sidebar-entry__icon svg,
[data-sidebar-collapsed] .hqcg-schematic-sidebar-entry__icon svg {
  width: 18px;
  height: 18px;
}
[data-dsh-frame][data-sidebar-collapsed] .hqcg-schematic-sidebar-entry__label,
[data-sidebar-collapsed] .hqcg-schematic-sidebar-entry__label {
  display: none;
}
`

/** Style tag id used for idempotent style injection. */
const STYLE_TAG_ID = 'data-plugin-css="huaqiu-schematic-gen-sidebar"'

/** Inject the row stylesheet once (idempotent). */
export function injectSchematicEntryStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[${STYLE_TAG_ID}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = 'huaqiu-schematic-gen-sidebar'
  tag.textContent = ENTRY_CSS_TEXT
  document.head.appendChild(tag)
}

/** Row mount options (the fields `workspace`-style callers supply). */
export interface SchematicEntryOptions {
  /** Click action: insert the chip. */
  onToggle(): void
  /** Family-block position: 'before' leads, 'after' trails. */
  position?: SidebarEntryOptions['position']
}

/**
 * Mount the `Schematic Gen` sidebar row.
 *
 * Localization follows the host UI language through `<html lang>`
 * (`dsh-client-locale` rewrites it on every language change and HQ Edge mirrors
 * it), so the row re-labels itself without a `locale` service dependency.
 *
 * @param options - click action and family-block position.
 * @returns disposer removing the row, its observers and its locale listener.
 */
export function mountSchematicGenSidebarEntry(options: SchematicEntryOptions): () => void {
  if (typeof document === 'undefined') return () => {}
  injectSchematicEntryStyles()

  const listeners = new Set<() => void>()
  const announce = (): void => {
    for (const fn of [...listeners]) {
      try { fn() } catch { /* one bad subscriber must not strand the rest */ }
    }
  }

  let lang = detectHostLocale()
  const stopLocale = observeHostLocale((next) => {
    lang = next
    announce()
  })

  const dispose = mountSidebarEntry({
    rowAttribute: SCHEMATIC_ENTRY_ATTRIBUTE,
    rowSelector: SCHEMATIC_ENTRY_SELECTOR,
    plugin: PLUGIN_ID,
    icon: SCHEMATIC_ICON,
    css: ENTRY_CSS,
    label: () => schematicEntryCopy(lang).label,
    tooltip: () => schematicEntryCopy(lang).tooltip,
    refresh: { subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } } },
    onToggle: options.onToggle,
    position: options.position ?? 'after',
    // The SAME list the component-gen rows pass, so the family keeps one
    // stable order whichever plugin mounts first.
    familySelectors: HUAQIU_SIDEBAR_ENTRY_FAMILY,
  })

  return () => {
    dispose()
    stopLocale()
    listeners.clear()
  }
}

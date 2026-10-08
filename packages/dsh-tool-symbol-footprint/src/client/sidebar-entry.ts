/**
 * `@huaqiu/dsh-tool-symbol-footprint` — sidebar entry wiring over the shared
 * injection core (`sidebar-entry-core.ts`, adapted from dsh-web's task-board /
 * skill-explorer / ssh pattern).
 *
 * Injects two compact rows — 封装生成 and Symbol 生成 — between the shell's New
 * Session button and the workspace browser, instead of the previous cramped
 * `sidebar.footer.action` buttons. Each row toggles the shared
 * `shell.overlay` workspace on its page. The row is plain DOM (no React tree);
 * the overlay it toggles is the React workspace owned by `workspace.tsx`.
 */
import { mountSidebarEntry as mountSharedSidebarEntry } from './sidebar-entry-core.js'

/** Stable data attributes identifying the injected entry rows. */
export const FOOTPRINT_ENTRY_SELECTOR = '[data-hqcg-footprint-entry]'
export const SYMBOL_ENTRY_SELECTOR = '[data-hqcg-symbol-entry]'

/** L2 semantic plugin id (issue #506): rows carry data-dsh-plugin + data-dsh-part. */
const PLUGIN_ID = 'huaqiu-component-gen'

/**
 * Inline icons (footprint.svg / symbol.svg from the repo root). Both viewBoxes
 * are cropped to the artwork's ink so the glyph fills the icon slot instead of
 * canvas padding. The rendered size is pinned by CSS to 16×16 (the shell's
 * wide nav-glyph size — same as the official Plugins entry) and grows to 18×18
 * on the collapsed rail. Both use `currentColor` so they inherit the sidebar
 * text/theme color.
 */
export const FOOTPRINT_ICON =
`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3.5" y="3.5" width="9" height="9" rx=".8" />
        <rect x="5.75" y="5.5" width="4.5" height="5" rx=".35" />
        <path
            d="M5 1.25V3.5M8 1.25V3.5M11 1.25V3.5M5 12.5v2.25M8 12.5v2.25M11 12.5v2.25M1.25 5H3.5M1.25 8H3.5M1.25 11H3.5M12.5 5h2.25M12.5 8h2.25M12.5 11h2.25" />
    </g>
</svg>`

export const SYMBOL_ICON =
`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 5.5h2.75M1 10.5h2.75M4.75 3.5H7a4.5 4.5 0 0 1 0 9H4.75a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z" />
        <circle cx="12.7" cy="8" r="1.2" />
        <path d="M13.9 8H15" />
    </g>
</svg>`

/** Class names used by the injected rows (defined by `injectSidebarEntryStyles`). */
const ENTRY_CSS: Record<string, string> = {
  entry: 'hqcg-sidebar-entry',
  entryIcon: 'hqcg-sidebar-entry__icon',
  entryLabel: 'hqcg-sidebar-entry__label',
}

/**
 * Sidebar entry styles — matched to the official `sidebar.panellist` rows
 * (ui-sidebar `.panelRow`): same 2px inset, 7px/8px padding, 8px gap, 12px
 * radius and 16px glyph, so 封装生成 / Symbol 生成 sit flush with the shell's
 * own Plugins entry instead of drifting right of it.
 */
const ENTRY_CSS_TEXT = `
.hqcg-sidebar-entry {
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
.hqcg-sidebar-entry:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.hqcg-sidebar-entry[data-active] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.hqcg-sidebar-entry__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.hqcg-sidebar-entry__icon svg {
  display: block;
  width: 16px;
  height: 16px;
}
.hqcg-sidebar-entry__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Collapsed rail: icon-only, centered — same 36px square the shell uses. */
[data-dsh-frame][data-sidebar-collapsed] .hqcg-sidebar-entry,
[data-sidebar-collapsed] .hqcg-sidebar-entry {
  justify-content: center;
  width: 36px;
  height: 36px;
  margin: 0;
  padding: 0;
}
[data-dsh-frame][data-sidebar-collapsed] .hqcg-sidebar-entry__icon svg,
[data-sidebar-collapsed] .hqcg-sidebar-entry__icon svg {
  width: 18px;
  height: 18px;
}
[data-dsh-frame][data-sidebar-collapsed] .hqcg-sidebar-entry__label,
[data-sidebar-collapsed] .hqcg-sidebar-entry__label {
  display: none;
}
`

const STYLE_TAG_ID = 'data-plugin-css="huaqiu-component-gen-sidebar"'

/** Inject the sidebar entry stylesheet once (idempotent). */
export function injectSidebarEntryStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[${STYLE_TAG_ID}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = 'huaqiu-component-gen-sidebar'
  tag.textContent = ENTRY_CSS_TEXT
  document.head.appendChild(tag)
}

/** Per-row mounting options (wired to the workspace state by the caller). */
export interface SidebarRowOptions {
  selector: string
  attribute: string
  icon: string
  /** Localized label; re-read on every locale refresh (see `subscribe`). */
  label: () => string
  /** Localized tooltip; re-read on every locale refresh (see `subscribe`). */
  tooltip: () => string
  position: 'before' | 'after'
  onToggle(): void
  isOpen(): boolean
}

/**
 * Mount the two component-gen sidebar rows (footprint + symbol). Rows are
 * ordered deterministically: footprint first, symbol second — whatever the
 * mount order, the family-positioning keeps the pair stable.
 *
 * @param rows - the two rows' wiring (footprint, then symbol).
 * @param subscribe - subscription source for active-state + label refresh.
 * @returns disposer removing both rows and their observers.
 */
export function mountComponentGenSidebarEntries(
  rows: [SidebarRowOptions, SidebarRowOptions],
  subscribe: (listener: () => void) => () => void,
): () => void {
  if (typeof document === 'undefined') return () => {}
  injectSidebarEntryStyles()

  const familySelectors = [FOOTPRINT_ENTRY_SELECTOR, SYMBOL_ENTRY_SELECTOR] as const
  const disposers = rows.map((row) =>
    mountSharedSidebarEntry({
      rowAttribute: row.attribute,
      rowSelector: row.selector,
      plugin: PLUGIN_ID,
      icon: row.icon,
      css: ENTRY_CSS,
      label: row.label,
      tooltip: row.tooltip,
      refresh: { subscribe },
      onToggle: row.onToggle,
      position: row.position,
      familySelectors,
      active: {
        subscribe,
        isOpen: row.isOpen,
      },
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* already disposed */ }
    }
  }
}

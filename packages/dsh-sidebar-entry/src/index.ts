/**
 * `@huaqiu/dsh-sidebar-entry` — one shared sidebar entry row for the Huaqiu
 * DSH plugin family.
 *
 * Adapted from dsh-web's `shared/client/sidebar-entry-core.ts` (used by
 * dsh-task-board / dsh-skill-explorer / dsh-ssh). It lives in its own package
 * so every Huaqiu plugin that needs a sidebar toolbutton shares ONE copy of
 * the injection policy instead of forking it.
 *
 * dsh's sidebar shell exposes no slot an external plugin can register into at
 * this position (between the New Session button and the workspace browser), so
 * the entry row is injected into the live DOM. The injection self-heals: a
 * MutationObserver watches the sidebar root and re-inserts the row whenever a
 * React re-render displaces it (re-insertion happens in the same frame, before
 * paint, so no flicker).
 *
 * The row is plain DOM (no React tree) so it can never disturb the shell's
 * reconciliation. What the row DOES on click is entirely the caller's: open a
 * `shell.overlay` workspace (component-gen) or act on the DSH composer
 * (schematic-gen).
 *
 * @module @huaqiu/dsh-sidebar-entry
 */

/** Per-package configuration for one sidebar entry row. */
export interface SidebarEntryOptions {
  /** Full attribute name identifying the injected row (idempotency key), e.g. 'data-hqcg-symbol-entry'. */
  rowAttribute: string
  /** CSS selector matching the injected row, e.g. '[data-hqcg-symbol-entry]'. */
  rowSelector: string
  /**
   * L2 semantic-attribute plugin id (issue #506). When set, the row also
   * outputs data-dsh-plugin="<id>" and data-dsh-part="sidebar-entry"; unset
   * leaves the row without semantic attributes.
   */
  plugin?: string
  /** Inline icon markup (matches the shell's 16px nav-icon look). */
  icon: string
  /** CSS module class names for the row and its two spans (entry / entryIcon / entryLabel). */
  css: Record<string, string>
  /** Localized row label (aria-label + visible text). */
  label(): string
  /** Optional localized tooltip (title attribute). */
  tooltip?(): string
  /**
   * Optional locale-change subscription: re-applies label / aria-label /
   * tooltip whenever the active locale changes.
   */
  refresh?: { subscribe(listener: () => void): () => void }
  /** Click action (open/toggle the owning panel). */
  onToggle(): void
  /** Family-block position: 'before' inserts ahead of sibling plugin rows, 'after' behind them. */
  position: 'before' | 'after'
  /**
   * Selectors of the sibling plugin entry rows this package orders against
   * (its own row included). Each package passes the same list so the rendered
   * order stays stable across re-renders.
   */
  familySelectors: readonly string[]
  /** Optional active-state bridge; highlights the row while the panel is open. */
  active?: {
    subscribe(listener: () => void): () => void
    isOpen(): boolean
  }
}

/** Find the sidebar shell root element, or undefined while not yet mounted. */
function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector<HTMLElement>('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  // Current shells wrap the sidebar UI: column > wrapper > root(logoRow owner).
  // Prefer the element that owns the logo row — the real sidebar UI root —
  // and fall back to the column's first child for legacy shells.
  const logoOwner = column.querySelector<HTMLElement>('[class*="logoRow"]')?.parentElement
  return logoOwner ?? (column.firstElementChild as HTMLElement | undefined)
}

/** The New Session button: nested in the logo row on current shells, a direct child on legacy shells. */
function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector<HTMLButtonElement>('button[class*="newSession"]')
  if (nested !== null) return nested
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** Build the entry row (a detached button; insert once the shell is up). */
function createEntry(options: SidebarEntryOptions): { entry: HTMLButtonElement; applyLabel: () => void } {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute(options.rowAttribute, '')
  if (options.plugin !== undefined) {
    entry.setAttribute('data-dsh-plugin', options.plugin)
    entry.setAttribute('data-dsh-part', 'sidebar-entry')
  }
  entry.className = options.css['entry'] ?? ''
  const labelSpan = document.createElement('span')
  labelSpan.className = options.css['entryLabel'] ?? ''
  const iconSpan = document.createElement('span')
  iconSpan.className = options.css['entryIcon'] ?? ''
  iconSpan.innerHTML = options.icon
  entry.append(iconSpan, labelSpan)
  const applyLabel = (): void => {
    entry.setAttribute('aria-label', options.label())
    if (options.tooltip !== undefined) entry.setAttribute('title', options.tooltip())
    labelSpan.textContent = options.label()
  }
  applyLabel()
  entry.addEventListener('click', options.onToggle)
  return { entry, applyLabel }
}

/** Re-insert the entry after the New Session row (before the browser region). */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement, options: SidebarEntryOptions): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    // Position relative to the family block (entries injected by sibling
    // plugins), never relative to transient logoRow geometry: every family
    // plugin that self-heals during a re-render then lands in the same
    // relative order, so the entries cannot swap positions regardless of
    // observer callback order or of shell wrapper changes. There is no
    // append-to-end fallback: appending at the end would randomly reorder
    // the block after a shell re-render.
    const row = button.closest('[class*="logoRow"]')
    const base = (row !== null && row.parentElement === root) ? row : button
    const family = Array.from(root.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.matches(options.familySelectors.join(', ')),
    )
    const anchor = options.position === 'before'
      ? (family.length > 0 ? family[0] : base.nextElementSibling)
      : (family.length > 0 ? family[family.length - 1]!.nextElementSibling : base.nextElementSibling)
    root.insertBefore(entry, anchor ?? null)
  }
  return true
}

/**
 * Mount the sidebar entry, waiting for the shell to render and self-healing
 * on later React re-renders.
 * @param options - the row's attribute/icon/copy/action/ordering configuration.
 * @returns disposer removing the entry and its observers.
 */
export function mountSidebarEntry(options: SidebarEntryOptions): () => void {
  // DOM-level idempotency: whatever path mounted an entry row before this
  // call (a duplicated apply, an HMR re-injection, a stale module still
  // alive), never mount a second one. The existing row keeps working; a full
  // page reload is the ultimate reset.
  if (typeof document !== 'undefined' && document.querySelector(options.rowSelector) !== null) {
    return () => {}
  }
  const { entry, applyLabel } = createEntry(options)
  let root: HTMLElement | undefined
  let placed = false
  let unsubscribeRefresh: (() => void) | undefined
  if (options.refresh !== undefined) {
    try {
      unsubscribeRefresh = options.refresh.subscribe(applyLabel)
    } catch {
      // A throwing subscription must not break the mount; the label stays at
      // its initial value and the next reload resolves it again.
    }
  }

  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      // The shell rebuilt the sidebar pane (whole-tree teardown); the root
      // observer is gone with the old tree, so detach it and re-query from
      // scratch. The new pane is later noticed by the body-level watcher.
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      // Cheap short-circuit: entry still lives in a mountable subtree.
      if (document.body.contains(entry)) return
      // Entry was torn down together with the old tree; reset and re-place.
      rootObserver.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry, options)
    if (placed) {
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }

  // Body-level watcher retained as the "whole rebuild" fallback: when the shell
  // tears down the whole sidebar pane, the root observer is gone with it and
  // only this body observation can notice the new pane mounting. It is no
  // longer disconnected after placement; the placed-and-still-mounted case
  // short-circuits through the cheap document.body.contains(entry) check, so
  // unrelated app mutations (e.g. chat streaming) cost one contains check
  // instead of churning the full re-query.
  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  // Self-heal: if a React re-render displaces the row, re-insert it in the
  // same frame (microtask before paint -> no visible flicker).
  const rootObserver = new MutationObserver(() => {
    if (root === undefined || !root.isConnected) {
      placed = false
      tryPlace()
      return
    }
    if (!root.contains(entry)) {
      placed = placeEntry(root, entry, options)
    }
  })

  // Reflect the panel's open state on the row (active highlight). Note: assigning
  // undefined to dataset.active materializes data-active="undefined" and keeps the
  // row permanently highlighted — delete the attribute instead.
  const unsubscribeActive = options.active === undefined ? undefined : (() => {
    const syncActive = (): void => {
      if (options.active!.isOpen()) entry.dataset.active = 'true'
      else delete entry.dataset.active
    }
    const unsubscribe = options.active.subscribe(syncActive)
    syncActive()
    return unsubscribe
  })()

  tryPlace()

  return () => {
    waitObserver.disconnect()
    rootObserver.disconnect()
    unsubscribeRefresh?.()
    unsubscribeActive?.()
    entry.remove()
  }
}

/**
 * Every row selector in the Huaqiu sidebar family, in intended visual order.
 *
 * Family ordering is only stable when every participating plugin passes the
 * SAME list to {@link mountSidebarEntry} — the core positions a row relative to
 * the family block, never relative to transient shell geometry. Adding a new
 * family row means adding its selector here (and to no plugin-local list).
 */
export const HUAQIU_SIDEBAR_ENTRY_FAMILY: readonly string[] = [
  '[data-hqcg-footprint-entry]',
  '[data-hqcg-symbol-entry]',
  '[data-hqcg-schematic-entry]',
]

// ---- host locale detection (shared by every family sidebar row) ----

/** Host UI languages this family localizes into. */
export type HostLocale = 'zh' | 'en'

/**
 * Read the host UI language from `<html lang>`.
 *
 * `dsh-client-locale` rewrites the attribute on every language change (dsh
 * web) and HQ Edge mirrors it, so this is the one source every family plugin
 * can read without importing a `locale` service.
 * @returns 'zh' / 'en', or undefined when the tag is absent or unsupported
 *   (callers fall back to their own default).
 */
export function detectHostLocale(): HostLocale | undefined {
  if (typeof document === 'undefined') return undefined
  const tag = document.documentElement?.getAttribute('lang')
  if (tag === null || tag === undefined || tag === '') return undefined
  const primary = tag.toLowerCase().split('-')[0]
  return primary === 'zh' || primary === 'en' ? primary : undefined
}

/**
 * Watch `<html lang>` and report every resolved change.
 *
 * Idempotent-safe: repeated calls share one observer and each caller gets its
 * own disposer; the observer disconnects when the last listener leaves.
 * @param listener - called with the newly resolved language.
 * @returns disposer removing this listener.
 */
/** Shared observer/listener set backing {@link observeHostLocale}. */
const localeListeners = new Set<(lang: HostLocale | undefined) => void>()
let localeObserver: MutationObserver | null = null

export function observeHostLocale(listener: (lang: HostLocale | undefined) => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined' || document.documentElement === null) {
    return () => {}
  }
  let current = detectHostLocale()
  const listeners = localeListeners
  listeners.add(listener)
  if (localeObserver === null) {
    localeObserver = new MutationObserver(() => {
      const next = detectHostLocale()
      if (next === current) return
      current = next
      for (const fn of [...listeners]) {
        try { fn(next) } catch { /* one bad subscriber must not strand the rest */ }
      }
    })
    localeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && localeObserver !== null) {
      localeObserver.disconnect()
      localeObserver = null
    }
  }
}

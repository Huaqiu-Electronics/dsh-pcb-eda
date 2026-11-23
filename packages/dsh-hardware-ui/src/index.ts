/**
 * Node half of `@huaqiu/dsh-hardware-ui`.
 *
 * All product UI is browser-side. This entry exists so the package is a normal
 * installable plugin in the DSH bundle; it intentionally provides no service
 * and injects nothing. Host operations live in `@huaqiu/hardware-artifacts`.
 */
export const name = '@huaqiu/dsh-hardware-ui'

/** Browser-only plugin: the node Loader seat intentionally does nothing. */
export function apply(): void {}

/** The tab kind owned by this product UI. */
export const HARDWARE_TAB_KIND = 'hardware-engineering'

/** Slots this product UI occupies. Exported for contract tests and readers. */
export const HARDWARE_UI_SLOTS = Object.freeze([
  'conversation.header.leading',
  'conversation.session.header.corner',
  'sidebar.right.pane.tab',
  'settings.section',
] as const)

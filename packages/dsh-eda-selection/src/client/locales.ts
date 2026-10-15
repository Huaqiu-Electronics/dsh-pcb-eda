/**
 * zh / en copy for the ambient `Current selection` dock entry.
 *
 * Chinese is the source of truth: `EdaSelectionKey` is derived from it and
 * `en` is typed against it, so a key added to one language without the other
 * is a COMPILE error rather than a silent Chinese fallback at runtime.
 *
 * Kept in its own module (rather than inlined in the component) so the copy is
 * reviewable on its own and the test file can assert bilingual balance
 * directly, mirroring `@huaqiu/dsh-auth` / `@huaqiu/dsh-tool-schematic-gen`.
 */

export const zh = {
  /** Dock-entry label shown wherever the owner projects one. */
  'dock.label': '当前选中',
  /** The chip itself: "Current selection · 3 items (PCB)". */
  'chip.label': '当前选中',
  'chip.sep': '·',
  /** Editor names, spelled for a human reader. */
  'editor.pcb': 'PCB',
  'editor.schematic': '原理图',
  'editor.unspecified': '编辑器',
  /** "{count} items" / "{count} 项". */
  'chip.items': '{count} 项',
  /** One item — English needs the singular form. */
  'chip.item': '1 项',
  /** Screen-reader label for the chip. */
  'chip.aria': '当前编辑器选中 {count} 项',
  /** Bounded label list, shown after the count when the host supplied any. */
  'chip.labels': '：{labels}',
} as const

export type EdaSelectionKey = keyof typeof zh

export const en: Record<EdaSelectionKey, string> = {
  'dock.label': 'Current selection',
  'chip.label': 'Current selection',
  'chip.sep': '·',
  'editor.pcb': 'PCB',
  'editor.schematic': 'Schematic',
  'editor.unspecified': 'editor',
  'chip.items': '{count} items',
  'chip.item': '1 item',
  'chip.aria': 'Current editor selection: {count} items',
  'chip.labels': ': {labels}',
}

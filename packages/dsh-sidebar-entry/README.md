# `@huaqiu/dsh-sidebar-entry`

One shared sidebar toolbutton row for the Huaqiu DSH plugin family.

DSH's sidebar shell exposes no slot a third-party plugin can register into at
the position between **New Session** and the workspace browser, so this package
injects a plain-DOM row there and keeps it there:

- **DOM-level idempotency** — a second `mountSidebarEntry` for the same row
  attribute is a no-op, so HMR / duplicated `apply()` never double-mount.
- **Self-healing** — a `MutationObserver` re-inserts the row in the same frame
  whenever a React re-render displaces it (no flicker), and re-queries from
  scratch when the shell tears the whole pane down.
- **Family ordering** — every participating plugin passes the same
  `familySelectors` list, so rows keep a stable relative order regardless of
  observer callback order.
- **Clean disposal** — observers, subscriptions and the row itself are removed.

## Usage

```ts
import { mountSidebarEntry, observeHostLocale, detectHostLocale } from '@huaqiu/dsh-sidebar-entry'

let lang = detectHostLocale()
const stopLocale = observeHostLocale((next) => { lang = next; /* announce */ })

const dispose = mountSidebarEntry({
  rowAttribute: 'data-hqcg-schematic-entry',
  rowSelector: '[data-hqcg-schematic-entry]',
  plugin: 'huaqiu-schematic-gen',
  icon: '<svg …/>',
  css: { entry: '…', entryIcon: '…', entryLabel: '…' },
  label: () => (lang === 'en' ? 'Schematic Gen' : '原理图生成'),
  tooltip: () => (lang === 'en' ? 'Insert a schematic-generation reference' : '插入原理图生成引用'),
  refresh: { subscribe: (fn) => { /* … */ return () => {} } },
  onToggle: () => { /* your action */ },
  position: 'after',
  familySelectors: ['[data-hqcg-footprint-entry]', '[data-hqcg-symbol-entry]'],
})
```

## Notes

- The row renders `data-dsh-plugin="<plugin>"` and `data-dsh-part="sidebar-entry"`
  when `plugin` is set (L2 semantic attributes).
- Do **not** swap this for a `sidebar.panellist` entry unless you also register
  a matching `main` central panel: `SidebarRoot`'s `PanelRow` calls
  `layout.selectPanel(id)`, which throws when no main panel uses that id.

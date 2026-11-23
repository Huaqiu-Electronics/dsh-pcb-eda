# @huaqiu/dsh-hardware-ui

Hardware Engineering product UI for the Huaqiu DSH Desktop profile.

## What it contributes

- Six persistent engineering destinations in `conversation.header.leading`:
  Schematic, PCB, DFM, BOM, 3D CAD and Order Placing.
- One `keepMounted` right-panel tab (`hardware-engineering`) that shows the
  selected artifact path, deterministic artifact selectors and explicit
  loading/error states. The tab is driven by one declared store handle shared
  with the other contributions.
- A contextual **Open in KiCad** / **Open in SolidCraft** action in
  `conversation.session.header.corner`.
- A Hardware Engineering settings section with KiCad and SolidCraft
  installation roots, persisted through DSH's host-backed config forms.

All host-side work (discovery, validated reads, installation probing, and
shell-free process creation) is delegated to `@huaqiu/hardware-artifacts`
through its same-origin `/api/v1/hardware/*` routes. The browser half never
touches Node APIs and never launches a process.

## Extension points used

| Seat | Purpose |
|---|---|
| `conversation.header.leading` | one product navigation occupant |
| `conversation.session.header.corner` | contextual native-application action |
| `sidebar.right.pane.tab` | artifact viewer body (`keepMounted`) |
| `settings.section` | CAD installation settings |

No DSH core change and no new runtime is required.

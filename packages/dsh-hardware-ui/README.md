# @huaqiu/dsh-hardware-ui

Hardware Engineering product UI for the Huaqiu DSH Desktop profile.

## What it contributes

- **Five** persistent engineering destinations in `conversation.header.leading`:
  Schematic, PCB, BOM, 3D CAD and Order Placing. DFM is out of scope for this
  POC and no mechanical-model destination exists; `mechanical[]` may still
  appear in a manifest for agent context, but it never drives the viewer.
- One `keepMounted` right-panel tab (`hardware-engineering`) that renders the
  selected artifact from its **saved** file: schematic and PCB through
  `@huaqiu/ecad-renderer`, 3D through the host-generated PCB GLB in Three.js,
  BOM from the host's KiCad BOM projection, plus deterministic selectors,
  explicit loading/error states and the canonical artifact identity.
- **Open in KiCad** lives in the viewer header and carries the exact resolved
  artifact (schematic → eeschema, PCB and 3D → pcbnew). There is no
  conversation-level native action: that seat could never resolve which artifact
  to open. SolidCraft has no native action in this POC.
- A Hardware Engineering settings section with KiCad and SolidCraft installation
  roots, persisted through DSH's host-backed config forms.
- Order Placing shows the selected board and its BOM context plus the exact
  existing agent tool calls (`quote_pcb`, `quote_smt`, `place_pcb_order`,
  `place_smt_order`). The UI never builds a quote URL or a second backend, and
  never places an order itself.

All host-side work (discovery, hierarchy resolution, authorized reads, GLB/BOM
generation, installation probing, shell-free process creation) is delegated to
`@huaqiu/hardware-artifacts` through its same-origin `/api/v1/hardware/*` routes.
The browser half never touches Node APIs and never launches a process.

## Rendering dependencies

`@huaqiu/kicad-sexpr-parser`, `@huaqiu/ecad-renderer` and `three` are
**devDependencies**: they are inlined into `lib/client.js` at build time
(`tsdown.config.ts → deps.alwaysBundle`) because the DSH client ModuleLoader can
only `require` its own injected modules. Keeping them out of `dependencies`
keeps them out of the Desktop runtime closure.

## Extension points used

| Seat | Purpose |
|---|---|
| `conversation.header.leading` | one product navigation occupant |
| `sidebar.right.pane.tab` | artifact viewer body (`keepMounted`) |
| `settings.section` | CAD installation settings |

No DSH core change and no new runtime is required.

## Runtime states

Every mount is keyed by the navigation revision and owns an `AbortController`:
a superseded navigation disposes the previous renderer or GLB view instead of
painting over it. A missing project, a missing root schematic, an ambiguous
board set, an unconfigured or version-probe-failed KiCad installation, a source
that changed since it was selected, and a failed `kicad-cli` export each surface
as an explicit state rather than a blank canvas.

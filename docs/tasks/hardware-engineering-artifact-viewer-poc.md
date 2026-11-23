# Hardware Engineering Artifact Viewer POC
## Backplane Reference Study and DSH Integration Specification

**Priority:** P0  
**Stage:** POC — artifact viewing and native-editor launch  
**Product:** Hardware Engineering  
**Runtime:** DeepSeek Harness (DSH) Desktop  
**Primary host:** Huaqiu KiCad  
**Mechanical application:** SolidCraft

---

## 1. Objective

Introduce hardware-design artifact viewing into the existing Hardware Engineering experience in DSH.

The POC must support:

| Artifact | In-workspace viewer | Native application |
|---|---|---|
| KiCad schematic (`.kicad_sch`) | 2D schematic viewer | KiCad Eeschema |
| KiCad PCB (`.kicad_pcb`) | Interactive 2D PCB viewer | KiCad PCB Editor |
| PCB 3D | Interactive 3D board viewer | KiCad, where appropriate |
| BOM | Read-only structured BOM table | KiCad, opening its source schematic |
| Mechanical 3D (`.step`, `.stp`, `.glb`) | Interactive 3D model viewer | SolidCraft |
| Order | Existing PCB and SMT order workflows | Existing Huaqiu order services |

The user must be able to select the local KiCad and SolidCraft installations in Settings.

Each applicable viewer must have an **Open in KiCad** or **Open in SolidCraft** action in its top-right toolbar.

The DSH agent must also know which installations are configured and which executable paths are available.

### Explicit non-goals

This POC does not implement:

- Synchronization of unsaved native-editor state with DSH.
- Simultaneous editing coordination.
- Embedded native KiCad or SolidCraft windows.
- Design history, checkpoints or rollback.
- A new EDA runtime manager.
- HQ Edge or another local daemon.
- Full SolidCraft document editing or conversion.
- A universal hardware-design IR.

Native project files remain authoritative. The viewers are read-only projections.

---

## 2. Backplane source study

Reference repository: https://github.com/BackplaneWorks/Backplane

Reference implementation commit: `e76a59bc2243befa5795a95a83ec1962b7574d34`.

### 2.1 Viewer architecture

Backplane's ordinary viewers are not embedded KiCad applications and are not simply web pages rendering the original file.

Its implementation uses:

- Rust in `native/host` to discover, parse, transform and serve design data.
- GPUI in `native/gpui` to render the viewer UI.
- A compact drawing representation shared between the hub and the clients.
- Native KiCad CLI exports and dedicated model conversion for 3D.
- Separate GUI KiCad and FreeCAD processes for native application editing.

The normal viewer and native editor are distinct experiences.

Relevant source:

- `native/host/src/kicad/board.rs`
- `native/host/src/kicad/schematic.rs`
- `native/host/src/kicad/plotgen.rs`
- `native/host/src/kicad/plot.rs`
- `native/host/src/kicad/bom.rs`
- `native/host/src/kicad/solidread.rs`
- `native/host/src/kicad/stepglb.rs`
- `native/gpui/src/screens/viewer.rs`

Reference: [Backplane viewer rail map](https://github.com/BackplaneWorks/Backplane/blob/e76a59bc2243befa5795a95a83ec1962b7574d34/docs/viewer-rail-map.md).

**Important adaptation:** DSH already has a React-based browser UI and a PCB renderer. We should not reproduce Backplane's Rust/GPUI rendering architecture.

We should borrow its separation of artifact discovery, rendering, viewer state and native application launch.

### 2.2 Schematic viewer

Backplane parses `.kicad_sch` directly.

Its Rust schematic parser converts KiCad S-expressions into drawing primitives, including:

- Symbols and symbol bodies.
- Pins and pin names/numbers.
- Wires, buses and bus entries.
- Junctions and no-connect markers.
- Local, global and hierarchical labels.
- Sheet symbols and sheet pins.
- Text, fields and graphical elements.
- Page dimensions and graphical attributes.

The resulting items use stable KiCad UUIDs as their identities.

The rendering pipeline converts those primitives into compact plot chunks. The client draws the chunks with the appropriate layer colors and geometry.

This is a purpose-built viewer, not an SVG screenshot of the entire schematic.

Reference:

- [schematic.rs](https://github.com/BackplaneWorks/Backplane/blob/e76a59bc2243befa5795a95a83ec1962b7574d34/native/host/src/kicad/schematic.rs)
- [plotgen.rs](https://github.com/BackplaneWorks/Backplane/blob/e76a59bc2243befa5795a95a83ec1962b7574d34/native/host/src/kicad/plotgen.rs)

**POC decision:** Do not port this renderer to TypeScript.

Use the existing KiCad CLI and schematic-generation rendering infrastructure to produce SVG or PNG previews. Provide zoom, pan and sheet selection in the browser. SVG is preferred when the generated output supports the required fidelity and file size.

A future interactive schematic viewer can be evaluated separately.

### 2.3 PCB viewer

Backplane also parses `.kicad_pcb` into its own board drawing model.

Its model covers:

- Board outline.
- Copper tracks and arcs.
- Footprints, pads and their positions.
- Zones and filled copper.
- Vias.
- Board text and drawing primitives.
- Layer identity and display properties.

The renderer uses layer-aware drawing chunks rather than embedding the native PCB editor.

The POC should reuse the existing Huaqiu PCB viewer instead of introducing another PCB parser or renderer.

Existing implementation:

`@huaqiu/dsh-tool-pcb-viewer`

Important files:

- `src/index.ts`
- `src/parse.ts`
- `src/adapter.ts`
- `src/client/index.ts`
- `src/client/panel.tsx`
- `src/viewer.ts` and related renderer modules.

The existing implementation already provides:

- A `pcb_preview` tool.
- A host-side file registry and HTTP route.
- A browser-side PCB parser and viewer.
- 2D and 3D viewing.
- A conversation turn-tail preview card.
- A larger interactive viewer.

The current implementation uses a browser-side React viewer with Three.js. It does not require KiCad IPC to display a saved PCB file.

Retain this implementation and its proven parser/renderer behavior. Improve its integration into the DSH workspace rather than replacing it.

Reference: [Huaqiu PCB viewer source](https://github.com/Huaqiu-Electronics/dsh-pcb-eda/tree/main/packages/dsh-tool-pcb-viewer).

### 2.4 3D viewer

Backplane has two distinct 3D paths.

**PCB 3D**

The board model comes from KiCad's GLB export:

`kicad-cli pcb export glb`

The hub caches the generated model by source revision and sends a compact triangle representation to the client.

The board's 3D model is therefore derived from the selected `.kicad_pcb`.

**Mechanical 3D**

Backplane accepts STEP, STP and GLB models.

STEP files are converted to GLB using either:

- Its native `backplane-step2glb` OpenCascade helper.
- FreeCAD as a fallback.

The generated GLB is cached and rendered by the same 3D drawing infrastructure.

References:

- [solidread.rs](https://github.com/BackplaneWorks/Backplane/blob/e76a59bc2243befa5795a95a83ec1962b7574d34/native/host/src/kicad/solidread.rs)
- [stepglb.rs](https://github.com/BackplaneWorks/Backplane/blob/e76a59bc2243befa5795a95a83ec1962b7574d34/native/host/src/kicad/stepglb.rs)
- [solid.rs](https://github.com/BackplaneWorks/Backplane/blob/e76a59bc2243befa5795a95a83ec1962b7574d34/native/host/src/kicad/solid.rs)

**POC decision:**

- PCB 3D uses the existing PCB viewer's Three.js implementation.
- Mechanical 3D supports STEP, STP and GLB.
- Use the available KiCad CLI for PCB GLB generation.
- Use an existing conversion capability if SolidCraft exposes a supported conversion CLI; otherwise keep STEP/GLB viewing independent of SolidCraft.
- Do not build a new geometry conversion engine for this POC.

SolidCraft is not Backplane's FreeCAD. Its executable discovery and document-opening behavior must be verified against the actual local SolidCraft installation. Do not assume FreeCAD command-line arguments or file-format support apply to SolidCraft.

### 2.5 BOM implementation and relationship to schematic

Backplane's BOM is derived from the schematic, not maintained as a second independently editable design artifact.

Its BOM parser:

1. Reads the root schematic.
2. Traverses hierarchical sheet references.
3. Reads symbol properties and project instance references.
4. Extracts reference, value, footprint and custom fields.
5. Applies DNP and BOM-exclusion flags.
6. Groups equivalent components into BOM lines.
7. Retains manufacturer and part-number information.

The grouping identity includes component properties and custom fields. Two components with different MPNs must not be merged just because their values and footprints match.

Relevant implementation:

- `native/host/src/kicad/bom.rs`
- `native/host/src/kicad/bompanel.rs`

The current Backplane BOM panel has an additional live-data path:

- If its GUI KiCad has the schematic open, it reads live schematic symbols through IPC approximately once per second.
- Otherwise, it reads the saved root and hierarchical schematic files and polls for changes on disk approximately twice per second.

That is an advanced feature beyond this POC.

**POC decision:** Use saved schematic artifacts as the BOM source. Recompute when the source file changes or the user presses Refresh.

Do not attempt to synchronize unsaved editor state.

The BOM viewer must show at least:

- Reference designators.
- Quantity.
- Value.
- Footprint.
- Manufacturer.
- MPN.
- Custom fields.
- DNP.
- Exclude from BOM.

Reuse the existing `analyze_kicad_module` BOM analysis where its output is sufficient. It already supports `view: "bom"` and groups components using their source fields and assembly flags.

Reference:

- [Existing schematic analysis tool](https://github.com/Huaqiu-Electronics/dsh-pcb-eda/blob/main/packages/dsh-tool-kicad-schematic-gen/src/schematic/analysis-tool.ts)
- [Existing module analysis](https://github.com/Huaqiu-Electronics/dsh-pcb-eda/blob/main/packages/dsh-tool-kicad-schematic-gen/src/schematic/module-analysis.ts)

Do not introduce a second BOM parser without first proving the existing analysis cannot supply the required data.

### 2.6 Artifact selection and multiple projects

Backplane does not blindly select the first file matching an extension.

Its project resolver uses `.backplane.json` to define explicit paths:

```json
{
  "project": "main.kicad_pro",
  "pcb": "main.kicad_pcb",
  "schematic": "main.kicad_sch"
}
```

Without explicit configuration, it discovers `.kicad_pro` files and resolves their associated board and schematic.

For multiple boards, it provides a board picker. The project board list is not simply every `.kicad_pcb` in the repository:

- It distinguishes project-owned boards from arbitrary fixtures and exports.
- It excludes common archive, backup, build and copy folders from the project-owned set.
- It presents the default board first.
- It supports multiple boards and multiple associated viewer selections.

Hierarchical schematic sheets are treated as sheets belonging to a root schematic, rather than automatically being independent projects.

References:

- [project.rs](https://github.com/BackplaneWorks/Backplane/blob/e76a59bc2243befa5795a95a83ec1962b7574d34/native/host/src/kicad/project.rs)
- [boards.rs](https://github.com/BackplaneWorks/Backplane/blob/e76a59bc2243befa5795a95a83ec1962b7574d34/native/host/src/kicad/boards.rs)
- [Backplane project prompt contract](https://github.com/BackplaneWorks/Backplane/blob/e76a59bc2243befa5795a95a83ec1962b7574d34/native/host/src/agents/prompt_text.rs)

**POC decision:** Artifact selection must be explicit and deterministic.

Never select an arbitrary first `.kicad_sch` or `.kicad_pcb` from a working directory.

The POC should support:

- One selected canonical `.kicad_pro` per project.
- Its default schematic and PCB.
- Multiple PCB files through an explicit board selector.
- Hierarchical schematic sheets through a sheet selector.
- Explicit selection when multiple independent projects exist.

If the project contains multiple independent schematics or ambiguous board/schematic relationships, require selection instead of guessing.

An optional project manifest can follow Backplane's approach, but it must not silently overwrite or conflict with existing project configuration.

Suggested manifest for the POC:

`.hardware-engineering.json`

```json
{
  "project": "main.kicad_pro",
  "schematic": "main.kicad_sch",
  "boards": [
    {
      "id": "main",
      "path": "main.kicad_pcb"
    },
    {
      "id": "power",
      "path": "power.kicad_pcb"
    }
  ],
  "mechanical": [
    {
      "id": "assembly",
      "path": "mech/assembly.step"
    }
  ]
}
```

This is optional. If absent, discovery should work for unambiguous projects. Do not create this file automatically just because a project is opened.

### 2.7 Open in KiCad

Backplane's Open in KiCad action is viewer-aware.

The action receives the viewer's current artifact identity and opens the corresponding native document.

Its implementation is in:

`native/host/src/kicad/open.rs`

The launcher distinguishes:

- Project manager for `.kicad_pro`.
- PCB Editor for `.kicad_pcb`.
- Schematic Editor for `.kicad_sch`.

It resolves the editor executable beside the selected `kicad-cli`, launches with an explicit file path and detaches the process.

For the current POC, use separate native windows. Do not embed them.

The key behavior to preserve is:

**Open the exact artifact currently displayed, not an independently rediscovered default artifact.**

For example, when the user selected `power.kicad_pcb`, Open in KiCad must open `power.kicad_pcb`, not the project's default board.

### 2.8 KiCad IPC and kipy

Backplane does not use the Python `kipy` SDK as its primary IPC implementation.

Its hub implements NNG and protobuf IPC directly in Rust.

Its managed KiCad fork adds the required API capabilities. The headless server is launched through the managed runtime's `kicad-cli api-server`, with a project-specific socket and lifecycle parameters.

When its GUI editor is running, Backplane routes IPC to the GUI process and retires the headless server for that project, avoiding two independent processes holding the same design.

References:

- [KiCad IPC documentation](https://github.com/BackplaneWorks/Backplane/blob/e76a59bc2243befa5795a95a83ec1962b7574d34/docs/kicad-ipc.md)
- [Embedded editor architecture](https://github.com/BackplaneWorks/Backplane/blob/e76a59bc2243befa5795a95a83ec1962b7574d34/docs/embedded-editors.md)

**POC decision:** No IPC server is required.

The POC only needs to:

- Read saved native files.
- Invoke KiCad CLI exports where necessary.
- Launch the GUI editor with the selected file.

Do not bundle `kipy` for the viewer POC. Do not add a Python environment merely to open KiCad or render a saved artifact.

If live IPC is added in a later milestone, evaluate the existing Huaqiu KiCad fork's IPC implementation first. Do not assume the Python SDK must be bundled.

### 2.9 Application installation settings

Backplane provides a CAD settings page.

Its KiCad path accepts a runtime root or `kicad-cli` path. Its FreeCAD path accepts the console executable.

The selected executable is used consistently for CLI operations and exposed to agents.

The agent receives:

- The selected KiCad runtime/version.
- The absolute `kicad-cli` path.
- A corresponding executable environment/shim.
- The selected FreeCAD command path.

Relevant implementation:

- `native/host/src/present/settings.rs`
- `native/host/src/kicad/stepglb.rs`
- `native/host/src/agents/kicadsel.rs`

Reference: [Backplane CAD settings implementation](https://github.com/BackplaneWorks/Backplane/blob/e76a59bc2243befa5795a95a83ec1962b7574d34/native/host/src/present/settings.rs).

For Hardware Engineering, replace FreeCAD with SolidCraft. Do not copy FreeCAD-specific discovery assumptions.

---

## 3. DSH source architecture and integration boundaries

Reference repository: https://github.com/Huaqiu-Electronics/deepseek-harness

The DSH architecture documentation explicitly defines an all-plugin Cordis architecture. New functionality should be mounted as plugins rather than implemented by modifying the agent loop or creating a parallel application shell.

### 3.1 Existing client architecture

Relevant DSH packages:

| Package | Responsibility |
|---|---|
| `dsh-client-ui-sidebar-right` | Right-sidebar tabs and docking surface |
| `dsh-client-ui-sidebar-documentpreview` | File preview and renderer registry |
| `dsh-client-ui-slots` | Typed UI extension slots |
| `dsh-client-ui-settings` | Host-backed settings forms |
| `dsh-client-ui-settings-general` | Settings shell |
| `dsh-client-ui-open-in-app` | Native application opening UI |
| `dsh-host-open-in-app` | Host-side application discovery and launch |
| `dsh-client-modules` | Browser-side plugin module loading |

References:

- [DSH architecture](https://github.com/Huaqiu-Electronics/deepseek-harness/blob/master/docs/architecture.md)
- [Right Sidebar](https://github.com/Huaqiu-Electronics/deepseek-harness/blob/master/packages/client/ui-sidebar-right/README.md)
- [Document Preview](https://github.com/Huaqiu-Electronics/deepseek-harness/blob/master/packages/client/ui-sidebar-documentpreview/README.md)
- [Settings](https://github.com/Huaqiu-Electronics/deepseek-harness/blob/master/packages/client/ui-settings/README.md)

### 3.2 Preferred viewer integration

Use the existing `ctx.documentPreviews` renderer registry for artifact-specific file previews.

Register renderers for:

- `.kicad_sch`
- `.kicad_pcb`
- `.step`
- `.stp`
- `.glb`
- BOM output formats where appropriate.

Each renderer receives the selected file resource and owns its rendering behavior.

For a viewer requiring a dedicated workspace surface or richer navigation, use `ctx.sidebarRightTabs.register(...)` and `ctx.sidebarRight.openTab(...)`.

The preferred user experience is to open an artifact into the existing right-sidebar surface rather than introduce a new floating window system.

Use the existing DSH document-preview action slots:

- `sidebar.right.tab.document.actions`
- `sidebar.right.tab.document.unpreviewable`

These are the intended extension points for local application actions.

### 3.3 Existing PCB viewer integration

The existing `@huaqiu/dsh-tool-pcb-viewer` already has:

- A DSH Host plugin.
- A `pcb_preview` tool.
- A browser-side client bundle.
- A read-only file route.
- A PCB renderer and Three.js.
- A turn-tail preview card and a larger viewer.

Do not create another independent PCB viewer or duplicate its parser.

The local implementation audit must determine whether to:

1. Extend the existing viewer directly with schematic, BOM and mechanical artifact renderers; or
2. Keep the PCB renderer intact and introduce a small sibling artifact-viewer package that registers the other renderers.

Choose the smallest change that reuses the existing implementation.

Do not copy the old viewer's module-level singleton and custom panel pattern into new UI code without checking the current DSH client slot and store contracts. The current DSH client architecture requires typed slot registration and declared stores for state that survives remounts.

### 3.4 Native application launch integration

DSH already has `dsh-host-open-in-app` and `dsh-client-ui-open-in-app`.

However, the existing application catalog is a fixed whitelist of editors, terminals and file managers. It is not automatically a configurable KiCad/SolidCraft integration.

For the POC, use a dedicated Hardware Engineering host capability for the two configured CAD applications.

The client contributes the appropriate action to the viewer toolbar. The Host owns executable validation and process creation.

Do not launch local applications from browser-side React code.

### 3.5 Settings integration

Use the existing `ctx.configForms` and `settings.section` extension points.

Do not create a separate settings store or write application paths directly into plugin-local files.

The settings shell remains owned by DSH.

Reference:

- [DSH Settings package](https://github.com/Huaqiu-Electronics/deepseek-harness/tree/master/packages/client/ui-settings)
- [DSH Settings general shell](https://github.com/Huaqiu-Electronics/deepseek-harness/tree/master/packages/client/ui-settings-general)

### 3.6 Host and process boundaries

Use existing DSH Host capabilities:

- `ctx.subprocess` for executable discovery and launching.
- `ctx.fs` or the existing authorized workspace file access for artifact reading.
- `ctx.webServer` for serving large preview payloads when necessary.
- Host-backed settings for installation configuration.

No new background process manager is required.

The DSH Desktop shell already owns application lifecycle. Do not add a second daemon or modify Electron lifecycle merely to launch KiCad or SolidCraft.

---

## 4. Proposed Hardware Engineering integration

### 4.1 Host capability

Provide one Cordis service for Hardware Engineering artifact and application operations.

Suggested service name:

`hardwareArtifacts`

Responsibilities:

1. Resolve the current Session's workspace directory.
2. Discover projects and design artifacts.
3. Resolve the selected project and artifact.
4. Generate/read viewer data.
5. Generate BOM data.
6. Resolve configured KiCad and SolidCraft executables.
7. Launch the selected artifact in the requested native application.
8. Publish compact installation information for agent context.

Keep the service host-side.

The browser client must not have direct access to Node filesystem or process APIs.

### 4.2 Artifact model

Use a small file-oriented model, not a new universal design IR.

```ts
type ArtifactKind =
  | 'schematic'
  | 'pcb'
  | 'pcb-3d'
  | 'bom'
  | 'mechanical-3d'

interface HardwareArtifact {
  id: string
  kind: ArtifactKind
  path: string
  projectPath?: string
  sourcePath?: string
  title: string
  format: string
}
```

Identity must be based on the canonical absolute path and artifact kind, not basename.

A BOM artifact must retain its source schematic path.

A PCB 3D artifact must retain its source PCB path.

A hierarchical sheet must retain its root schematic identity.

### 4.3 Project and artifact discovery

Resolve the Session working directory from DSH's Session metadata. Do not use the DSH process's global `process.cwd()` as the project root.

Discovery order:

1. Explicit user-selected project.
2. Optional `.hardware-engineering.json` project configuration.
3. Unambiguous `.kicad_pro` discovery.
4. Explicit user selection if multiple projects remain.

For a selected project:

- Resolve its default schematic and PCB.
- Discover additional board files.
- Build the schematic hierarchy from the root sheet.
- Discover mechanical models.
- Exclude obvious build, archive, export, backup and temporary folders from default project selection.
- Do not discard a file explicitly selected by the user merely because it is outside the normal discovery folders.

When there are multiple independent schematics or boards, show a selector. Never silently choose the first match.

### 4.4 Viewer navigation

The initial navigation should provide:

- Schematic
- PCB
- BOM
- 3D
- Order

The selected project and board should be consistent across Schematic, PCB, BOM and 3D.

For the POC:

- Schematic selection controls the BOM source.
- PCB selection controls the PCB and PCB 3D source.
- Mechanical model selection controls the SolidCraft action.
- Order reuses existing PCB and SMT order tools.

The viewer must display the actual source filename and path. This helps users distinguish multiple artifacts with similar names.

### 4.5 Viewer toolbars

Use consistent top-right actions.

| Viewer | Primary action |
|---|---|
| Schematic | Open in KiCad |
| PCB | Open in KiCad |
| PCB 3D | Open in KiCad |
| BOM | Open source schematic in KiCad |
| Mechanical 3D | Open in SolidCraft |

For the PCB 3D viewer, the source is the PCB, so Open in KiCad opens the corresponding board editor.

The BOM is derived from the schematic; it must open that exact source schematic.

The mechanical viewer must open the exact selected STEP/STP/GLB file.

Show a disabled state and an explanatory message when the relevant application is not configured or cannot be resolved.

### 4.6 Native application launch contract

The Host receives an explicit request:

```ts
interface OpenArtifactRequest {
  application: 'kicad' | 'solidcraft'
  artifactPath: string
  projectPath?: string
  kind: ArtifactKind
}
```

The Host validates:

- The artifact exists.
- The artifact is inside an authorized workspace or is an explicitly selected external file.
- The configured executable exists and is runnable.
- The artifact type is supported by the requested application.

Launch without a shell.

Use explicit arguments and set the working directory to the artifact's parent directory.

Do not rely on the operating system's default file association when the user has selected a specific application installation.

For KiCad:

- `.kicad_sch` → Eeschema.
- `.kicad_pcb` → PCB Editor.
- `.kicad_pro` → KiCad project manager.

Resolve these executables from the configured KiCad installation.

For SolidCraft, use the verified application invocation discovered from its installation. Do not invent CLI arguments.

A successful result means the operating system accepted the launch request, not that the application finished loading the document.

### 4.7 Settings

Add a Hardware Engineering section in the existing DSH Settings UI.

**KiCad**

- Installation root or `kicad-cli` executable path.
- Resolved CLI path.
- Resolved GUI/editor paths.
- Detected version.
- Validate / Refresh action.

**SolidCraft**

- Installation root or executable path.
- Resolved GUI executable.
- Detected version, if available.
- Validate / Refresh action.

Persist the settings through DSH's Host-backed configuration system.

Suggested setting namespace:

```text
hardware.kicad.installation
hardware.solidcraft.installation
```

The KiCad configuration should resolve both CLI and GUI executables. A single arbitrary path must not be assumed to be every KiCad executable.

For the POC, a path input with a validation action is sufficient. Reuse an existing native path-picker capability if available; do not modify the Electron shell merely to add a custom picker.

Installation discovery may provide defaults, but an explicit user selection takes precedence.

A missing or invalid configured path must not silently launch a different installation.

---

## 5. Expose installations to the DSH agent

Follow Backplane's useful behavior: the selected local CAD runtime is part of the agent's execution environment, not merely a UI preference.

Backplane exposes the selected KiCad version and CLI path in prompt context and supplies matching executable paths to agent processes.

For Hardware Engineering, provide a compact dynamic context section:

```text
<hardware_environment>
KiCad:
  configured: true
  version: 10.0.x
  cli: <absolute path>
  pcb_editor: <absolute path>
  schematic_editor: <absolute path>

SolidCraft:
  configured: true
  executable: <absolute path>

Current project:
  root: <absolute path>
  project: <absolute path>
  schematic: <absolute path>
  selected_pcb: <absolute path>
</hardware_environment>
```

Only include paths that have passed Host-side validation.

The context should also identify unavailable capabilities instead of pretending they exist.

Provide the selected paths to agent subprocesses through a scoped child-process environment, for example:

```text
HUAQIU_KICAD_CLI
HUAQIU_KICAD_PCBNEW
HUAQIU_KICAD_EESCHEMA
HUAQIU_SOLIDCRAFT
```

Do not mutate the global DSH process environment.

Do not inject large project inventories into every prompt. Keep the always-on context compact; expose detailed artifact discovery through the Host capability and existing tools.

---

## 6. Order integration

Existing Huaqiu order tools are already part of the Hardware Engineering plugin composition:

- `quote_pcb`
- `quote_smt`
- `place_pcb_order`
- `place_smt_order`

Reuse them.

The Order surface should provide entry points for:

- PCB fabrication.
- SMT assembly.
- Quote review.
- Existing order placement flow.

Do not duplicate order APIs, pricing logic or authentication.

The POC should preserve existing tool behavior and provide an obvious entry point from the selected PCB/BOM context.

PCB order operations must use the selected board. SMT operations must use the BOM associated with the selected project/schematic and the existing order workflow's validated inputs.

No new order backend is part of this task.

---

## 7. Implementation boundaries

The implementation must remain within the existing DSH product composition.

### Host side

Own:

- Artifact discovery and identity.
- File validation and authorized reads.
- KiCad CLI resolution and export.
- BOM retrieval.
- CAD installation resolution.
- Native process launch.
- Preview payload delivery.

### Client side

Own:

- Viewer navigation.
- Artifact selectors.
- Schematic, PCB, BOM and 3D rendering.
- Toolbar actions.
- Settings presentation.
- Loading, unavailable and error states.

### Existing packages to reuse

- `@huaqiu/dsh-tool-pcb-viewer`
- `@huaqiu/dsh-tool-kicad-schematic-gen`
- `@huaqiu/dsh-tool-quote`
- Existing PCB/SMT order tools.
- DSH document-preview and right-sidebar packages.
- DSH Host filesystem, subprocess and settings capabilities.

Do not:

- Add HQ Edge as a dependency.
- Restore the HQ Edge-dependent `dsh-eda-host` plugin wholesale.
- Build another viewer framework.
- Introduce another project-state database.
- Create a standalone Electron companion application.
- Modify the DSH agent loop.
- Bundle KiCad or SolidCraft inside the plugin package.
- Bundle `kipy` solely for this POC.

The Hardware Engineering product bundle remains the distribution entry point.

---

## 8. Implementation phases

### P0 — Local installation and artifact discovery

- Add KiCad and SolidCraft settings.
- Validate configured executable paths.
- Expose the resolved installations to the agent.
- Discover projects, boards, schematics and mechanical models.
- Implement explicit project and artifact selection.

### P1 — Viewer integration

- Reuse the existing PCB viewer.
- Add schematic preview.
- Add BOM table.
- Add PCB 3D and mechanical 3D viewer entry points.
- Integrate with DSH right-sidebar/document-preview architecture.
- Add refresh and useful error states.

### P2 — Native application launch

- Add Open in KiCad to schematic, PCB, PCB 3D and BOM.
- Add Open in SolidCraft to mechanical 3D.
- Verify exact artifact selection.
- Validate paths and launch without a shell.

### P3 — Order entry points

- Connect PCB and SMT order actions to existing tools.
- Preserve existing quote and placement behavior.
- Verify the selected PCB and BOM are used.

---

## 9. Acceptance criteria

### Project and artifact discovery

- [ ] One-project workspace resolves without manual configuration.
- [ ] Multiple projects require explicit selection.
- [ ] Multiple PCB files are selectable.
- [ ] Hierarchical schematic sheets are discoverable.
- [ ] Multiple independent schematic files do not get silently conflated.
- [ ] Artifact identity uses the full path, not basename.
- [ ] BOM and PCB 3D retain their source artifact identities.

### Viewer behavior

- [ ] Schematic opens inside the DSH workspace.
- [ ] PCB opens inside the DSH workspace.
- [ ] BOM is derived from the selected schematic.
- [ ] BOM correctly handles hierarchical sheets and DNP/exclusion flags.
- [ ] PCB 3D opens for the selected board.
- [ ] STEP/STP/GLB mechanical models open in the 3D viewer.
- [ ] Loading, unsupported and failed states are explicit.
- [ ] Switching artifacts does not show stale content from a previous selection.

### Native application launch

- [ ] KiCad path can be configured and validated.
- [ ] SolidCraft path can be configured and validated.
- [ ] Open in KiCad opens the exact selected schematic or PCB.
- [ ] BOM opens its source schematic.
- [ ] Mechanical 3D opens the exact selected model in SolidCraft.
- [ ] Invalid installations produce clear errors.
- [ ] No shell-based command construction is used.

### Agent context

- [ ] The agent receives validated KiCad and SolidCraft paths.
- [ ] The agent receives detected versions when available.
- [ ] Child processes receive the configured paths through scoped environment variables.
- [ ] No global process environment mutation occurs.

### Integration and regression

- [ ] Product bundle activation succeeds offline.
- [ ] No HQ Edge process or endpoint is required.
- [ ] Existing PCB viewer behavior remains functional.
- [ ] Existing schematic generation and analysis remain functional.
- [ ] Existing PCB and SMT quote/order tools remain functional.
- [ ] No new Python dependency is required for viewer or launch functionality.
- [ ] All new UI uses the supported DSH extension contracts.

---

## 10. Required local-source audit before implementation

The public repository source study is a reference, not proof of the exact local checkout state.

Before coding, inspect the current local repositories and report:

1. Current DSH commit and working tree state.
2. Current DSH right-sidebar and document-preview APIs.
3. Existing PCB viewer client bundle, route and renderer.
4. Existing schematic preview and BOM analysis capabilities.
5. Existing settings/configForms integration.
6. Existing Host subprocess and workspace file-access APIs.
7. Existing Desktop native path-picker and file-launch capabilities.
8. Actual local KiCad installation layout and launch arguments on Windows.
9. Actual local SolidCraft installation layout, version and file-opening arguments.
10. Existing Hardware Engineering bundle activation and dependency closure.

For every proposed change, identify the owning package and the exact extension point.

Do not create a new abstraction if an existing DSH service already provides the required behavior.

The final report must include a package-level change plan, a short implementation sequence, identified blockers, and the POC test matrix.

---

## 11. POC demonstration

The final demonstration should use a real multi-artifact hardware project:

1. Open a DSH Session in the project directory.
2. Select the canonical KiCad project.
3. Open its schematic in the DSH viewer.
4. Switch to another hierarchical sheet.
5. Click Open in KiCad and verify that Eeschema opens the selected project/schematic.
6. Return to DSH and open the PCB viewer.
7. Select a different PCB when multiple boards exist.
8. Click Open in KiCad and verify the exact board opens.
9. Open PCB 3D.
10. Open the BOM and verify it corresponds to the selected schematic.
11. Open a mechanical STEP file in the 3D viewer.
12. Click Open in SolidCraft and verify the correct model opens.
13. Ask the agent which KiCad and SolidCraft installations it is configured to use; verify that the answer matches Settings.
14. Run the existing PCB and SMT order entry points.

The POC passes when the user can inspect the design inside the DSH workspace and open the exact selected artifact in its native application without manually navigating through the filesystem.

**The success criterion is a convincing artifact-viewing and native-application handoff experience, not editor synchronization.**
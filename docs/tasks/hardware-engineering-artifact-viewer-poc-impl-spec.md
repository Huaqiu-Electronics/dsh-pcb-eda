# Hardware Engineering Artifact Viewer POC — Implementation Specification

**Date:** 2026-11-23  
**Status:** Approved for implementation  
**Priority:** P0  
**Target:** Windows x64 Huaqiu DSH Desktop distribution  
**Implementation mode:** Direct modification of the existing Huaqiu DSH plugin monorepo and DSH fork where required  
**DSH shell modification:** Not required  
**Product bundle:** `@huaqiu/hardware-engineering`

---

## 1. Objective

Implement the first usable Hardware Engineering product experience inside DSH.

The product must make the core engineering workflow immediately discoverable, provide in-workspace previews of the selected engineering artifacts, and expose existing Huaqiu order capabilities without introducing another quote/order implementation.

The POC must deliver five persistent destinations:

1. Schematic
2. PCB
3. BOM
4. 3D CAD
5. Order Placing

The product should feel like a coherent hardware engineering workspace rather than a collection of independent DSH plugins.

The primary interaction model is:

- The top navigation communicates the available engineering destinations.
- The center conversation remains the AI engineering interaction surface.
- The right panel displays the artifact associated with the selected destination.
- The left sidebar retains existing DSH session, workspace, tool and settings functionality.
- Agent-generated results can navigate to the corresponding destination and select the relevant artifact without requiring another agent turn.

The POC is an artifact-viewing and workflow-entry-point implementation. It is not an attempt to embed or synchronize native ECAD applications.

## 2. Repository and package ownership

Use the following local source trees as the implementation baseline:

| Repository | Responsibility |
|---|---|
| `/Users/admin/code/dsh-pcb-eda` | Huaqiu DSH plugin monorepo and product implementation |
| `/Users/admin/code/ecad-viewer` | Existing parser and 2D renderer dependencies |
| `/Users/admin/code/kicad` | KiCad CLI behavior and quote/order reference |
| `/Users/admin/code/deepseek-harness` | DSH shell contracts and extension-point reference |

The gate-owned DSH shell baseline is `8097be700f`. Do not use the older `deepseek-harness-desktop` snapshot as the basis for implementation decisions.

Relevant existing packages:

- `@huaqiu/hardware-engineering`
- `@huaqiu/hardware-artifacts`
- `@huaqiu/dsh-hardware-ui`
- `@huaqiu/dsh-tool-kicad-schematic-gen`
- `@huaqiu/dsh-tool-pcb-viewer`
- `@huaqiu/dsh-tool-quote`
- `@huaqiu/dsh-kicad`
- `@huaqiu/dsh-artifacts`
- `@huaqiu/kicad-sexpr-parser`
- `@huaqiu/ecad-renderer`

Before changing code, inspect the current working tree and preserve unrelated uncommitted POC work. The reported baseline for `dsh-pcb-eda` is `8566f75` with uncommitted POC changes; do not reset or overwrite them.

## 3. Non-negotiable architecture decisions

### 3.1 DSH integration

Implement the product using the existing DSH extension surface.

Use:

- `conversation.header.leading` for persistent product navigation.
- `sidebarRightTabs.register({ keepMounted: true })` for the Hardware Engineering artifact viewer.
- `sidebar.right.pane.tab` for the registered viewer body.
- `sidebar.right.openTab(...)` for navigation and artifact selection.
- `settings.section` and `ctx.configForms` for product settings.
- `conversation.session.header.actions` or a viewer-owned action for contextual native application actions.

Do not modify the DSH shell, Electron lifecycle, agent loop, conversation architecture, or settings shell for this POC.

The navigation is conversation-header-scoped, not full-window. Accept this layout for the POC. Do not introduce a new `shell.header` slot or modify `AppFrame` merely to make the navigation span the full window.

### 3.2 One product-owned UI integration

`@huaqiu/dsh-hardware-ui` owns the product experience.

It must own:

- The five-destination navigation.
- The selected destination.
- The selected project and artifact.
- Artifact identity and revision handling.
- Right-panel viewer content.
- Viewer lifecycle.
- Contextual native-open actions.
- Order entry-point presentation.
- Hardware Engineering settings UI.

Do not implement five independent plugin tabs or separate product navigation registrations.

The existing `@huaqiu/dsh-tool-pcb-viewer` remains intact. Do not rehost its panel, duplicate its renderer, or change its standalone route and turn-tail card behavior.

### 3.3 Native files remain authoritative

Native KiCad project files are the source of truth.

For this POC:

- Read saved native files.
- Parse and render them in the DSH client.
- Generate derived PCB GLB output from the selected `.kicad_pcb`.
- Do not create a shadow project database or universal Project IR.
- Do not introduce a second mutable representation of the project.
- Do not claim that a preview represents unsaved native-editor state.
- Do not add live IPC or live application-state synchronization.

Derived rendering data and cache entries are disposable. They must be reproducible from their source artifacts.

### 3.4 No new runtime infrastructure

Do not introduce:

- HQ Edge as a runtime dependency.
- A new daemon, supervisor or runtime updater.
- A Python runtime or `kipy` dependency.
- A separate project database.
- A new native application embedding framework.
- A second artifact viewer framework.
- A new quote or order backend.
- A new DSH shell lifecycle mechanism.

The DSH Desktop host and existing plugin services remain responsible for runtime and lifecycle management.

---

## 4. Approved product UX

### 4.1 Overall layout

Preserve the DSH three-panel workspace.

**Top navigation**

Use one product-owned component registered in `conversation.header.leading`.

Display:

- Huaqiu product identity.
- Hardware Engineering product identity/subtitle where appropriate.
- Five persistent destinations: Schematic, PCB, BOM, 3D CAD, Order Placing.
- A contextual native-open action in the viewer, not an action that shadows existing DSH chrome.

The five destinations must remain visible even when no project or corresponding artifact is available.

Do not hide destinations based on project contents.

**Left sidebar**

Preserve the existing DSH sidebar:

- New Session.
- Existing tools and plugin entry points.
- Workspaces and project context.
- Existing user profile and settings.

Do not recreate DSH sidebar functionality.

**Center**

Preserve the existing DSH conversation and agent interaction.

Agent-generated engineering results should be able to navigate to a product destination and select an artifact through the product-owned navigation/store integration.

Navigation must not create an unnecessary new agent turn.

**Right panel**

Render the selected artifact using the product-owned viewer tab.

The viewer must provide:

- Selected artifact identity.
- Relevant filename or sheet name.
- Appropriate preview.
- Loading, empty, unsupported and error states.
- Contextual native-open action when applicable.

### 4.2 Destination behavior

| Destination | Source | POC behavior |
|---|---|---|
| Schematic | `.kicad_sch` hierarchy | Render selected schematic sheet |
| PCB | `.kicad_pcb` | Render selected board |
| BOM | Saved schematic hierarchy | Display component table |
| 3D CAD | Selected `.kicad_pcb` | Generate and render PCB GLB |
| Order Placing | Selected PCB and schematic/BOM context | Surface existing PCB and PCBA quote/order entry points |

No DFM destination or DFM score is part of this POC.

No STEP/STP preview, mechanical model selector, SolidCraft launch, or mechanical integration is part of this POC.

### 4.3 Empty and unsupported states

The product must remain understandable without a project.

Examples:

- No project: prompt the user to open or select a hardware project.
- No schematic: explain that the project has no discoverable schematic.
- Multiple candidate projects: require explicit selection.
- Multiple boards: allow board selection.
- Unsupported artifact: explain why it cannot be previewed.
- Missing KiCad CLI: explain which setting needs configuration.
- Export failure: show a meaningful error and allow retry.
- Missing quote backend: retain the Order destination and show that the relevant service is unavailable.

Do not silently fall back to an unrelated file or another executable.

---

## 5. DSH extension-point implementation

### 5.1 Navigation

Register one component in:

`conversation.header.leading`

This is a `single`, `root`-scope slot and is available without an active session.

All five destinations must be rendered by that one component.

The plugin must use the existing slot injection/registration pattern and declare every injected service in its client plugin `inject` array.

Do not register additional components into the same single slot.

### 5.2 Artifact viewer

Register one Hardware Engineering right-panel tab type through `ctx.sidebarRightTabs.register`.

Set:

`keepMounted: true`

Register the matching keyed body using:

`sidebar.right.pane.tab`

Use `sidebar.right.openTab(kind, { params, revealIfOpened })` to select the destination and artifact.

The tab parameters must carry enough information to identify the exact artifact, including:

- Destination.
- Canonical artifact identity/path.
- Artifact kind.
- Selected project context where needed.

Use the tab navigation revision to detect subsequent navigation, including navigation with unchanged parameters.

Do not rely on a component remount to refresh the viewer.

Use the tab-info hook and occurrence lifecycle signal where appropriate.

### 5.3 Contextual native-open action

The current POC registers `ContextualOpenAction` in `conversation.session.header.corner`.

This is incorrect because the shipped right-sidebar `ExpandButton` owns that single slot. Dynamic plugin registration can shadow the existing occupant.

Remove this registration.

Preferred implementation: put the native-open action in the Hardware Engineering viewer itself.

Alternative: register an additive action in `conversation.session.header.actions`.

Acceptance requirement: the product action must never hide or replace the DSH right-panel expand control.

### 5.4 Settings

Register a Hardware Engineering settings page through `settings.section`.

Use `ctx.configForms` for host-backed persistence.

The settings page must support:

- KiCad installation or CLI path.
- Validation of the configured executable.
- Refresh/revalidation.
- Clear configured/unconfigured/invalid states.
- SolidCraft installation path as agent environment context only.

SolidCraft must not have a native launch action or mechanical-file opening workflow in this POC.

Do not introduce another settings persistence store.

---

## 6. Artifact discovery and identity

Implement or extend artifact discovery in `@huaqiu/hardware-artifacts`.

### 6.1 Project discovery

Preserve the existing `.hardware-engineering.json` manifest contract:

- `project`
- `schematic`
- `boards[]`
- `mechanical[]`

The `mechanical[]` field may remain in the existing manifest for compatibility, but it must not drive a mechanical viewer or model-selection UI in this POC.

Preserve explicit project selection when discovery is ambiguous.

Exclude common build, archive, output, export, backup and temporary directories.

### 6.2 Schematic hierarchy

Fix the current behavior in `projectFrom` that treats every `.kicad_sch` beside the project as a sheet.

The root schematic is authoritative. Resolve its actual child-sheet hierarchy using KiCad sheet references and file paths.

Do not treat unrelated sibling schematic files as children.

The POC viewer must define its hierarchy semantics explicitly:

- The root schematic is the project entry point.
- The user can select a discovered sheet.
- Each rendered sheet retains its identity and relationship to the root project.
- Parsing one file must not be represented as rendering the entire hierarchical project.

If a child sheet cannot be resolved, show a clear unsupported or missing-sheet state rather than silently substituting another file.

### 6.3 Board selection and ranking

Support multiple `.kicad_pcb` files.

Prefer a board demonstrably owned by the selected project over unrelated neighboring files.

Use explicit ownership/default metadata where available and deterministic discovery ranking otherwise.

If multiple valid boards remain ambiguous, require selection instead of guessing.

### 6.4 Canonical identity

Use canonical absolute artifact paths within the authorized workspace as the basis for artifact identity.

Artifact identity must distinguish:

- Project.
- Artifact kind.
- Exact source file.
- Selected schematic sheet or board where relevant.

Do not use display filenames as unique identities.

The UI must display the exact source artifact associated with the current preview.

---

## 7. Host artifact capabilities

Implement host-side capabilities in `@huaqiu/hardware-artifacts`.

Extend the existing `createHardwareHandler` and route infrastructure rather than creating a separate server.

The host provides two required read capabilities:

1. Raw saved schematic/PCB source content.
2. Generated PCB GLB content.

Existing project, installation, environment and native-open routes remain.

### 7.1 Raw ECAD source route

Provide a route that returns the saved text of an authorized selected `.kicad_sch` or `.kicad_pcb`.

Requirements:

- Accept a host-issued or host-validated canonical artifact identity.
- Resolve the identity against the selected authorized project/workspace.
- Verify the path remains inside the authorized workspace boundary.
- Verify the expected file type.
- Do not accept arbitrary filesystem paths merely because the request originates from localhost.
- Return source revision metadata with the content.
- Return structured errors for missing, invalid, unauthorized or unsupported artifacts.

The browser must not be allowed to turn this endpoint into an arbitrary filesystem read API.

### 7.2 PCB GLB export route

Provide a host capability that generates a GLB from the selected `.kicad_pcb` using the configured `kicad-cli`.

Use the equivalent of:

`kicad-cli pcb export glb`

Use the exact selected board, not a fresh default project lookup.

The export process must:

- Validate the selected artifact and configured CLI.
- Use explicit process arguments.
- Avoid shell command construction.
- Write to a temporary output location.
- Enforce an execution timeout.
- Handle concurrent requests for the same artifact safely.
- Support cancellation or safe abandonment of obsolete requests.
- Publish the result only after successful completion and validation.
- Never serve a partially written GLB.
- Clean up temporary files and obsolete cache entries.

### 7.3 Cache correctness

A cache key based only on absolute path, size and mtime is insufficient as a correctness guarantee.

Use a content hash or another reliable source revision mechanism.

The cache must distinguish changed source content even when file size and timestamp resolution make the old key appear unchanged.

The derived artifact metadata should identify:

- Source canonical path.
- Source revision/hash.
- Generation timestamp.
- Generated artifact identity.

This metadata is not a new project IR or database.

### 7.4 Route security and responses

Retain the existing loopback request guard.

Additionally:

- Validate the artifact identity against the host's authorized workspace context.
- Reject path traversal and symlink escapes.
- Validate the requested artifact type.
- Do not expose arbitrary host paths.
- Return explicit content types and structured failure responses.
- Reject stale results when the source revision no longer matches the requested revision.

---

## 8. Client-side ECAD rendering

Implement the client integration in `@huaqiu/dsh-hardware-ui`.

Use the existing local repository:

`/Users/admin/code/ecad-viewer`

Do not reimplement its parser or 2D renderer.

### 8.1 Dependencies

Use:

- `@huaqiu/kicad-sexpr-parser@0.1.1`
- `@huaqiu/ecad-renderer@0.2.4`

The packages are ESM-only.

The parser exports include:

- `BoardParser.parse(text)`
- `SchematicParser.parse(text)`
- `parseLibSymbols(text)`

The renderer exports include:

- `renderSchematic`
- `renderPcb`
- `renderSymbol`
- `renderFootprint`
- `createRendererWorker`
- `createRendererClient`

Use the documented main-thread rendering APIs for this POC.

Do not use `renderProjectFromZip` or `loadProjectZip` for this integration.

Do not use the current renderer worker path: the worker protocol is parser-only/stubbed and its renderer worker implementation returns an error.

### 8.2 Schematic rendering

Implement a small adapter, for example:

`src/client/ecad.ts`

The adapter must:

1. Obtain the selected saved schematic content from the host.
2. Parse it with `SchematicParser.parse`.
3. Render the parsed result into the Hardware Engineering viewer container using `renderSchematic`.
4. Retain the returned render handle.
5. Call the documented `dispose()` method when replacing or removing the viewer.

Preserve selected sheet identity.

Do not claim that parsing the root file alone renders all child sheets.

The initial POC can render the selected sheet while exposing the discovered hierarchy through the product UI.

### 8.3 PCB rendering

Use the same adapter for PCB rendering:

1. Fetch the selected saved `.kicad_pcb`.
2. Parse with `BoardParser.parse`.
3. Render using `renderPcb`.
4. Retain the render handle.
5. Dispose it when the viewer is replaced or removed.

Do not use the existing PCB viewer's internal renderer as a substitute for `@huaqiu/ecad-renderer`.

The existing PCB viewer remains unchanged and independently functional.

### 8.4 Renderer lifecycle

The viewer must correctly handle:

- Destination changes.
- Artifact changes.
- Navigation revision changes.
- Tab hide/show.
- Session changes.
- Tab unmount.
- Component unmount while a fetch is pending.
- Component unmount while parsing or rendering is pending.

A late asynchronous result must never attach to an obsolete viewer.

Use cancellation/identity checks to reject stale work.

Dispose the previous renderer before attaching a replacement where appropriate.

Use only documented renderer APIs. Do not depend on undocumented viewer internals.

### 8.5 Bundling

Update the existing `tsdown` configuration for `@huaqiu/dsh-hardware-ui`.

Bundle the ESM parser and renderer dependencies as required by the DSH client build, following the existing offline client-bundling pattern used by `@huaqiu/dsh-tool-symbol-footprint`.

Keep React, React DOM and the existing DSH runtime dependencies external according to the repository's established conventions.

Retain the renderer's license notice.

The renderer includes a bundled CJK glyph table. Do not introduce font CDN or runtime network dependencies.

---

## 9. PCB 3D CAD — GLB only

The POC's 3D CAD destination is a PCB 3D viewer.

It is derived from the currently selected `.kicad_pcb`.

### 9.1 Generation

Generate GLB on the host using the configured `kicad-cli`.

Do not implement STEP/STP conversion.

Do not select arbitrary mechanical models.

Do not add a FreeCAD or SolidCraft conversion workflow.

### 9.2 Rendering

Implement a small client component, for example:

`src/client/glb.ts`

Use plain Three.js and `GLTFLoader`.

Use the existing pinned Three.js dependency where practical:

`three@^0.185.1`

Do not import or reuse the ecad-viewer application's app-specific custom-element 3D shell.

Do not reproduce its application-level event system.

Do not use remote CDN decoder URLs.

If decoder assets are required, package and resolve them locally. Keep the initial POC GLB path as small and deterministic as possible.

### 9.3 Viewer states

The 3D destination must distinguish:

- No selected board.
- KiCad CLI not configured.
- Export in progress.
- Export failed.
- GLB loading.
- GLB rendered.
- Unsupported board/export result.

A failed export must not leave the previous board's GLB displayed as though it represented the current selection.

---

## 10. BOM destination

The BOM destination must use the saved schematic hierarchy as its source.

Evaluate and reuse the existing schematic analysis capability, especially:

`analyze_kicad_module` with `view: "bom"`

Do not create a second BOM database or another independent component analysis implementation.

The BOM table should expose, where available:

- Reference designator.
- Quantity.
- Value.
- Footprint.
- Manufacturer.
- MPN.
- Custom fields.
- DNP.
- Exclude-from-BOM state.

Account for:

- Multi-unit symbols.
- Power symbols and non-BOM references.
- `in_bom` / exclude-from-BOM semantics.
- DNP state.
- Hierarchical sheet context.

Grouping must be deterministic and documented.

Do not silently claim that manufacturer or arbitrary custom fields are grouping keys unless the actual implementation uses them.

The BOM must identify its source schematic/root project and selected hierarchy context.

For this POC, saved-file analysis is sufficient. Do not implement live GUI IPC or unsaved-state synchronization.

---

## 11. Native KiCad handoff

The native-open action must open the exact source artifact currently represented by the viewer.

Applicable actions:

| Destination | Native action |
|---|---|
| Schematic | Open selected `.kicad_sch` |
| PCB | Open selected `.kicad_pcb` |
| BOM | Open its source schematic |
| 3D CAD | Open its source `.kicad_pcb` |
| Order Placing | No native-open action required |

Use the existing host process-launch capability in `@huaqiu/hardware-artifacts`.

Requirements:

- Resolve the configured KiCad executable.
- Validate the exact artifact path.
- Pass explicit argv.
- Use `shell: false`.
- Use the artifact's parent directory as appropriate working directory.
- Return explicit configuration, validation and process-launch errors.
- Do not silently fall back to PATH or another installation.
- Do not reconstruct the selected artifact through a fresh project lookup at launch time.

The coding acceptance gate is the host-side launch contract and exact-artifact validation.

The user will independently validate the actual KiCad GUI behavior on Windows. Do not block this POC on automated verification of native window appearance or focus.

---

## 12. Hardware Engineering settings and agent environment

The settings page is product-owned but persisted through the existing DSH host configuration service.

### 12.1 KiCad

Support a configured KiCad CLI or installation path.

The same resolved installation should inform:

- PCB GLB export.
- Native artifact opening.
- Agent environment context.

Do not silently select a different installation if the configured path is invalid.

### 12.2 SolidCraft

SolidCraft is agent environment context only in this POC.

Support a user-configured installation path and expose it in the compact Hardware Engineering agent context.

Do not:

- Add SolidCraft native launch.
- Add mechanical artifact selection.
- Add STEP/STP preview.
- Add a SolidCraft file-opening acceptance gate.

### 12.3 Agent context

Keep the existing `<hardware_environment>` context mechanism.

Expose scoped variables where available:

- `HUAQIU_KICAD_CLI`
- `HUAQIU_KICAD_PCBNEW`
- `HUAQIU_KICAD_EESCHEMA`
- `HUAQIU_SOLIDCRAFT`

Do not mutate global `process.env` to inject project-specific configuration.

The agent must receive accurate configured/unconfigured state and must not be told that an executable is available when validation has failed.

---

## 13. Order Placing — reuse existing Huaqiu capabilities

The Order Placing destination is an entry-point surface, not a new pricing or checkout implementation.

Reuse the existing `@huaqiu/dsh-tool-quote` package and its four tools:

- `quote_pcb`
- `quote_smt`
- `place_pcb_order`
- `place_smt_order`

The existing `hq.fab.v1.QuoteService` exposes:

- `QuotePcb`
- `QuoteSmt`
- `PlacePcbOrder`
- `PlaceSmtOrder`

The existing transport routes are:

- `POST <base>/api/v1/quote/pcb`
- `POST <base>/api/v1/quote/smt`
- `POST <base>/api/v1/quote/place/pcb`
- `POST <base>/api/v1/quote/place/smt`

Do not implement a new DSH-side quote backend.

Do not duplicate KiCad's C++ multipart form assembly.

Do not implement pricing calculations, token handling, authentication, upload packaging or backend URL reconstruction in the UI.

### 13.1 UI behavior

The Order Placing destination should present two distinct workflows:

**PCB fabrication**

- PCB quote.
- PCB order placement.

**PCBA assembly**

- SMT/PCBA quote.
- SMT/PCBA order placement.

Show the currently selected board and available schematic/BOM context where useful.

Expose the existing tool names and entry points to the agent/user.

Quote and order placement remain separate operations.

Order submission must require explicit user confirmation through the existing workflow. Do not silently submit an order as a side effect of navigation or quoting.

### 13.2 Backend behavior

Preserve the existing optional/lazy backend behavior.

A missing quote backend must not:

- Prevent plugin activation.
- Remove the four tool registrations.
- Block offline artifact viewing.
- Block offline activation.

It should produce the existing semantic failure, such as `FAILED_PRECONDITION`, without making a network request to an absent endpoint.

`HUAQIU_QUOTE_BASE_URL` configures the endpoint; it does not guarantee that the configured endpoint implements the expected service contract or that the EDA host has the required capabilities.

Do not describe a configured URL alone as proof that quoting will work.

The existing host/backend owns the order URL and launch behavior. The UI may display the returned URL but must not construct or append parameters to it.

Do not add `tid`, `token`, `source` or other reconstructed query parameters.

### 13.3 Quote input improvements

If a selected board is not open in an EDA host, evaluate whether board facts already available from the saved `.kicad_pcb` can populate existing `quote_pcb` parameters.

Only make a minimal improvement using the existing tool schema.

Do not invent new SMT/BOM fields or extend the quote protocol speculatively.

Live quote verification requires a configured and contract-compatible backend and the required EDA host capabilities. It is not an offline activation gate.

---

## 14. Product bundle and release integration

Keep the existing product bundle entry point:

`@huaqiu/hardware-engineering`

Keep the existing product integration as one bundle row.

Do not add separate bundle rows for the artifact viewer, schematic renderer, PCB renderer or GLB renderer.

Update package versions and exact lockstep pins according to the monorepo release policy.

If package versions change, update the relevant synchronized manifest and release metadata.

Do not reintroduce temporary `link:` dependency overrides into the release configuration.

Preserve the existing offline activation behavior and existing plugin/tool registrations.

The existing 24/24 activation fixture and 11/11 activation rows remain regression gates.

The POC must continue to work without HQ Edge for artifact viewing and product activation.

Quote tools may remain registered while reporting that their optional backend is unavailable.

---

## 15. Implementation sequence

Implement in the following order. Do not parallelize dependent work in a way that creates incompatible contracts.

### P0 — Product UI correction

- Remove DFM from destination model and navigation.
- Keep exactly five destinations.
- Remove `ContextualOpenAction` from `conversation.session.header.corner`.
- Move the native-open action into the viewer body.
- Confirm the existing right-panel expand control remains accessible.
- Verify navigation is visible with no active session.

**Exit:** Product navigation and viewer registration use only the confirmed DSH extension points.

### P1 — Artifact discovery and identity

- Fix root schematic hierarchy resolution.
- Fix project-owned/default board ranking.
- Preserve explicit selection when project/board discovery is ambiguous.
- Define canonical artifact identity and source revision.
- Ensure the UI selects exact artifacts.

**Exit:** Project, schematic sheet and board selections are deterministic and source-backed.

### P2 — Host raw-content route

- Add authorized schematic/PCB source reads.
- Enforce workspace boundaries and file type validation.
- Return revision metadata.
- Add structured error handling.
- Test path traversal, unauthorized paths and stale revisions.

**Exit:** The client can safely obtain the exact selected saved artifact.

### P3 — Schematic and PCB rendering

- Add `ecad.ts`.
- Bundle parser and renderer dependencies.
- Implement schematic rendering.
- Implement PCB rendering.
- Implement disposal, cancellation and stale-result protection.
- Verify the renderer remains functional after navigation and session changes.

**Exit:** Both 2D artifact destinations render correctly in the right-panel viewer.

### P4 — PCB GLB

- Implement host-side CLI export.
- Add content-aware cache invalidation.
- Add atomic output publication and cleanup.
- Implement the Three.js GLB viewer.
- Add loading/error/unsupported states.
- Verify concurrency and interrupted exports.

**Exit:** The selected PCB produces and displays the correct 3D preview.

### P5 — BOM

- Reuse the existing schematic BOM analysis path.
- Add the product BOM table.
- Verify hierarchy, multi-unit, DNP and exclude-from-BOM behavior.
- Preserve exact source identity.

**Exit:** BOM is a deterministic projection of the selected saved schematic.

### P6 — Native handoff and settings

- Validate configured KiCad paths.
- Implement exact-artifact shell-free launch.
- Add viewer contextual actions.
- Implement Hardware Engineering settings through `configForms`.
- Supply scoped agent environment context.
- Keep SolidCraft path configuration as context only.

**Exit:** Native handoff and configuration work without shell changes or global environment mutation.

### P7 — Order Placing

- Wire the two entry-point workflows to existing quote/order tools.
- Display selected board and available BOM context.
- Preserve explicit confirmation for order placement.
- Verify optional backend behavior and semantic failures.

**Exit:** The UI reuses existing quote/order capabilities without implementing another backend.

### P8 — Packaging and regression

- Update exact package pins and manifest metadata.
- Remove temporary local dependency overrides.
- Verify offline activation.
- Verify existing PCB viewer and other existing tools.
- Build the Windows x64 distribution.
- Run the release validation suite.

**Exit:** Product bundle is packaged and usable in the target DSH Desktop distribution.

---

## 16. Required tests and acceptance criteria

### 16.1 Product layout

**U1 — Navigation without a session**

- Start DSH without an active conversation.
- Verify the five destinations are visible.
- Verify the navigation is registered through `conversation.header.leading`.

**U2 — Right-panel persistence**

- Open Hardware Engineering viewer.
- Hide the right panel.
- Switch sessions.
- Reopen the viewer.
- Verify the expected body remains mounted.

**U3 — Navigation revision**

- Reopen the viewer with changed artifact params.
- Reopen with unchanged params.
- Verify the navigation revision changes and the selected artifact refreshes without relying on remount.

**U4 — Contextual action safety**

- Verify the native-open action is available in the viewer.
- Verify the DSH right-panel expand control remains visible and functional.

**U5 — Settings persistence**

- Configure a KiCad path.
- Validate it.
- Restart DSH.
- Verify the setting persists and its validation state is correctly reconstructed.

### 16.2 Artifact discovery and rendering

**A1 — Canonical project**

- Discover a project with a root schematic and one board.
- Verify both resolve to the expected project.

**A2 — Ambiguous project**

- Provide multiple candidate projects.
- Verify explicit selection is required.

**A3 — Board ownership**

- Provide a project-owned board and unrelated neighboring boards.
- Verify the owned board ranks correctly.

**A4 — Schematic hierarchy**

- Provide a root schematic referencing child sheets.
- Verify the hierarchy is resolved from sheet references.
- Verify unrelated sibling `.kicad_sch` files are not included.

**A5 — Schematic rendering**

- Render the selected saved schematic sheet.
- Verify correct source identity and visible content.

**A6 — PCB rendering**

- Render the selected saved PCB.
- Verify the rendered board matches the selected source.

**A7 — Stale rendering**

- Change destination or artifact while a fetch or render is pending.
- Verify the old result cannot replace the current viewer.

**A8 — Unmount cleanup**

- Unmount the tab while a fetch or render is pending.
- Verify no stale canvas is attached and renderer resources are disposed.

**A9 — BOM**

- Verify references, quantity, value, footprint, MPN, manufacturer, custom fields, DNP and exclude-from-BOM where available.
- Verify multi-unit and hierarchical behavior.
- Verify grouping semantics against actual implementation.

### 16.3 GLB

**G1 — Export and render**

- Export GLB from the selected `.kicad_pcb`.
- Render it in the 3D destination.

**G2 — Source invalidation**

- Modify the source board.
- Verify the cached GLB is invalidated.

**G3 — Concurrent requests**

- Request the same export concurrently.
- Verify no partial output or cache corruption is exposed.

**G4 — Interrupted export**

- Interrupt or time out the CLI.
- Verify temporary files are cleaned and no incomplete GLB is served.

**G5 — Missing CLI**

- Remove or invalidate the configured CLI.
- Verify a clear configuration error and no silent PATH fallback.

### 16.4 Native handoff and environment

**H1 — Exact KiCad launch**

- Open selected schematic, PCB, BOM source schematic and PCB 3D source PCB.
- Verify each launch uses the exact selected artifact.

**H2 — Shell-free launch**

- Verify explicit argv and `shell: false`.
- Verify invalid paths are rejected.

**H3 — Environment context**

- Verify the agent receives configured KiCad and SolidCraft paths.
- Verify invalid/unconfigured state is accurately represented.
- Verify no global `process.env` mutation occurs.

### 16.5 Quote/order

**Q1 — Offline registration**

- Verify all four existing quote/order tools register without a backend.
- Invoke one and verify the semantic failure is returned without a network request.
- Verify artifact viewing and plugin activation remain functional.

**Q2 — Configured endpoint**

- Test against a mocked or real endpoint implementing the expected service contract.
- Verify existing quote payloads and response mapping.
- Verify no token or authentication logic moves into the UI plugin.

**Q3 — Order URL ownership**

- Verify the returned order URL is passed through unchanged.
- Verify the UI does not reconstruct or append query parameters.

**Q4 — Explicit order confirmation**

- Verify navigation and quote operations never submit an order automatically.
- Verify placement requires explicit user confirmation.

### 16.6 Release

**R1 — Offline activation**

- Run the existing 24/24 activation fixture.
- Verify all 11 expected activation rows.

**R2 — HQ Edge independence**

- Verify Hardware Engineering activation and artifact viewing work without HQ Edge.

**R3 — Existing functionality**

- Verify the existing PCB viewer, turn-tail card, standalone route and existing tools remain functional.

**R4 — Windows x64 distribution**

- Build and validate the target Huaqiu DSH Desktop distribution.
- Verify package versions and manifest pins are synchronized.

---

## 17. Explicitly out of scope

The following are not implementation requirements or release blockers for this POC:

- DFM destination, DFM analysis or DFM score.
- STEP/STP parsing or conversion.
- Mechanical model discovery or selection.
- SolidCraft native application launch.
- FreeCAD integration.
- Native KiCad or SolidCraft application embedding.
- Live KiCad IPC.
- Unsaved native-editor state synchronization.
- A universal ECAD Project IR.
- A shadow project database.
- A new PCB renderer or rehosting the existing PCB viewer.
- A new quote/order backend.
- A DSH shell or Electron modification.
- HQ Edge runtime dependency.
- `kipy` installation or Python runtime.
- Automated native-window focus/appearance verification.
- A full-width `shell.header` slot.

Do not add these features opportunistically during implementation.

---

## 18. Implementation constraints and reporting

The implementation must remain source-driven and minimal.

For every new route, UI extension, service dependency or process operation:

- Use existing repository conventions.
- Identify the owning package.
- Avoid duplicated ownership.
- Document the actual source contract.
- Provide explicit failure states.
- Add tests at the owning layer.

Do not invent APIs based on the conceptual architecture. Inspect the current implementation and adapt to the actual exported contracts.

If an existing API is insufficient, first determine whether a small plugin-side adapter can solve the problem. Do not modify DSH core unless a concrete required behavior cannot be delivered through the confirmed extension points.

### Required implementation report

At completion, provide:

1. Summary of implemented behavior.
2. Files changed, grouped by repository and package.
3. New or modified host routes and their authorization contracts.
4. Renderer and GLB lifecycle implementation.
5. Artifact identity and revision strategy.
6. Native KiCad launch behavior.
7. Settings and agent environment behavior.
8. Quote/order integration behavior.
9. Test matrix with pass/fail/blocked status and evidence.
10. Packaging and activation results.
11. Known limitations and explicitly deferred work.

Do not report a test as passed merely because its API or source declaration exists. Distinguish source inspection, unit tests, integration tests, Windows validation and external backend validation.

---

## 19. Definition of Done

The POC is complete when:

- The five Hardware Engineering destinations are persistently visible in the approved DSH layout.
- The product works without modifying the DSH shell.
- The right-panel viewer retains its state correctly and renders the exact selected artifact.
- Schematic and PCB use the existing Huaqiu parser/renderer packages.
- PCB 3D is generated from the selected board as GLB and rendered locally.
- BOM is derived from the saved schematic hierarchy.
- Native KiCad actions open the exact source artifact using the configured installation.
- Settings persist through the existing DSH configuration service.
- Agent environment context accurately reflects configured tools.
- Order Placing uses the existing Huaqiu quote/order tools.
- Missing quote infrastructure does not block offline use.
- Existing DSH functionality and the standalone PCB viewer remain intact.
- Offline activation and Windows x64 packaging pass their required gates.

**Final architecture:** one Hardware Engineering product UI plugin, one host artifact capability, existing ECAD parser/renderer packages, existing quote/order tools, and no DSH shell modification.
# Hardware Engineering — Full Implementation Code Specification

**Priority:** P0  
**Type:** Implementation task  
**Product:** Hardware Engineering  
**Package:** `@huaqiu/hardware-engineering`  
**Tool namespace:** `hardware.*`  
**Target:** Huaqiu DSH Desktop on Windows x64  
**Implementation model:** Direct modifications to the Huaqiu DSH fork and its plugin monorepo

---

## 1. Objective

Implement Hardware Engineering as a file-centric hardware design experience inside DSH.

The user should be able to work with hardware design artifacts through the same unrestricted workspace model used for ordinary software development:

- Ask the agent to create or modify a schematic.
- Ask the agent to create or modify a PCB.
- Generate a mechanical STEP/STP model independently.
- Open generated or existing ECAD files directly from the workspace.
- Preview those files graphically in the existing DSH document MDI.
- Ask the agent to analyze a design, generate a BOM, or prepare a fabrication order.
- Let the agent guide the user through selecting the correct project and preparing the required fabrication files.
- Review the resulting Huaqiu ordering page inside a new MDI tab.

The implementation must not introduce a separate project-oriented application shell.

### 1.1 Core UX principle

The workspace and its files are the primary interaction model.

The user should not have to understand a new Hardware Engineering navigation system, select a project before previewing files, or learn a separate artifact-management workflow.

The agent can work with any accessible workspace file. Hardware Engineering adds domain-specific rendering and capabilities to DSH's existing document workflow.

### 1.2 Explicitly excluded UX

Do not implement:

- A fixed Hardware Engineering navigation bar.
- Fixed Schematic, PCB, BOM, 3D CAD, DFM or Order tabs.
- A dedicated Hardware Engineering project selector.
- A second document MDI or viewer framework.
- A separate project dashboard.
- A dedicated Order button or Order tab.
- A native KiCad or SolidCraft embedded application.
- A new order-management UI or pricing workflow.

The existing DSH explorer, conversation, document-opening behavior, document MDI and other document renderers must remain intact.

---

## 2. Repository and package boundaries

Use the existing repositories and packages.

| Repository | Responsibility |
|---|---|
| `deepseek-harness` | DSH document MDI, renderer dispatch and the smallest necessary host extension |
| `dsh-pcb-eda` | Hardware Engineering plugins, tools, artifact capabilities and UI integration |
| `ecad-viewer` | Existing schematic/PCB parser and renderer foundation |
| `kicad` | Existing KiCad CLI behavior and reference implementation |

Relevant existing packages:

- `@huaqiu/hardware-engineering`
- `@huaqiu/hardware-artifacts`
- `@huaqiu/dsh-hardware-ui`
- `@huaqiu/dsh-kicad`
- `@huaqiu/dsh-tool-kicad-schematic-gen`
- `@huaqiu/dsh-tool-pcb-viewer`
- `@huaqiu/dsh-tool-quote`
- `@huaqiu/dsh-tool-part-search`
- `@huaqiu/dsh-artifacts`
- `@huaqiu/dsh-auth`
- `@huaqiu/ecad-renderer`
- `@huaqiu/kicad-sexpr-parser`

Before implementation, inspect the current checked-out source and package versions. Do not assume that previous audit findings still match the current branch.

### 2.1 Ownership rules

1. DSH Desktop owns application lifecycle and runtime management.
2. The DSH document MDI owns document tabs, navigation and renderer lifecycle.
3. Hardware Engineering owns ECAD-specific document rendering integration and hardware-domain tools.
4. `@huaqiu/ecad-renderer` and `@huaqiu/kicad-sexpr-parser` remain the shared schematic/PCB rendering foundation.
5. The existing PCB viewer remains intact and continues to own its existing tool, turn-tail card and standalone viewer route.
6. Existing Huaqiu quote/order backend contracts remain authoritative.
7. KiCad CLI is invoked through the existing supported host/process capabilities, not through a new daemon.

Do not reintroduce HQ Edge as a required runtime dependency.

---

## 3. Phase A — DSH document MDI integration

### 3.1 Source inspection before modification

Inspect the current DSH source and identify:

- How explorer file clicks open documents.
- How agent-response document links open documents.
- How document identity and tab identity are represented.
- How the active document is selected.
- How document renderers are dispatched.
- How existing Markdown, code, image and other document renderers are registered.
- How document loading, errors, refresh and disposal work.
- Whether document rendering is extensible by plugins.
- Whether a renderer can receive a document revision or refresh notification.
- Whether an existing document renderer can be extended without changing the MDI shell.

Produce a short implementation note identifying the exact source files, APIs, types and lifecycle methods that will be used.

Do not recreate the MDI based on the previous Backplane POC.

### 3.2 Renderer integration strategy

Preferred implementation:

Register ECAD document renderers through an existing DSH plugin extension point.

If the current renderer architecture does not expose a usable extension point, make the smallest reusable change to DSH's document-preview infrastructure.

The change must be generic: it should allow additional document types to register renderers without introducing Hardware Engineering-specific logic into the MDI shell.

Do not change the overall right-panel layout or existing document-opening behavior.

### 3.3 Supported document types

Add graphical document rendering for:

| Extension | Renderer | Behavior |
|---|---|---|
| `.kicad_sch` | Schematic renderer | Render the schematic graphically |
| `.kicad_pcb` | PCB renderer | Render the PCB graphically |
| `.step` | 3D model renderer | Render the STEP model |
| `.stp` | 3D model renderer | Render the STP model |

Extension matching should be case-insensitive.

A supported file should open graphically through the existing MDI whether it was opened from:

- The workspace explorer.
- An agent response or artifact link.
- Another existing DSH document-opening action.

Do not require a `.kicad_pro` file merely to preview a standalone `.kicad_sch` or `.kicad_pcb`.

Do not require project discovery or project selection for STEP/STP preview.

Preserve the existing text/code document behavior for all unrelated file types.

### 3.4 Document identity and tab behavior

Use DSH's existing document identity and MDI tab semantics.

Requirements:

- Opening the same document again should follow existing DSH behavior rather than creating duplicate tabs.
- Different files must remain independently addressable.
- Changing the active tab must not cause another document's renderer to display stale content.
- A file changed externally or by the agent must be refreshable.
- Renderer resources must be disposed when the document is closed or replaced.
- An asynchronous request for an old document revision must never overwrite a newer active revision.
- Renderer errors must be shown within the document, not crash the MDI or conversation.

Do not invent a second document identity system.

### 3.5 Renderer lifecycle

Each renderer must correctly handle:

1. Document opened.
2. Document content loaded.
3. Renderer initialized.
4. Document resized.
5. Document revision changed.
6. Document closed.
7. Rendering failed.

Use the actual lifecycle exposed by DSH. Do not add a parallel tab state store.

The renderer must release:

- Canvas and WebGL resources.
- Event listeners.
- Resize observers.
- Pending requests.
- Any model or geometry resources it owns.

Ensure pending asynchronous rendering cannot update an unmounted document.

---

## 4. Phase B — Schematic rendering

### 4.1 Rendering foundation

Use:

- `@huaqiu/kicad-sexpr-parser`
- `@huaqiu/ecad-renderer`

Do not implement another KiCad schematic parser or introduce another 2D rendering engine.

Current known package interfaces include:

- `SchematicParser.parse(text)`
- `renderSchematic(...)`

Verify exact current exports and type definitions before coding.

### 4.2 Input behavior

The renderer should accept a standalone `.kicad_sch` file.

It must not require project discovery for the initial rendering operation.

For a schematic with referenced child sheets, inspect the actual parsed hierarchy and implement the smallest practical file-resolution mechanism.

Requirements:

- Resolve child-sheet paths relative to the owning schematic file.
- Avoid treating every sibling `.kicad_sch` file as a child sheet.
- Use the actual sheet references and UUID/path relationships in the KiCad file.
- Do not silently include unrelated schematic files.
- If a referenced child sheet cannot be resolved, render the available schematic and show a useful warning.

For the initial implementation, prioritize correct rendering of the selected schematic document. Full project-wide sheet navigation is not a prerequisite unless the existing renderer naturally supports it.

### 4.3 Rendering behavior

- Render the schematic graphically inside the existing document MDI.
- Support zoom and pan to the extent provided by the renderer.
- Preserve the original document file as the source of truth.
- Do not modify the source file during preview.
- Do not introduce a second schematic editor.
- Do not implement live KiCad IPC synchronization.

The renderer should not expose an independent project selector.

---

## 5. Phase C — PCB rendering

### 5.1 Rendering foundation

Use the same `@huaqiu/ecad-renderer` foundation used for schematic rendering.

Do not rehost or duplicate `@huaqiu/dsh-tool-pcb-viewer`.

The new MDI renderer is a document-preview integration, not a replacement for the existing PCB viewer.

### 5.2 Input behavior

A standalone `.kicad_pcb` must render without requiring `.kicad_pro`.

Use:

- `BoardParser.parse(text)`
- `renderPcb(...)`

Verify the current parser and renderer API before implementation.

### 5.3 Rendering behavior

- Render the selected PCB document in the existing MDI.
- Support the renderer's available pan and zoom interactions.
- Preserve layers and PCB geometry supported by the renderer.
- Do not edit the source PCB.
- Do not introduce a second PCB viewer package.
- Do not change the existing PCB viewer tool, turn-tail card or standalone route.

The two experiences have different responsibilities:

| Experience | Responsibility |
|---|---|
| Document MDI renderer | Quickly preview a `.kicad_pcb` opened as a workspace document |
| Existing PCB viewer | Retain its current tool-driven and standalone interactive viewer experience |

Do not merge these two implementations merely to avoid sharing a small amount of code.

---

## 6. Phase D — STEP/STP rendering

### 6.1 Requirement

A user or agent must be able to generate or place a `.step` or `.stp` file in the workspace and open it directly in the existing document MDI.

No PCB project or KiCad project should be required.

### 6.2 Conversion and rendering

Inspect the available local dependencies and existing project code to identify the most maintainable browser-compatible STEP/STP rendering path.

Do not assume the ECAD 2D renderer supports STEP.

Do not silently treat STEP as GLB or require the user to manually convert it.

The implementation must select and document one supported strategy:

- Direct STEP/STP parsing and rendering in the browser, if an appropriate existing dependency is available and suitable.
- Host-side conversion to a browser-renderable intermediate format, with the conversion implementation and dependency explicitly identified.

The result must be viewable in the MDI without launching SolidCraft.

### 6.3 Conversion requirements

If conversion is required:

- Keep the original STEP/STP file authoritative.
- Generate derived output in a cache or controlled temporary location.
- Do not modify or overwrite the source model.
- Cache derived output using a reliable source revision or content hash.
- Do not reuse stale output after the source changes.
- Avoid partial output being served.
- Support cancellation and timeout.
- Clean up abandoned temporary output.
- Return actionable errors for unsupported or invalid files.

The rendering UI must own and dispose of its 3D resources.

### 6.4 3D interaction

Provide a practical preview:

- Orbit.
- Pan.
- Zoom.
- Fit model to view.
- Sensible initial camera position.
- Basic background and lighting suitable for mechanical geometry.

Do not implement mechanical editing, feature history, CAD constraints or SolidCraft integration.

---

## 7. Phase E — Artifact access and security

### 7.1 Host-side artifact access

Use the existing `@huaqiu/hardware-artifacts` capabilities and DSH-authorized workspace access.

Extend only what is required for:

- Reading `.kicad_sch`.
- Reading `.kicad_pcb`.
- Reading `.step` and `.stp`, or converting them when needed.
- Returning document revision information.
- Serving generated preview assets.

Do not add an independent filesystem server.

### 7.2 File identity

The client must not be allowed to read arbitrary filesystem paths by constructing a localhost URL.

Use a host-issued or otherwise validated document identity.

The host must:

- Verify that the requested document belongs to an authorized workspace.
- Verify that the requested artifact is of an expected supported type.
- Canonicalize paths and prevent traversal outside the authorized workspace.
- Return a stable document identity and revision.
- Return structured errors for missing, unsupported or unauthorized files.

Follow existing DSH workspace access rules rather than creating a parallel authorization model.

### 7.3 Preview cache

Derived data must be keyed by a reliable source revision.

Do not rely only on absolute path, file size and modification time when a content hash or reliable revision is practical.

Cache behavior must ensure:

- Source changes invalidate derived data.
- Concurrent requests do not publish partial results.
- Failed conversions do not poison the cache.
- Old cache entries can be cleaned up.
- Multiple documents cannot accidentally share output.

### 7.4 Offline operation

The preview pipeline must work without CDN access.

Bundle or locally provide all required runtime dependencies and assets.

Do not download parsers, renderers, 3D decoders, fonts or other rendering dependencies at runtime.

---

## 8. Phase F — Workspace and project semantics

### 8.1 General preview is file-centric

Previewing a file must not trigger project selection or project discovery as a prerequisite.

A workspace may contain:

- Multiple KiCad projects.
- Dozens of PCB files.
- Independent schematics.
- Generated artifacts.
- STEP/STP models.
- Gerber and drill outputs.
- BOM files.
- Archives and unrelated documents.

The implementation must not assume a clean workspace with exactly one project.

### 8.2 Project context is an agent workflow concern

Some operations, especially fabrication ordering, require project-level context.

The agent should identify the intended project through conversation and inspect the workspace when necessary.

Do not impose a global selected-project state on the document MDI or the entire Hardware Engineering UI.

### 8.3 Project discovery

Inspect and reuse existing artifact/project metadata where appropriate.

The existing `.hardware-engineering.json` manifest may provide useful metadata, but it must not become a mandatory prerequisite for opening an individual document.

Do not assume every sibling `.kicad_sch` is part of the same schematic hierarchy.

Do not assume every `.kicad_pcb` belongs to the nearest `.kicad_pro`.

When multiple projects or boards exist, preserve their ownership and paths and ask the user to disambiguate when the agent cannot determine the intended target reliably.

---

## 9. Phase G — Agent-driven fabrication ordering

### 9.1 Product decision

There is no explicit Order entrypoint in the Hardware Engineering UI.

Do not add:

- An Order tab.
- An Order button.
- A project-level Order action.
- A dedicated order wizard.
- A separate order-management page inside Hardware Engineering.

Ordering is a conversational agent workflow.

The agent should ask the user which project they want to send for fabrication when the intended project is not unambiguous.

The agent then prepares the required files, invokes the existing Huaqiu quote/order capabilities, and opens the returned Huaqiu ordering page inside a new DSH document MDI tab.

### 9.2 Expected user journey

Example:

1. User: "Prepare this board for fabrication."
2. Agent inspects the workspace.
3. Agent finds multiple candidate projects or boards.
4. Agent asks which project/board should be sent for fabrication.
5. User identifies the intended project.
6. Agent inspects the selected project and its board.
7. Agent uses `kicad-cli` to export the required fabrication files.
8. Agent prepares the BOM and other required inputs.
9. Agent validates that the required outputs exist and belong to the selected board/project.
10. Agent invokes the existing Huaqiu quote/order service.
11. The service returns the ordering URL or equivalent result.
12. DSH opens that URL in a new document MDI tab.
13. The user completes the existing Huaqiu ordering flow within DSH.

The agent should not make the user manually export Gerbers, assemble a BOM or locate files that the CLI can produce.

### 9.3 Project and board selection

The agent must not arbitrarily select the first project or board in a messy workspace.

It should inspect:

- Candidate `.kicad_pro` files.
- Associated `.kicad_pcb` files.
- Associated schematic files.
- Project and board ownership.
- Relevant project metadata.
- Existing fabrication outputs where useful.

Use actual KiCad project relationships and source-proven metadata.

When ambiguity remains, ask a concise conversational question identifying the candidate projects/boards in human-readable terms.

The agent must preserve the exact selected project and board identity throughout the export and order process.

### 9.4 KiCad CLI export

Use the installed/configured KiCad CLI through the existing supported process capability.

Do not introduce a separate KiCad CLI service or daemon.

The agent should invoke the appropriate CLI operations to generate the files required by the actual Huaqiu order form and backend contract.

Expected categories include:

- Gerber fabrication layers.
- Drill files.
- Board fabrication data.
- BOM.
- Position/centroid data when required.
- Other manufacturing files explicitly required by the actual order form.

Do not assume that every order needs every file above. Inspect the existing Huaqiu order contract and form requirements and implement the exact required set.

The export implementation must:

- Use the selected board/project, not an arbitrary workspace file.
- Use shell-free process invocation with explicit executable and argument arrays.
- Use a controlled output directory.
- Capture stdout and stderr.
- Enforce a timeout.
- Detect non-zero exit status.
- Validate generated files before submission.
- Avoid silently reusing stale fabrication outputs.
- Preserve source project files.
- Report missing or unsupported CLI capabilities clearly.

Use the installed KiCad CLI version and supported export options rather than hardcoding assumptions from a different KiCad release.

### 9.5 BOM generation

The agent must generate or obtain a BOM suitable for the actual Huaqiu order form.

Inspect the existing KiCad BOM generation and Huaqiu SMT order implementation to establish:

- Required columns.
- Required component identifiers.
- MPN and manufacturer fields.
- Footprint and value fields.
- DNP and assembly inclusion semantics.
- Quantity aggregation rules.
- Any required component coordinate or placement relationship.

Use existing project/component data where possible.

Do not invent MPNs or manufacturers.

Do not include DNP or excluded components in the assembly BOM unless the actual order contract explicitly requires them.

If required BOM information is missing, let the agent explain what is missing and ask the user for the necessary information instead of silently fabricating values.

### 9.6 Export package integrity

Keep generated files associated with the selected project and board.

Use a controlled staging directory or temporary fabrication package.

Requirements:

- Include only the selected board's relevant fabrication outputs.
- Include all required BOM and placement inputs.
- Avoid mixing files from sibling projects.
- Avoid including stale exports.
- Preserve a manifest or equivalent internal record of the source project, board and generated outputs.
- Validate file existence and non-zero size.
- Validate that all required files belong to the same selected board.
- Do not submit a partial package.

The agent should summarize the prepared package before invoking the order operation when there is meaningful ambiguity or missing information.

### 9.7 Existing Huaqiu quote/order backend

Reuse the existing Huaqiu quote/order integration.

Relevant existing contract:

`hq.fab.v1.QuoteService`

- `QuotePcb`
- `QuoteSmt`
- `PlacePcbOrder`
- `PlaceSmtOrder`

Existing DSH package:

`@huaqiu/dsh-tool-quote`

Existing tools include:

- `quote_pcb`
- `quote_smt`
- `place_pcb_order`
- `place_smt_order`

Inspect the current implementation and actual backend contract before changing the workflow.

Do not build another pricing engine, multipart uploader, authentication implementation or payment flow.

Do not move Huaqiu credentials or token handling into the browser renderer.

The agent should use the existing tool contracts, extending them only where the current contract cannot represent the required prepared fabrication package or MDI navigation result.

### 9.8 Ordering URL must open inside DSH MDI

This is a mandatory behavior change.

The current behavior of opening the returned Huaqiu ordering URL in the system default browser must be replaced for this workflow.

After the quote/order backend returns the ordering URL:

1. Validate that the returned URL is suitable for the existing Huaqiu ordering workflow.
2. Pass the URL to the DSH host-side document-opening/navigation mechanism.
3. Open it as a new document MDI tab.
4. Display the Huaqiu ordering page inside DSH.
5. Preserve the existing DSH document tabs and active-tab behavior.

Do not call the system default browser for this workflow.

Do not build a second browser tab system or another right-panel implementation.

### 9.9 MDI web document support

Inspect the existing DSH MDI and determine whether it already supports an embedded web document or URL-backed document.

If it does, reuse that implementation.

If it does not, add the smallest reusable web-document renderer or document-opening capability required to open the Huaqiu order page inside the existing MDI.

This must be a general-purpose document capability, not a special Hardware Engineering order panel.

The implementation must consider:

- URL/document identity.
- Reopening the same ordering URL.
- Loading and navigation errors.
- Loading state.
- Session/cookie behavior.
- Authentication and redirects.
- External links.
- Browser security boundaries.
- MDI tab close and lifecycle behavior.

Do not create a custom Huaqiu checkout implementation.

Do not intercept or reconstruct the Huaqiu order form.

The existing Huaqiu page remains responsible for its own order UI and user interaction.

### 9.10 URL and navigation safety

The ordering URL is returned by the trusted Huaqiu backend, but it must still be handled through the appropriate DSH navigation boundary.

Do not expose an arbitrary URL-opening capability to untrusted document content.

Inspect existing DSH URL navigation and webview policies and reuse them.

If the returned URL is invalid or cannot be opened inside the MDI, report the failure to the agent and user. Do not silently fall back to opening the system default browser.

### 9.11 Order workflow failure handling

Handle these cases explicitly:

- No project found.
- Multiple candidate projects.
- Multiple boards in the selected project.
- Missing KiCad CLI.
- Unsupported CLI version or export operation.
- Invalid project or PCB.
- Export timeout.
- Export failure.
- Missing required Gerber/drill files.
- Missing or incomplete BOM.
- Invalid MPN or placement data where required.
- Quote service unavailable.
- Order service unavailable.
- Backend rejection.
- Missing or invalid ordering URL.
- MDI web document cannot be opened.

Failures must be reported to the agent in structured form so it can explain the issue and continue the conversation.

Do not present a successful order-preparation result if the package or backend operation failed.

### 9.12 Order submission and user confirmation

The agent must distinguish between:

- Preparing fabrication files.
- Requesting a quote.
- Opening the returned ordering page.
- Actually submitting or paying for an order.

Opening the Huaqiu page is not proof that an order was submitted.

The final purchase/checkout action remains within the existing Huaqiu page and its existing user confirmation flow.

Do not bypass the existing confirmation or payment workflow.

---

## 10. Phase H — Agent tool surface

### 10.1 Tool design

Keep the tool surface focused.

The agent should be able to:

- Inspect workspace hardware artifacts and project candidates.
- Inspect a selected project's boards and relevant files.
- Obtain board/project facts.
- Generate or inspect BOM data.
- Invoke the supported KiCad CLI export operations.
- Prepare and validate fabrication inputs.
- Invoke existing quote/order tools.
- Open the returned ordering page inside the document MDI.

Reuse existing tools where their semantics already match.

Do not create a separate tool for every CLI argument or file extension.

### 10.2 Tool naming

Use the existing namespace:

`hardware.*`

Use current tool names where they already provide the required functionality.

New tools should express meaningful hardware-domain operations, not low-level implementation details.

Possible responsibilities include:

- Workspace artifact discovery.
- Project/board inspection.
- Fabrication package preparation.
- Fabrication package validation.
- MDI document opening.

These are responsibilities, not a requirement to create exactly five separate tools. Prefer the smallest practical set.

### 10.3 Agent context

Provide compact, useful context describing:

- Workspace candidate projects and boards.
- Available KiCad CLI capability/version.
- Selected project/board identity when established.
- Relevant artifact paths.
- Missing or incomplete manufacturing metadata.
- Existing quote/order tools.
- How to open a returned Huaqiu ordering page in DSH.

Do not inject an exhaustive workspace file listing into every prompt.

Do not force a global project selection just to provide agent context.

---

## 11. Phase I — Settings and executable discovery

Only add settings that are genuinely needed.

For KiCad CLI:

- Reuse existing DSH/KiCad executable discovery and configuration.
- Respect the configured executable path.
- Report the resolved executable and version to the agent.
- Do not silently select an unrelated KiCad installation.
- Do not require a new Hardware Engineering settings page unless the existing settings infrastructure cannot represent the configuration.

For STEP/STP conversion, add only the configuration required by the selected implementation.

SolidCraft integration is out of scope. Do not add a SolidCraft launcher, executable handoff or native file-opening workflow.

---

## 12. Phase J — Packaging and runtime

### 12.1 Bundle

Keep Hardware Engineering as the existing bundle entry:

`@huaqiu/hardware-engineering`

Ensure all required packages are bundled and resolvable in the installed Huaqiu DSH Desktop runtime.

### 12.2 Dependencies

Reuse the existing packages:

- `@huaqiu/kicad-sexpr-parser`
- `@huaqiu/ecad-renderer`

Use the existing Three.js dependency if appropriate for the selected STEP/STP renderer.

Do not add another general-purpose ECAD parser or 2D renderer.

All runtime assets must be locally available.

### 12.3 Runtime constraints

- Windows x64 is the primary implementation and acceptance target.
- No separate daemon.
- No HQ Edge runtime dependency.
- No Python runtime dependency.
- No Docker dependency.
- No external CDN requirement.
- No native KiCad or SolidCraft embedding.
- No live KiCad IPC synchronization requirement.
- No changes to the existing PCB viewer's standalone behavior.

---

## 13. Implementation sequence

Implement in the following order. Keep each stage independently testable.

### M1 — DSH MDI renderer extension

1. Audit current document MDI source.
2. Confirm the renderer extension mechanism.
3. Implement the smallest required generic extension point if necessary.
4. Register a test renderer for a supported document type.
5. Verify explorer and agent-response document opening still work.
6. Verify existing Markdown, code and image rendering remains unchanged.

**Exit condition:** A plugin can register and render a new document type inside the existing MDI without introducing a second tab system.

### M2 — Schematic and PCB rendering

1. Integrate `@huaqiu/kicad-sexpr-parser`.
2. Integrate `@huaqiu/ecad-renderer`.
3. Implement host-authorized file access.
4. Implement schematic renderer.
5. Implement PCB renderer.
6. Implement revision handling and disposal.
7. Test standalone files and project files.

**Exit condition:** `.kicad_sch` and `.kicad_pcb` open graphically in the existing MDI.

### M3 — STEP/STP rendering

1. Select and document the supported STEP/STP conversion/rendering path.
2. Implement conversion if required.
3. Implement revision-aware caching.
4. Implement the 3D MDI renderer.
5. Test representative STEP/STP files.
6. Verify offline operation and resource disposal.

**Exit condition:** Standalone `.step` and `.stp` files open graphically in the existing MDI without SolidCraft.

### M4 — Agent-driven fabrication preparation

1. Audit existing project discovery and hardware artifact tools.
2. Implement reliable project/board ownership resolution.
3. Implement KiCad CLI capability detection.
4. Implement BOM generation/inspection.
5. Implement Gerber and drill export.
6. Implement required additional export operations.
7. Implement package validation.
8. Return structured results to the agent.

**Exit condition:** The agent can identify a target project/board and produce a validated fabrication package without a dedicated UI order entrypoint.

### M5 — Huaqiu ordering page in MDI

1. Audit current quote/order tools and backend responses.
2. Reuse existing Huaqiu backend contracts.
3. Add a general URL-backed MDI document capability if needed.
4. Connect the returned ordering URL to the MDI opening mechanism.
5. Ensure no system-default-browser fallback.
6. Verify the Huaqiu page loads and retains its required session/authentication behavior.

**Exit condition:** The agent can prepare a package, invoke the existing backend, and open the returned Huaqiu ordering page in a new MDI tab.

### M6 — Bundle and installer integration

1. Remove temporary local `link:` dependency overrides.
2. Verify package dependency resolution.
3. Build the Hardware Engineering bundle.
4. Build Huaqiu DSH Desktop for Windows x64.
5. Install and test the packaged build.
6. Verify upgrade and offline behavior.

**Exit condition:** The packaged Huaqiu DSH Desktop includes the complete implementation without development-machine-only dependencies.

---

## 14. Acceptance criteria

### 14.1 Existing DSH behavior

- [ ] Existing MDI layout remains intact.
- [ ] Explorer document opening remains intact.
- [ ] Agent-response document links remain intact.
- [ ] Markdown rendering remains intact.
- [ ] Code rendering remains intact.
- [ ] Image rendering remains intact.
- [ ] Existing PCB viewer tool and route remain intact.
- [ ] No second MDI or viewer tab system exists.

### 14.2 ECAD document preview

- [ ] Standalone `.kicad_sch` opens graphically.
- [ ] Standalone `.kicad_pcb` opens graphically.
- [ ] `.step` opens graphically.
- [ ] `.stp` opens graphically.
- [ ] Extension matching is case-insensitive.
- [ ] No project selection is required for document preview.
- [ ] No `.kicad_pro` is required for standalone schematic/PCB preview.
- [ ] Source files remain unchanged.
- [ ] Changed documents can be refreshed.
- [ ] Renderer resources are released on close.
- [ ] Invalid documents produce useful in-document errors.
- [ ] Preview works without external network access.

### 14.3 Workspace behavior

- [ ] Multiple projects can coexist in one workspace.
- [ ] Multiple boards can coexist in one project/workspace.
- [ ] Loose artifacts can be opened independently.
- [ ] Unrelated files are not treated as members of a project.
- [ ] Project discovery is not required for simple preview.
- [ ] No global selected-project state is introduced.

### 14.4 Fabrication preparation

- [ ] Agent can discover candidate projects.
- [ ] Agent asks the user when project/board selection is ambiguous.
- [ ] Agent retains the exact selected project/board identity.
- [ ] KiCad CLI executable and version are resolved correctly.
- [ ] Agent exports the required Gerber/drill files.
- [ ] Agent generates or obtains the required BOM.
- [ ] Additional required manufacturing files are generated.
- [ ] Missing manufacturing metadata is reported instead of invented.
- [ ] Generated files are validated before submission.
- [ ] Stale or unrelated outputs are not submitted.
- [ ] Export failures are returned as structured errors.

### 14.5 Huaqiu ordering

- [ ] No Order button or Order tab is introduced.
- [ ] Agent can invoke the existing Huaqiu quote/order tools.
- [ ] Existing backend contract is reused.
- [ ] Returned ordering URL opens in a new DSH MDI tab.
- [ ] The system default browser is not opened by this workflow.
- [ ] Huaqiu page authentication/session behavior works.
- [ ] MDI tab can be closed normally.
- [ ] Invalid URL or page-load failures are reported to the agent.
- [ ] Opening the page is not represented as a completed purchase.
- [ ] Existing Huaqiu confirmation/payment flow remains authoritative.

### 14.6 Packaging

- [ ] Windows x64 packaged build includes all renderer dependencies.
- [ ] No development-only local package links remain.
- [ ] No runtime CDN dependencies exist.
- [ ] No HQ Edge runtime dependency is introduced.
- [ ] No additional daemon or Python runtime is required.
- [ ] Existing Huaqiu DSH Desktop behavior remains intact.

---

## 15. Required test coverage

### Document MDI

- Open supported documents from explorer.
- Open supported documents from agent responses.
- Open the same document twice.
- Open multiple documents of different types.
- Switch between tabs during asynchronous loading.
- Close a document while rendering is in progress.
- Modify a document and refresh it.
- Open an unsupported or malformed document.
- Verify existing document renderers.

### Schematic

- Standalone schematic.
- Project-root schematic.
- Schematic with child sheets.
- Schematic with missing child sheet.
- Schematic with unrelated sibling `.kicad_sch` files.
- Large schematic.
- Invalid schematic.

### PCB

- Standalone PCB.
- Project-owned PCB.
- Multiple boards in one workspace.
- Large PCB.
- Invalid PCB.
- Source modification during preview.

### STEP/STP

- Small valid STEP.
- Larger mechanical STEP.
- STP extension.
- Invalid STEP/STP.
- Unsupported geometry.
- Conversion timeout/failure, if host conversion is used.
- Source change invalidating the cache.

### Fabrication

- One project with one board.
- One project with multiple boards.
- Multiple projects in one workspace.
- Loose PCB without project metadata.
- Missing KiCad CLI.
- Invalid PCB.
- Export timeout.
- Missing Gerber output.
- Missing drill output.
- Missing BOM data.
- DNP components.
- Missing MPN.
- Backend unavailable.
- Backend rejection.
- Invalid returned ordering URL.

### MDI ordering page

- Open returned Huaqiu URL in a new MDI tab.
- Verify it does not open the system browser.
- Verify redirects and session cookies.
- Verify external links follow DSH policy.
- Verify MDI tab close behavior.
- Verify page-load failure reporting.

---

## 16. Deliverables

The implementation agent must provide:

1. Source changes in the relevant repositories.
2. A concise architecture and source-file change report.
3. Updated package dependency declarations and lockfiles.
4. Updated DSH renderer registration/integration.
5. Schematic and PCB MDI renderers.
6. STEP/STP MDI renderer and any required conversion implementation.
7. Agent-facing workspace/project/fabrication capabilities.
8. KiCad CLI export and fabrication package validation.
9. Integration with the existing Huaqiu quote/order tools.
10. Huaqiu ordering page opening inside the existing MDI.
11. Automated tests for the acceptance criteria.
12. Windows x64 packaged build verification.
13. A list of known limitations and any acceptance criteria not met.

For each DSH modification, identify why the existing plugin extension mechanism was insufficient and why the chosen change is the smallest reusable solution.

For each new dependency, record its exact version, runtime footprint, offline behavior and Windows x64 compatibility.

---

## 17. Non-goals and prohibitions

Do not:

- Reintroduce the old fixed Hardware Engineering navigation.
- Add a dedicated project selector or global project store.
- Add an Order button, Order tab or order wizard.
- Build a new order backend or pricing engine.
- Open the Huaqiu ordering URL in the system default browser.
- Build a custom Huaqiu checkout page.
- Duplicate the existing PCB viewer.
- Implement a new KiCad S-expression parser.
- Implement a second 2D ECAD rendering foundation.
- Introduce a new universal ECAD IR.
- Embed KiCad or SolidCraft.
- Add live KiCad IPC synchronization.
- Add a daemon or HQ Edge runtime dependency.
- Require a `.kicad_pro` for standalone document preview.
- Assume every sibling schematic or PCB belongs to the same project.
- Modify source files during preview or export.
- Introduce CDN/runtime network dependencies.
- Make license compatibility an implementation gate.

---

## 18. Final implementation principle

The finished experience should feel like DSH naturally understands hardware design documents.

A user can open a KiCad schematic, PCB or mechanical model just like opening any other workspace document. The graphical preview appears in the existing MDI, while the agent remains responsible for understanding project relationships and performing hardware-domain operations.

Fabrication ordering is a conversation, not a navigation destination:

**The agent identifies the project → asks when necessary → exports and validates the manufacturing package with KiCad CLI → invokes the existing Huaqiu backend → opens the returned Huaqiu ordering page in a new MDI tab.**

The native KiCad files remain authoritative. The existing DSH document MDI remains the document surface. The existing Huaqiu order page remains the checkout surface. Hardware Engineering connects these capabilities without introducing another application shell.

## Discussions

Q: While @huaqiu/hardware-artifacts is buggy and dsh already provide test fighting file exploer ability , how about completely drop it and reuse dsh's one?

A: I agree. **I would drop&#x20;**`@huaqiu/hardware-artifacts`**&#x20;entirely and use DSH's existing workspace/file-explorer infrastructure as the single source of truth for file access and discovery.**

Given that DSH already provides filesystem and file-explorer capabilities, maintaining another artifact registry, project manifest, discovery mechanism and file-access layer is unnecessary. It also creates exactly the kind of duplicated state and inconsistent behavior we want to avoid.

There is one important distinction: reuse DSH's filesystem infrastructure, but keep Hardware Engineering's domain-specific interpretation and operations.

## **Revised ownership**

| Responsibility                                  | Owner                            |
| ----------------------------------------------- | -------------------------------- |
| Workspace roots and file discovery              | DSH                              |
| File explorer and navigation                    | DSH                              |
| File identity and access authorization          | DSH                              |
| File reads and writes                           | DSH filesystem APIs              |
| Document opening and MDI tabs                   | DSH                              |
| Document renderer lifecycle                     | DSH                              |
| KiCad project/board relationship interpretation | Hardware Engineering             |
| Schematic/PCB parsing and rendering             | `ecad-viewer` packages           |
| STEP/STP conversion and rendering               | Hardware Engineering integration |
| KiCad CLI export orchestration                  | Hardware Engineering tools       |
| BOM interpretation and fabrication preparation  | Hardware Engineering tools       |
| Huaqiu quote/order integration                  | Existing Huaqiu tools/backend    |

In other words:

- DSH owns *where files are and how they are accessed*.
- Hardware Engineering understands *what those files mean and what operations can be performed on them*.

## **What to remove**

Completely remove `@huaqiu/hardware-artifacts` if its functionality is limited to the following responsibilities:

- Workspace artifact discovery.
- `.hardware-engineering.json` project/artifact registry.
- Project and board selection state.
- Artifact path resolution.
- Filesystem reads and writes.
- Artifact HTTP serving.
- Preview-specific file registries.
- Artifact lifecycle management.

Do not retain it as a thin compatibility package merely to preserve its name.

Also remove dependencies on its manifest and registry from the bundle and other plugins.

## **What to implement instead**

### **1. Use DSH filesystem APIs directly**

Use the actual current DSH APIs for:

- Listing workspace files.
- Reading file content.
- Resolving workspace-relative paths.
- Checking file existence and metadata.
- Creating controlled output directories.
- Writing generated files.
- Watching or refreshing changed documents, if supported.

Do not build another filesystem abstraction unless a concrete missing capability requires one.

### **2. Make project discovery a domain-level operation**

Hardware Engineering can implement project inspection over DSH's filesystem API.

For example, the agent can discover:

```
workspace/
├── amplifier/
│   ├── amplifier.kicad_pro
│   ├── amplifier.kicad_sch
│   ├── amplifier.kicad_pcb
│   └── ...
├── power-supply/
│   ├── power-supply.kicad_pro
│   ├── power-supply.kicad_pcb
│   └── ...
└── generated/
    ├── enclosure.step
    └── prototype.kicad_pcb
```

It can identify projects, boards and relationships using KiCad's actual file/project semantics.

No global project registry is needed. No manifest is mandatory. A project can be inferred when an operation requires it, while individual documents remain independently previewable.

### **3. Preview directly from DSH documents**

The ECAD renderer should receive content through the existing DSH document-loading mechanism.

Avoid introducing another HTTP server or localhost artifact route simply to get files into the renderer.

If the renderer needs a referenced child schematic or an associated asset, resolve it through DSH's authorized filesystem APIs.

### **4. Fabrication output stays in the workspace**

For order preparation, the agent should:

1. Identify the selected project and board.
2. Create a controlled output directory within the workspace or another DSH-authorized location.
3. Invoke `kicad-cli`.
4. Generate Gerbers, drill files, BOM and other required inputs.
5. Validate the package.
6. Invoke the existing Huaqiu backend.
7. Open the returned ordering page in a new MDI tab.

No artifact registry is needed to track these outputs.

## **Important implementation boundary**

I would not replace `@huaqiu/hardware-artifacts` with another package called `hardware-workspace`, `hardware-project-manager` or similar.

That would just recreate the same architecture under another name.

Keep the domain-specific logic inside the existing Hardware Engineering tools/plugin where it belongs. Extract a reusable module only if there is a demonstrated need.

## **Changes to the implementation specification**

The previous specification should be amended as follows:

| Previous design                                             | Revised design                             |
| ----------------------------------------------------------- | ------------------------------------------ |
| `@huaqiu/hardware-artifacts` host capability                | Remove                                     |
| Hardware artifact registry                                  | Remove                                     |
| `.hardware-engineering.json` as project metadata dependency | Remove                                     |
| Custom artifact filesystem access                           | Use DSH APIs                               |
| Custom preview HTTP routes                                  | Use DSH document-loading APIs              |
| Custom artifact identity                                    | Use DSH document/workspace identity        |
| Custom artifact discovery                                   | Use DSH file explorer/filesystem           |
| Hardware-specific project discovery                         | Retain as domain logic over DSH filesystem |
| Fabrication staging                                         | Controlled workspace output directory      |

**One caveat:** before deleting the package, audit every current consumer. If it contains functionality beyond filesystem/discovery—particularly any existing capability that cannot be reproduced through DSH APIs—migrate that functionality to its proper owner first. Do not accidentally remove an unrelated capability along with the artifact registry.

My recommendation is to make this a hard architectural decision for the implementation: **DSH filesystem and document infrastructure are authoritative; Hardware Engineering must not maintain a parallel workspace/artifact infrastructure.**

# DSH MDI ECAD Document Rendering — Source Audit and Integration Feasibility Specification

**Date:** 2026-11-25  
**Priority:** P0  
**Status:** Research and feasibility audit; no implementation source modifications  
**Objective:** Determine the smallest viable integration to render KiCad schematic, PCB and STEP/STP documents graphically inside DSH's existing document MDI, without modifying the DSH shell or imposing a Hardware Engineering project-navigation model.

---

## 1. Background and revised direction

The initial Hardware Engineering artifact-viewer POC followed a Backplane-inspired approach:

- Fixed engineering destinations.
- Product-owned project and board selection.
- Dedicated Hardware Engineering viewer navigation.
- A separate right-panel viewer integration.

This approach is no longer the target.

The latest evaluation identifies several reasons to adopt a document-centric architecture instead:

1. Hardware engineers may work in workspaces containing dozens of projects and loose files, including unrelated designs, generated artifacts and other engineering resources.
2. DSH is undergoing rapid development. Heavy modifications to the DSH shell or its right-panel architecture create unnecessary maintenance burden and compatibility risks.
3. DSH already supports document-oriented MDI tabs in the right panel. Markdown, code, images and other document previews are opened from both the file explorer and agent responses.
4. The workspace and agent should not be constrained by a product-specific project selector or fixed engineering destinations. Adopt the document-oriented interaction model familiar from Codex.
5. Generating schematic, PCB and STEP artifacts does not inherently require a complete KiCad project.
6. Fabrication and PCBA order submission may require additional project-derived inputs, such as BOM, Gerber and board-specific information. Those workflows should remain separate from document preview.
7. Existing Huaqiu ECAD rendering packages can potentially provide graphical schematic and PCB rendering, while STEP/STP rendering may be achievable through an existing converter and a lightweight Three.js viewer.

The target is to extend the existing DSH document preview capability, not to introduce another application shell.

## 2. Target architecture

### 2.1 Workspace-first interaction

The workspace remains unrestricted.

The user and agent may:

- Create files.
- Modify files.
- Generate schematics.
- Generate PCB designs.
- Generate mechanical enclosure models.
- Generate source code, Markdown, images and other artifacts.
- Open any supported file directly.

No Hardware Engineering-specific project selection is required merely to open or preview a document.

### 2.2 Existing DSH MDI as the viewer host

Use the existing DSH right-panel MDI document preview system.

Extend its rendering capabilities so that ECAD artifacts receive graphical previews through the existing document-opening lifecycle.

The target is:

- One document identity system.
- One document-opening mechanism.
- One MDI tab system.
- One document preview lifecycle.
- Existing renderers preserved.
- New ECAD renderers integrated into the existing renderer dispatch.

Do not create a second viewer tab system or another right-panel architecture.

### 2.3 Rendering targets

| Format | Target preview |
|---|---|
| `.md` | Existing Markdown renderer |
| Source code | Existing code renderer |
| `.png`, `.jpg`, `.jpeg` | Existing image renderer |
| `.kicad_sch` | Graphical schematic renderer |
| `.kicad_pcb` | Graphical PCB renderer |
| `.step`, `.stp` | Interactive 3D mechanical renderer |

Investigate additional existing document formats and preserve their current behavior. This table defines the initial ECAD scope, not an exhaustive document-format policy.

## 3. Repository baselines

Inspect the actual local source trees:

| Repository | Location | Purpose |
|---|---|---|
| DSH | `/Users/admin/code/deepseek-harness` | MDI implementation and shell extension contracts |
| Huaqiu DSH plugins | `/Users/admin/code/dsh-pcb-eda` | Product and renderer integration |
| ECAD viewer | `/Users/admin/code/ecad-viewer` | Existing schematic/PCB parsing and rendering |
| KiCad | `/Users/admin/code/kicad` | CLI, file formats and fabrication workflow reference |
| Existing converter/viewer candidates | Identify from actual local sources | STEP/STP conversion and rendering |

Inspect the actual current working trees, HEADs, dirty state and relevant changes before drawing conclusions.

The audit must not assume the previous POC implementation is still present. The right-panel modifications in the DSH shell that attempted to imitate Backplane's viewer layout have already been reverted.

Preserve unrelated work.

## 4. Audit A — DSH document MDI architecture

This is the most important audit.

### 4.1 Document opening paths

Trace both existing opening paths end to end:

**File explorer path**

- User clicks a document in the workspace explorer.
- File metadata and content are obtained.
- Document type is identified.
- MDI tab is created, selected or reused.
- Preview renderer is selected.
- Document is mounted.
- Lifecycle and cleanup are managed.

**Agent-response path**

- Agent produces a document/file reference in a response.
- The response UI exposes the document-open action.
- The click triggers the existing document-opening service.
- The MDI tab is created, selected or reused.
- Preview renderer is selected.
- Document is mounted.
- Lifecycle and cleanup are managed.

Identify the exact source functions, services, contracts and components for both paths.

Determine whether the two paths already converge on the same document-opening service.

### 4.2 Document identity and tab semantics

Determine:

- What constitutes document identity?
- Is identity based on canonical file path, document URL, workspace identity, content identity or another key?
- How does DSH deduplicate or reuse tabs?
- Can multiple documents be open concurrently?
- How are tab titles and labels resolved?
- How does the MDI handle tab switching?
- How does the MDI handle document refresh?
- How does it handle file modification?
- What happens when a document is deleted or becomes inaccessible?
- What happens when the workspace changes?
- Can an extension request opening a document without creating a new agent turn?

Do not introduce a Hardware Engineering-specific identity contract if the existing document identity mechanism already handles these concerns.

### 4.3 Renderer dispatch

Inspect the actual renderer selection mechanism.

Determine:

- Whether dispatch is extension-based.
- Whether dispatch is MIME-based.
- Whether dispatch is based on document metadata.
- Whether dispatch is hardcoded in the MDI component.
- Whether renderers are registered through a plugin service or registry.
- Whether renderer registration is dynamic.
- Whether a plugin can register a renderer for `.kicad_sch`, `.kicad_pcb`, `.step` and `.stp`.
- Whether a renderer can replace the default text-preview behavior for selected extensions.
- Whether renderer priorities, ownership or collision rules exist.
- Whether registration and disposal follow the DSH plugin lifecycle.

Provide the actual source path, symbol and line reference for each relevant mechanism.

### 4.4 MDI lifecycle

Trace:

- Mount.
- Document load.
- Render.
- Tab switching.
- Hide/show.
- Session switching.
- Refresh.
- Content replacement.
- Unmount.
- Plugin unload.

Determine how the renderer receives document content and metadata.

Determine whether the preview host supports:

- A container element.
- Asynchronous rendering.
- Loading states.
- Error states.
- Resource cleanup.
- Renderer disposal.
- Document revision changes.
- Cancellation of pending asynchronous operations.

Do not assume that the document preview slot and tab registry are equivalent to a renderer extension point. Confirm the actual dispatch mechanism.

### 4.5 Existing document renderer inventory

Inspect the actual implementations for:

- Markdown.
- Code/text.
- Images, including PNG and JPEG.
- Other existing supported document formats.
- Any existing HTML, PDF or media previews where relevant.

For each renderer, document:

| Item | Required evidence |
|---|---|
| Renderer implementation | Source path and component/function |
| Document type dispatch | Source path and mechanism |
| Content loading | Source path and mechanism |
| Container/layout | Actual mount behavior |
| MDI integration | Actual opening path |
| Lifecycle | Mount/dispose/refresh behavior |
| Plugin boundary | Whether externally extensible |

The purpose is to reuse the existing MDI architecture, not to rewrite its renderers.

## 5. Audit B — Extension feasibility without DSH shell changes

Determine whether ECAD renderer integration can be accomplished through existing DSH plugin APIs.

Investigate the actual contracts, including where relevant:

- `ctx.documentPreviews`.
- `sidebarRightTabs`.
- `sidebar.right.tab.document.actions`.
- `sidebar.right.tab.document.unpreviewable`.
- `sidebar.right.pane.tab`.
- `ctx.slots`.
- Existing document-opening services.
- Existing workspace file access services.
- Existing MDI document state or tab state.

Do not assume all listed APIs are relevant or that their existence proves renderer registration is possible.

Identify the exact renderer extension point.

If an existing extension point allows registering document renderers, demonstrate its contract from source.

If the renderer dispatch is not extensible:

1. Identify the smallest necessary change.
2. Determine whether it belongs in a reusable DSH document-preview package rather than the shell.
3. Assess whether it can be delivered through the Huaqiu fork with minimal change.
4. Quantify the maintenance burden.
5. Avoid modifying unrelated MDI behavior.

The default architectural preference is:

**Extend the existing document-preview mechanism through a plugin or narrowly scoped reusable extension point. Do not redesign DSH's right panel.**

## 6. Audit C — Schematic rendering

Evaluate the existing Huaqiu ECAD renderer foundation.

### 6.1 Existing packages

Inspect:

- `@huaqiu/kicad-sexpr-parser`
- `@huaqiu/ecad-renderer`

Reported versions:

- Parser: `0.1.1`
- Renderer: `0.2.4`

Confirm the current local source and package versions.

Inspect:

- `SchematicParser.parse(text)`.
- `parseLibSymbols(text)`.
- `renderSchematic`.
- Renderer options and result types.
- Container mounting behavior.
- Canvas/WebGL behavior.
- Renderer disposal.
- ESM packaging.
- Bundling requirements.
- CJK glyph handling.
- Existing offline rendering dependencies.

### 6.2 Document rendering contract

Determine the smallest adapter necessary to render an individual `.kicad_sch` document inside an existing DSH MDI tab.

The preview must not require:

- `.kicad_pro`.
- Project selection.
- PCB selection.
- BOM generation.
- KiCad IPC.
- `kipy`.
- Native KiCad embedding.

A schematic file should be independently previewable.

### 6.3 Hierarchical schematic behavior

Investigate the actual parser and renderer limitations regarding:

- Root schematic.
- Child sheet references.
- Sheet instances.
- UUIDs.
- Symbol instances.
- Multi-unit symbols.
- Project path metadata.
- External library symbols.

For the initial implementation, independent file preview is the priority.

Do not require the renderer to reconstruct an entire project hierarchy before it can preview a single file.

If child sheets are referenced but not available or resolved, the preview should still render the selected file as far as the existing renderer supports, with explicit limitations.

Do not silently substitute another schematic.

### 6.4 Result

Provide:

- Reusable APIs.
- Exact dependency versions.
- Required bundled dependencies.
- Smallest MDI renderer adapter.
- Lifecycle requirements.
- Limitations.
- Test requirements.

Do not reimplement the parser or renderer.

## 7. Audit D — PCB rendering

Evaluate the same foundation for `.kicad_pcb`.

### 7.1 Existing APIs

Inspect:

- `BoardParser.parse(text)`.
- `renderPcb`.
- Renderer options.
- Canvas mounting.
- Resource lifecycle.
- Bundling.
- Rendering compatibility.

### 7.2 Independent PCB preview

The preview must work from an individual saved `.kicad_pcb`.

It must not require:

- A `.kicad_pro`.
- A schematic.
- BOM.
- Project discovery.
- IPC.
- `kipy`.
- Native application embedding.

The PCB preview must use the exact selected source document.

### 7.3 Existing PCB viewer

Inspect the existing:

`@huaqiu/dsh-tool-pcb-viewer`

Determine whether it is relevant to the document MDI renderer or should remain entirely separate.

The preferred direction is to use `@huaqiu/ecad-renderer` for the MDI PCB rendering path and preserve the existing PCB viewer plugin unchanged.

Do not rehost its panel or duplicate its implementation.

### 7.4 Result

Provide:

- Reusable APIs.
- Exact dependencies.
- MDI integration contract.
- Renderer lifecycle.
- Limitations.
- Test requirements.

## 8. Audit E — STEP/STP rendering and conversion

The mechanical 3D preview is a significant feasibility question.

Investigate the smallest practical solution for rendering `.step` and `.stp` files in DSH's existing document MDI.

### 8.1 Existing local capabilities

Search the existing Huaqiu source trees and installed/referenced packages for:

- STEP/STP converters.
- STEP parsers.
- OpenCascade bindings.
- WebAssembly OpenCascade.
- CAD-to-mesh conversion tools.
- GLB conversion.
- Three.js loaders.
- Existing mechanical preview implementations.
- FreeCAD integration.
- Existing conversion helpers used by ECAD or mechanical workflows.

Inspect the existing ecad-viewer source where relevant, but do not assume its application-specific 3D shell is reusable.

Determine whether an existing conversion or rendering package can be reused without introducing a heavyweight native runtime or additional service.

### 8.2 Candidate solutions

Evaluate the candidates based on actual source and package availability, not marketing descriptions.

Potential approaches include:

- Existing packaged STEP-to-GLB converter.
- OpenCascade-based conversion.
- WebAssembly CAD conversion.
- Existing local FreeCAD-based conversion capability, if it can be reused without introducing an unnecessary integration.
- A browser-side STEP parser/converter.
- Conversion to GLB followed by Three.js rendering.

Do not commit to a particular library before examining the available source and runtime constraints.

### 8.3 Conversion requirements

If conversion is required, establish:

- Whether conversion can run offline.
- Whether conversion is client-side or host-side.
- Whether a native runtime is required.
- Whether conversion output can be cached.
- Whether conversion is safe for large files.
- Whether conversion can be cancelled.
- Whether conversion has a bounded timeout.
- Whether conversion is practical on Windows x64.
- Whether conversion can run without a separate daemon.
- Whether conversion can be packaged with DSH.
- Whether the converter introduces unacceptable licensing or distribution constraints.

### 8.4 Three.js rendering

If the target format is GLB, evaluate the smallest Three.js viewer component.

The viewer must:

- Mount in the MDI container.
- Render the generated GLB.
- Support basic orbit, zoom and pan as appropriate.
- Dispose scene, renderer, controls and loaded resources on unmount.
- Handle tab switching.
- Reject stale asynchronous loading results.
- Avoid remote CDN dependencies.

### 8.5 Individual mechanical files

Opening a STEP/STP file should not require:

- KiCad project discovery.
- PCB selection.
- BOM.
- SolidCraft installation.
- Native mechanical application embedding.

The selected file should be independently previewable if the converter supports it.

### 8.6 Result

Provide a ranked recommendation:

1. Best reusable solution already present in the local source/package ecosystem.
2. Minimal viable alternative.
3. Fallback if no existing solution is practical.

Include actual package names, source references, dependency footprint, conversion architecture, license considerations and limitations.

Do not build a new converter during this audit.

## 9. Audit F — Workspace and artifact semantics

The initial POC project-selection architecture is no longer approved as the general artifact-preview model.

Audit the current implementation for assumptions that previewing a document requires:

- A canonical Hardware Engineering project.
- A `.kicad_pro`.
- Project discovery.
- Selected board.
- Selected root schematic.
- Selected mechanical model.
- A product-specific project store.
- A fixed engineering destination.
- A Hardware Engineering manifest.

Determine which assumptions are required for specific fabrication operations and which were introduced solely for the initial viewer architecture.

### 9.1 Desired document model

For document preview:

- The user selects a file.
- The MDI opens the exact file.
- The renderer operates on that file.
- No project is selected unless the document operation genuinely requires one.

For generated artifacts:

- The agent creates a file.
- The file can be opened immediately.
- The preview does not require the agent to create a complete project.

For multiple files:

- The workspace may contain many unrelated designs.
- The MDI may contain many simultaneously open artifacts.
- Document selection must not implicitly switch a Hardware Engineering project context.

### 9.2 Existing project discovery

Do not delete or break project discovery functionality unnecessarily.

Determine whether it remains useful for specific operations such as:

- BOM extraction.
- Gerber generation.
- Fabrication quoting.
- PCBA quoting.
- Native project-level operations.

Project discovery may remain as a helper for these operations but must not be a prerequisite for general document rendering.

## 10. Audit G — Fabrication and order workflows

The POC must distinguish document rendering from actual PCB fabrication.

### 10.1 Standalone artifacts

An agent may generate:

- A standalone schematic.
- A standalone PCB.
- A standalone STEP enclosure.

These files should be previewable directly.

### 10.2 Fabrication operations

Inspect the existing Huaqiu quote/order tools and KiCad reference implementation.

Determine the actual requirements for:

- PCB fabrication quote.
- PCB order placement.
- PCBA quote.
- PCBA order placement.
- BOM extraction.
- Gerber generation.
- Board dimensions and layer information.
- Assembly inputs.
- Project context.

Identify the minimum required inputs for each operation.

Do not assume that every order operation requires a complete KiCad project if the actual service accepts standalone files.

Conversely, do not claim that a standalone PCB is sufficient for PCBA or fabrication if the actual implementation requires additional data.

### 10.3 Existing Huaqiu tools

Preserve and reuse:

- `quote_pcb`
- `quote_smt`
- `place_pcb_order`
- `place_smt_order`

Preserve the existing backend and transport behavior.

Do not introduce a new quote backend.

Do not make quote/order backend availability a document-preview activation requirement.

### 10.4 Order UI

No fixed Order Placing destination is required for this revised POC.

Determine whether the existing tools, agent workflow and file context are sufficient to make ordering discoverable without introducing a dedicated product tab.

If a contextual entry point is useful, recommend the smallest integration.

The UI must not submit an order automatically.

## 11. Audit H — Existing POC implementation delta

Inspect the current POC work in:

- `@huaqiu/hardware-artifacts`
- `@huaqiu/dsh-hardware-ui`
- `@huaqiu/hardware-engineering`

Identify code that should be:

- Reused.
- Modified.
- Removed.
- Deferred.

Specifically assess:

- Fixed five-destination navigation.
- Product-owned project/board selection.
- Dedicated right-panel viewer registration.
- `conversation.header.leading`.
- Product-specific viewer tab.
- Hardware Engineering manifest.
- Project discovery and ranking.
- Artifact selection store.
- Canonical artifact identity.
- Raw-content routes.
- GLB export routes.
- Schematic rendering adapter.
- PCB rendering adapter.
- BOM table.
- Native-open action.
- Settings page.
- Agent environment context.
- Quote/order entry points.

The revised architecture must not retain redundant product navigation and project-selection state merely because it was implemented in the earlier POC.

Do not blindly delete reusable host capabilities or settings.

Classify each item:

| Classification | Meaning |
|---|---|
| Reuse | Still directly useful in the revised MDI architecture |
| Adapt | Reusable with a changed contract or ownership |
| Remove | Redundant or incompatible with the revised direction |
| Defer | Useful but not required for this POC |

Provide source evidence for each decision.

## 12. Target integration proposal

Based on the source audit, propose the smallest implementation.

The expected direction, subject to source verification, is:

### 12.1 Document renderer registration

Register ECAD renderer capabilities through the existing DSH document-preview extension mechanism.

The renderer should be selected by the document type/extension and receive the existing document identity and content contract.

Do not create a second MDI tab or document-opening service.

### 12.2 Schematic renderer

Use:

- `@huaqiu/kicad-sexpr-parser`
- `@huaqiu/ecad-renderer`

Render the selected `.kicad_sch` inside the existing document MDI container.

### 12.3 PCB renderer

Use:

- `@huaqiu/kicad-sexpr-parser`
- `@huaqiu/ecad-renderer`

Render the selected `.kicad_pcb` inside the existing document MDI container.

### 12.4 STEP renderer

Use the most practical existing converter found during the audit.

Preferred target:

- STEP/STP source.
- Local conversion to GLB or another supported mesh format if necessary.
- Three.js rendering inside the existing MDI document container.

The conversion must not require a separate daemon or native application embedding.

### 12.5 Existing document behavior

Preserve:

- Markdown preview.
- Code preview.
- Image preview.
- Existing document tabs.
- File explorer opening behavior.
- Agent-response document opening behavior.
- Tab reuse/deduplication.
- Existing DSH right-panel MDI lifecycle.

ECAD renderer registration must not break or shadow unrelated document renderers.

## 13. Required source evidence

The report must include:

- Repository and commit.
- Working-tree state.
- Exact source paths.
- Function/component/service names.
- Relevant line ranges.
- Existing extension contracts.
- Renderer lifecycle.
- Dependency names and versions.
- Verified test evidence where available.

Use a source evidence matrix:

| Claim | Repository | Source path | Symbol/line | Evidence | Confidence |
|---|---|---|---|---|---|

Do not make claims based on an older snapshot when the gate-owned source tree is available.

Do not infer that a feature exists from a package name alone.

Do not use an architecture diagram as a substitute for source evidence.

## 14. Required deliverables

### D1 — Executive conclusion

Answer:

- Can ECAD renderers integrate into existing DSH document MDI without modifying the shell?
- What exact extension point is required?
- What is the smallest implementation?
- What are the blockers?

### D2 — DSH MDI source map

Document:

- File explorer document-opening path.
- Agent-response document-opening path.
- Document identity.
- Tab creation/reuse.
- Renderer dispatch.
- MDI lifecycle.
- Plugin extension contracts.

### D3 — Existing renderer inventory

Provide source-proven inventory for Markdown, code, PNG/JPG and other relevant formats.

### D4 — ECAD rendering feasibility

Document schematic and PCB rendering APIs, dependencies, adapter and lifecycle.

### D5 — STEP/STP feasibility

Provide a source-proven ranked recommendation for conversion and rendering.

### D6 — Workspace model

Document how standalone artifacts are previewed without project discovery and which existing project-related capabilities remain necessary for fabrication.

### D7 — Order workflow boundary

Document the actual required inputs for PCB and PCBA quoting/ordering and how existing tools should be reused.

### D8 — POC code delta

Provide a package-by-package classification of reuse, adapt, remove and defer.

### D9 — Minimal implementation specification

Provide the actual implementation-ready coding task, based on the audit findings.

### D10 — Test and acceptance plan

Provide a test matrix for MDI renderer registration, document opening, renderer lifecycle, ECAD previews, STEP conversion, existing document compatibility and offline packaging.

## 15. Acceptance criteria for the audit

The audit is complete only when:

- The existing DSH document-opening lifecycle is fully traced.
- Explorer and agent-response opening paths are understood.
- Existing MDI renderer dispatch and lifecycle are source-proven.
- The exact external renderer extension point is identified or its absence is demonstrated.
- Markdown, code and image preview behavior is documented.
- Schematic rendering feasibility is source-proven.
- PCB rendering feasibility is source-proven.
- STEP/STP conversion and rendering are investigated using actual source/package evidence.
- Standalone document preview is distinguished from project-level fabrication operations.
- Existing quote/order requirements are verified.
- Redundant initial POC project/navigation logic is identified.
- The proposed implementation minimizes DSH shell changes.
- No source modifications are made during this audit.
- An implementation-ready coding specification is produced.

## 16. Explicitly prohibited during the audit

Do not:

- Modify DSH source.
- Implement renderer adapters.
- Introduce new renderer dependencies.
- Modify the DSH right-panel shell.
- Introduce a new Hardware Engineering navigation bar.
- Introduce fixed Schematic/PCB/BOM/3D CAD/Order destinations.
- Require explicit project selection to preview a document.
- Recreate the DSH MDI.
- Rehost the existing PCB viewer.
- Implement a new STEP converter.
- Implement a new quote backend.
- Introduce HQ Edge as a runtime dependency.
- Introduce a daemon or supervisor.
- Embed KiCad or SolidCraft.
- Implement live IPC.
- Create a shadow project database.
- Introduce a universal Project IR.

## 17. Final decision principle

**Hardware Engineering should enhance DSH's existing document-oriented workspace, not turn DSH into a fixed hardware-specific application shell.**

The workspace and agent remain free to create, inspect and manipulate engineering files.

The MDI becomes capable of rendering supported ECAD artifacts graphically.

Project discovery, BOM, Gerber, quoting and fabrication remain specialized operations that may require additional context, but they must not restrict general document access or preview.

The implementation should reuse DSH's document-opening behavior, Huaqiu's existing ECAD rendering foundation, and existing fabrication tools while minimizing changes to DSH itself.
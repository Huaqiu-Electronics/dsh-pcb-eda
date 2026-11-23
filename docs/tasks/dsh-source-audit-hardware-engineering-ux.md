# DSH Source Code Audit — Hardware Engineering UX Integration

**Priority:** P0  
**Type:** Source-code audit / implementation feasibility  
**Scope:** `deepseek-harness` DSH fork, `dsh-pcb-eda` plugin monorepo  
**Objective:** Determine the minimum source-code changes required to deliver the approved Hardware Engineering UX inside the existing DSH Desktop application.

---

## 1. Background and UX Decision

The product is **HuaQiu Hardware Engineering**, delivered through the existing DSH Agent Harness.

The target UX retains DSH's familiar three-panel interaction model:

1. **Top area:** HuaQiu product identity, current project path, engineering navigation, and contextual native-application action.
2. **Left sidebar:** Existing DSH session navigation, tools, workspaces, user profile, and settings.
3. **Center panel:** Existing DSH agent conversation and input.
4. **Right panel:** Interactive engineering artifact viewer.

The top engineering navigation must expose these destinations persistently:

- Schematic
- PCB
- DFM
- BOM
- 3D CAD
- Order Placing

The active destination controls the artifact displayed in the right viewer. The user must be able to switch destinations without asking the agent to perform navigation.

The top-right contextual action should be explicit:

- Open in KiCad
- Open in SolidCraft, where applicable

The engineering navigation is part of the Hardware Engineering product experience, not six independent plugin UI registrations.

### UX principles

- Users must immediately recognize what the product can do.
- All six engineering destinations remain visible, including when their artifacts do not yet exist.
- Empty states explain what is missing and expose an obvious next action.
- Existing DSH chat and sidebar behavior should remain intact.
- The engineering viewer must be usable without an agent conversation.
- Agent-generated results should link to their corresponding engineering destinations.
- PCB fabrication and PCBA assembly must be separately discoverable within Order Placing.
- Do not introduce a separate application window, daemon, supervisor, or another runtime lifecycle.

This audit must evaluate the implementation against this exact UX rather than propose a different product navigation model.

---

## 2. Repositories and Investigation Boundaries

Inspect the actual checked-out source. Do not assume paths, APIs, component names, or extension behavior from documentation alone.

Primary repositories:

- `deepseek-harness`: DSH application, Desktop shell, client UI, extension APIs.
- `dsh-pcb-eda`: Hardware Engineering product integration and engineering plugins.

Relevant existing packages and components include, but are not limited to:

- `dsh-client-ui-sidebar-right`
- `dsh-client-ui-sidebar-documentpreview`
- `dsh-client-ui-slots`
- `dsh-client-ui-settings`
- `dsh-client-ui-settings-general`
- `dsh-client-ui-open-in-app`
- `dsh-host-open-in-app`
- `dsh-client-modules`
- `@huaqiu/hardware-engineering`
- `@huaqiu/ecad-renderer`
- `@huaqiu/kicad-sexpr-parser`
- `@huaqiu/dsh-tool-pcb-viewer`
- `@huaqiu/dsh-tool-kicad-schematic-gen`
- `@huaqiu/dsh-artifacts`

These are investigation starting points, not assumptions that every package must change.

Record the actual repository commits, package versions, and relevant source paths in the report.

---

## 3. Audit A — Top Navigation and Product Identity

Determine where the existing DSH application renders:

- Product logo and application identity.
- Project path or current workspace information.
- Top header / toolbar.
- Navigation tabs, if any.
- Header action slots and extension registration.
- Responsive layout and available horizontal space.

Answer:

1. Which component owns the top-level application header?
2. Is there an existing extension point for adding a product-owned navigation row?
3. Can the Hardware Engineering package contribute a persistent top navigation without modifying DSH core?
4. Can the navigation coexist with the existing project path and application controls?
5. How are active tabs, route state, and component lifecycle handled?
6. Can the navigation remain mounted across session changes?
7. What happens when the application has no open project?
8. What is the smallest core change if no suitable extension point exists?

Inspect the actual layout tree and component ownership. Do not assume the existing right-sidebar tab registration API can be repurposed as a top navigation API.

**Required result:** A source-proven recommendation for implementing the six persistent engineering destinations.

---

## 4. Audit B — Three-Panel Layout and Viewer Surface

Investigate the current DSH layout and the right-side document preview implementation.

Existing extension points to inspect include:

- `ctx.documentPreviews`
- `ctx.sidebarRightTabs.register(...)`
- `ctx.sidebarRight.openTab(...)`
- `sidebar.right.tab.document.actions`
- `sidebar.right.tab.document.unpreviewable`

Determine:

1. Whether the right panel can host a full interactive engineering viewer.
2. Whether it supports custom React components or only document previews.
3. Whether preview renderers can maintain their own interactive state.
4. Whether the right panel can be resized, collapsed, expanded, or switched between preview modes.
5. Whether the center chat can remain visible while the viewer is active.
6. Whether the viewer can occupy the available panel width without excessive nested scrollbars.
7. Whether a viewer can receive project/artifact selection updates without remounting unnecessarily.
8. Whether the existing document-preview architecture is appropriate for long-lived interactive CAD viewers.

Inspect the actual implementations of:

- `dsh-client-ui-sidebar-right`
- `dsh-client-ui-sidebar-documentpreview`
- Related layout and slot infrastructure.

Distinguish between:

- Existing behavior.
- Supported extension API.
- Behavior requiring a DSH core modification.

**Required result:** Establish whether the right panel is sufficient for the intended interactive viewer or whether a small targeted layout extension is necessary.

Do not replace the three-panel DSH layout with a new full-screen application shell unless source evidence proves that the existing shell cannot satisfy the UX.

---

## 5. Audit C — Product-Level Navigation and Shared Context

Determine how a single Hardware Engineering product integration can own all six destinations.

The desired conceptual model is:

```ts
type HardwareDestination =
  | "schematic"
  | "pcb"
  | "dfm"
  | "bom"
  | "3d"
  | "order";

interface HardwareWorkspaceContext {
  projectPath?: string;
  activeDestination: HardwareDestination;

  schematicPath?: string;
  sheetPath?: string;
  pcbPath?: string;
  mechanicalModelPath?: string;
}
```

This is a proposed product-level model, not a mandate to introduce a new global DSH state system.

Investigate:

1. Where the product plugin is activated and initialized.
2. How its UI components are mounted.
3. Whether multiple plugin contributions can share one product-owned React state.
4. Whether the state can survive navigation between destinations.
5. Whether the product can react to workspace/project changes.
6. Whether it can distinguish the active project from a document merely opened in a preview.
7. How multiple schematics, sheets, and PCB boards should be selected.
8. How navigation state is restored after session changes or application restart.
9. Whether DSH already provides suitable project/workspace context services.

Do not create a second mutable representation of KiCad project data.

The native project files remain authoritative. The proposed context only identifies the selected project and artifact for navigation and viewing.

**Required result:** Recommend the smallest viable ownership and state-sharing model for the Hardware Engineering UI.

---

## 6. Audit D — Viewer and Renderer Integration

Investigate the actual rendering foundations already provided by:

- `@huaqiu/ecad-renderer`
- `@huaqiu/kicad-sexpr-parser`
- `@huaqiu/dsh-tool-pcb-viewer`

The existing PCB viewer is the reference implementation. Understand its actual data flow and reuse opportunities.

### 6.1 Schematic

Determine whether the existing parser and renderer can support:

- Native `.kicad_sch` parsing.
- Hierarchical sheets.
- Symbols, pins, wires, labels, junctions, and graphical objects.
- Zoom and pan.
- Sheet navigation.
- Component and net identification.
- Selection and highlighting.

Identify any missing schematic-specific parsing or rendering capabilities.

### 6.2 PCB

Audit the existing viewer:

- Native PCB file loading.
- 2D rendering.
- 3D rendering, if already supported.
- Layer visibility.
- Zoom and pan.
- Board selection.
- Refresh and artifact replacement.
- Existing host-side file registry and HTTP delivery.
- Existing React/Three.js viewer lifecycle.

Do not duplicate or rewrite working PCB viewer functionality.

### 6.3 DFM

Determine:

- Which DFM/DRC/ERC results already exist.
- Their source, schema, and revision association.
- How the UI can present scores and individual findings.
- Whether clicking a finding can navigate to the relevant viewer and highlight the affected object.
- Whether a green score badge can be grounded in actual result data.

Do not invent a DFM score when the underlying analysis has not run.

### 6.4 BOM

Audit existing schematic analysis and BOM functionality.

Determine whether the existing implementation supports:

- Reference designators.
- Quantity and grouping.
- Value and footprint.
- Manufacturer and supplier fields.
- DNP and BOM exclusion.
- Hierarchical schematic handling.
- Pricing and inventory information.
- Navigation from a BOM row to its schematic component.

Identify the source of each field. Do not introduce a second BOM database.

### 6.5 3D CAD

Determine the existing capabilities for:

- PCB 3D viewing.
- STEP/3D model rendering.
- Mechanical enclosure files.
- SolidCraft integration.
- File resolution and preview delivery.
- Native application launch.

Clearly distinguish an existing working viewer from a future integration or unsupported capability.

**Required result:** A capability matrix covering all four artifact viewers, their rendering foundations, data inputs, interaction capabilities, and missing implementation work.

---

## 7. Audit E — Contextual Open-in-Application Actions

Inspect:

- `dsh-client-ui-open-in-app`
- `dsh-host-open-in-app`
- Existing application catalog and registration mechanisms.
- `ctx.subprocess`.
- Existing executable configuration and settings APIs.

Determine:

1. Whether the current open-in-app catalog is a fixed whitelist.
2. Whether it can support configurable KiCad and SolidCraft executable paths.
3. Whether the selected artifact can be passed to the correct application.
4. Whether application arguments and working directories can be configured safely.
5. Whether the host can report launch failures to the UI.
6. Whether the action can be selected dynamically based on the active destination.
7. Whether multiple KiCad installations need to be supported.
8. Whether executable settings can be persisted at the correct user scope.

Required contextual behavior:

| Destination | Expected action |
|---|---|
| Schematic | Open selected schematic in KiCad |
| PCB | Open selected board in KiCad |
| DFM | Open corresponding PCB in KiCad |
| BOM | Open corresponding schematic in KiCad |
| 3D CAD | Open relevant artifact in KiCad or SolidCraft |
| Order Placing | No editor launch action required |

Do not assume that the existing fixed open-in-app catalog already supports these requirements.

**Required result:** A concrete integration proposal with exact APIs, source files, and any necessary extension changes.

---

## 8. Audit F — Order Placing as a First-Class Destination

Investigate the existing:

- `@huaqiu/dsh-tool-quote`
- `quote_pcb`
- `quote_smt`
- `place_pcb_order`
- `place_smt_order`

Determine how these tools currently receive project, board, BOM, region, and manufacturing parameters.

The UI must provide two explicitly named workflows:

### PCB Fabrication

- Select the PCB artifact.
- Review fabrication inputs.
- Request a quote.
- Review pricing and options.
- Explicitly confirm and place the order.

### PCBA Assembly

- Select the PCB and associated BOM.
- Review assembly inputs and component sourcing.
- Request a quote.
- Review pricing and options.
- Explicitly confirm and place the order.

Investigate whether these workflows can reuse existing tool implementations directly or need dedicated UI-facing service APIs.

The user must not need to invoke agent commands manually to reach either workflow.

Separate quote generation from order submission. Never submit an order implicitly as a side effect of opening a page or generating a quote.

**Required result:** An implementation map for both ordering workflows, including missing UI components, input validation, and confirmation boundaries.

---

## 9. Audit G — Agent and Viewer Interoperability

The center panel remains the existing DSH conversation.

Determine how agent results can expose navigation actions into the product workspace.

Desired examples:

- View generated schematic.
- View generated PCB.
- Review DFM results.
- Open BOM.
- Inspect 3D model.
- Start PCB fabrication.
- Start PCBA assembly.

Investigate:

1. Existing tool result rendering and action mechanisms.
2. Whether tool results can invoke product-owned navigation.
3. Whether artifact IDs and paths can be passed without leaking internal implementation details.
4. Whether the viewer can react to an agent-created or modified artifact.
5. Whether navigation can occur without starting a new agent turn.
6. Whether the active viewer can be refreshed after an agent operation.

Do not create a parallel agent-to-viewer communication framework if existing DSH UI state or service mechanisms suffice.

**Required result:** A minimal, source-proven mechanism for linking agent outputs to engineering destinations.

---

## 10. Audit H — Settings and First-Launch Experience

Inspect the existing settings extension points:

- `ctx.configForms`
- `settings.section`
- `dsh-client-ui-settings`
- `dsh-client-ui-settings-general`

Determine how to expose:

- KiCad executable path.
- SolidCraft executable path.
- Any required renderer/runtime configuration.
- Project discovery defaults, if already supported.

Investigate how the product can display an informative first-launch state without requiring an existing project.

The initial experience should make these actions obvious:

- Open Project.
- New Project.
- Ask AI Hardware Engineer.

All six engineering destinations should remain visible, even when no project is loaded.

**Required result:** A source-based implementation proposal for settings and empty/first-launch states, preserving existing DSH account and settings behavior.

---

## 11. Audit I — Responsive Layout and Visual Constraints

Inspect actual DSH dimensions, layout constraints, and responsive behavior.

Evaluate:

- Available width for the top navigation.
- Project path and product branding coexistence.
- Minimum usable width of the center chat and right viewer.
- Viewer resizing and collapse behavior.
- Small window behavior.
- Long project names and tab overflow.
- Contextual action visibility.

The target UX must retain all six engineering destinations as discoverable labels.

Do not solve overflow by silently hiding engineering destinations. Recommend a clear responsive behavior based on actual source constraints.

Provide a screenshot or source-backed layout analysis if the existing application can be run.

---

## 12. Audit J — Packaging, Activation, and Lifecycle

Confirm that the proposed product UI can be integrated into the existing `@huaqiu/hardware-engineering` bundle and activated through the current DSH fork integration.

Investigate:

- Product plugin registration.
- Dependency and package boundaries.
- UI contribution lifecycle.
- Plugin activation/deactivation.
- Settings persistence.
- Application restart behavior.
- Offline startup.
- Existing version-lockstep requirements.

Do not introduce:

- HQ Edge as a new dependency.
- A separate daemon or supervisor.
- A second DSH runtime.
- Another plugin materialization/update system.
- A separate external patch repository.

All required DSH core changes should be made directly in the existing Huaqiu DSH fork.

---

## 13. Required Audit Deliverables

Produce the following report.

### A. Executive Decision

Answer directly:

- Can the proposed UX be implemented mostly through existing DSH extension points?
- Which changes require DSH core modifications?
- Is the right-side document preview sufficient for the interactive viewer?
- What is the minimum viable implementation architecture?

### B. Source Evidence Matrix

For each conclusion include:

| Field | Required information |
|---|---|
| Feature | UX capability being investigated |
| Current implementation | Actual behavior found in source |
| Source location | Repository, file, symbol, and line range |
| Extension point | Existing API or component, if applicable |
| Gap | Missing functionality |
| Proposed solution | Smallest implementation |
| Classification | Reuse / Plugin extension / DSH core change |
| Confidence | Confirmed / Partial / Unknown |

Avoid unsupported claims based on package names or README descriptions.

### C. UI Ownership Diagram

Show the actual proposed component ownership and integration points.

The diagram must make clear:

- Which components remain DSH-owned.
- Which components become Hardware Engineering-owned.
- How the product navigation controls the viewer.
- How the agent conversation remains independent.
- How the host launches native applications.

### D. Proposed Navigation and Interaction Flow

Document:

1. First application launch.
2. Opening an existing project.
3. Switching among six engineering destinations.
4. Viewing a missing artifact.
5. Navigating from an agent result to a viewer.
6. Opening the selected artifact in a native application.
7. Requesting PCB fabrication.
8. Requesting PCBA assembly.

### E. Minimal Change List

List exact source files and proposed changes, grouped into:

- Existing DSH APIs reused unchanged.
- Hardware Engineering plugin changes.
- DSH fork core changes.
- New UI components.
- New host-side services, if genuinely necessary.

For each proposed core change, explain why an existing extension point cannot satisfy the requirement.

### F. Implementation Phases

Recommend the smallest practical sequence:

- **P0 — Navigation and layout feasibility:** Prove the top engineering navigation and right viewer surface.
- **P1 — Artifact workspace:** Integrate Schematic, PCB, DFM, BOM, and 3D CAD destinations.
- **P2 — Native application actions:** Implement configurable KiCad/SolidCraft launch behavior.
- **P3 — Order Placing:** Integrate PCB and PCBA quote and confirmation workflows.
- **P4 — Agent interoperability and polish:** Add contextual navigation actions, empty states, and responsive behavior.

Adjust phase boundaries only when source evidence justifies doing so.

---

## 14. Mandatory Constraints

1. This is an audit, not an implementation task. Do not modify source files.
2. Inspect the actual current Huaqiu fork, not upstream DSH assumptions.
3. Do not invent extension APIs or assume a capability exists because a similarly named package exists.
4. Do not redesign the approved UX.
5. Preserve the existing DSH agent chat, session management, sidebar, and account behavior.
6. Reuse `@huaqiu/ecad-renderer` and `@huaqiu/kicad-sexpr-parser` where applicable.
7. Do not duplicate the existing PCB viewer.
8. Do not introduce a universal ECAD IR or shadow project database.
9. Native KiCad project files remain authoritative.
10. No native application embedding or live design-state synchronization is required for this POC.
11. Do not introduce HQ Edge, a separate daemon, or another runtime lifecycle.
12. Modify the DSH fork directly when a core change is justified.
13. Distinguish confirmed behavior from proposed behavior and unknowns.
14. Every significant technical conclusion must cite the actual source location.

---

## 15. Acceptance Criteria

The audit is complete only when:

- [ ] The exact DSH header and layout ownership are identified.
- [ ] A source-proven implementation path for the six top-level destinations is documented.
- [ ] The right-panel viewer's actual interaction and lifecycle capabilities are established.
- [ ] The existing PCB viewer integration is understood well enough to avoid duplication.
- [ ] Schematic, DFM, BOM, and 3D capabilities are individually assessed.
- [ ] Configurable native application launch feasibility is established.
- [ ] Both order workflows are mapped to existing quote/order functionality.
- [ ] Agent-to-viewer navigation feasibility is established.
- [ ] First-launch and empty-state behavior is addressed.
- [ ] All necessary DSH core changes are justified with source evidence.
- [ ] The minimal implementation sequence and exact affected files are provided.

**Final objective:** Deliver a practical, source-backed implementation blueprint for adding the HuaQiu Hardware Engineering product experience to DSH with minimal disruption to the existing harness.
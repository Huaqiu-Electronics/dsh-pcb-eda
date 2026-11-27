# PO-01 — Plugin-Owned Place Order Workflow

**Product:** Huaqiu Electronic Design Agent Platform  
**Component:** Existing Huaqiu DSH plugin that exposes manufacturing tools to the agent  
**Priority:** M1  
**Implementation owner:** Huaqiu plugin team  
**Dependencies:** Existing DSH plugin runtime, MDI view infrastructure, hqpcb.com ordering interface

## 1. Objective

Implement a user-facing Place Order workflow in the existing Huaqiu plugin.

The workflow must allow users to initiate PCB or PCBA manufacturing orders without asking the agent to perform the operation.

The existing plugin already exposes manufacturing capabilities to the agent. This implementation must reuse those capabilities and their underlying logic rather than introducing a second manufacturing implementation.

The workflow must be independently accessible through a plugin-owned MDI view and must also remain compatible with agent-initiated ordering.

## 2. Product behavior

The intended workflow is:

1. User invokes Place Order.
2. Plugin discovers valid KiCad projects in the current DSH workspace.
3. Plugin opens a project-selection view in the existing MDI infrastructure.
4. User selects a project.
5. User chooses PCB or PCBA.
6. Plugin resolves the necessary engineering artifacts.
7. Plugin opens hqpcb.com in an MDI view with the selected project context and Huaqiu authentication token.
8. hqpcb.com continues the existing quotation and order-submission workflow.

The plugin owns steps 2–7. The manufacturing quotation and submission experience remains owned by hqpcb.com and its existing backend.

## 3. Source-code audit before implementation

Before modifying the implementation, inspect the existing plugin and DSH integration to establish:

- Existing manufacturing tool registrations and handlers.
- Existing PCB and PCBA order-related capabilities.
- Existing project/file discovery utilities.
- Existing workspace-root resolution.
- Existing MDI view creation and navigation APIs.
- Existing Huaqiu token acquisition and propagation.
- Existing hqpcb.com URL construction and parameter conventions.
- Existing plugin-to-agent and plugin-to-UI communication mechanisms.

Reuse existing abstractions wherever possible.

Do not create a parallel project scanner, manufacturing service, authentication subsystem or order API simply for this UI.

Document the discovered source locations and actual invocation paths in the implementation report. Do not invent APIs based on this specification.

## 4. Project discovery

### 4.1 Discovery scope

The DSH workspace is an ordinary filesystem directory. It may contain multiple independent KiCad projects, shared resources, generated files, documentation and unrelated engineering artifacts.

Discover projects within the current workspace directory.

Do not assume:

- One DSH workspace equals one KiCad project.
- Every PCB file represents a separate project.
- Every STEP file represents an orderable product.
- The currently active MDI document represents the entire workspace.
- The project name or filename is globally unique.

Project discovery must work even when the relevant project documents are not currently open in MDI.

### 4.2 Project identification

Use KiCad project boundaries, primarily the `.kicad_pro` project file and its associated project artifacts.

Resolve associated:

- `.kicad_pcb`
- `.kicad_sch`
- BOM and component data, where available through existing plugin capabilities.

Do not indiscriminately treat arbitrary PCB files, backups, generated files or nested unrelated resources as independent projects.

Support multiple projects with identical basenames in different directories.

Use normalized project paths or another stable project identity, not the display name alone.

### 4.3 Discovery result

Each discovered project should provide sufficient information for presentation and subsequent order preparation:

- Stable project identity.
- Display name.
- Project root/path.
- Project file reference.
- Associated PCB artifact references.
- Associated schematic artifact references.
- PCB order readiness.
- PCBA order readiness.
- Capability-specific unavailable reasons.

The discovery layer should be reusable by both the new UI and existing agent-facing functionality where appropriate.

### 4.4 Readiness

Do not assume that finding a `.kicad_pro` file means the project is ready for every manufacturing operation.

PCB readiness requires a resolvable and usable PCB artifact.

PCBA readiness requires the necessary PCB, BOM and component information according to the existing manufacturing workflow.

When an operation is unavailable, explain why. Do not silently generate missing artifacts or invent manufacturing parameters.

## 5. Project-selection MDI view

Implement a plugin-owned view using the existing DSH MDI infrastructure.

The view should be a simple project selector, not a new workspace management application.

Required UI:

- Workspace identification.
- List of discovered KiCad projects.
- Project display name and useful artifact information.
- PCB and PCBA order actions.
- Clear indication of unavailable order types.
- Empty state when no eligible projects are found.
- Loading and discovery-error states.

Users should be able to select a project and proceed directly to the intended manufacturing operation.

Do not introduce a new project sidebar, project database, workspace migration or persistent project-management subsystem.

Discovery should reflect the current workspace and should be refreshed when the view is opened or explicitly refreshed. Avoid expensive continuous filesystem scanning.

## 6. PCB and PCBA workflow

After project selection, present two distinct operations:

### PCB Order

- Resolve the selected project's PCB artifact.
- Reuse the existing PCB manufacturing/order preparation implementation.
- Transfer the required PCB context to hqpcb.com.
- Open the resulting ordering experience in MDI.

### PCBA Order

- Resolve the selected project's PCB and associated BOM/component information.
- Reuse existing PCBA preparation and order capabilities.
- Transfer the required manufacturing context to hqpcb.com.
- Open the resulting ordering experience in MDI.

The user must not need to invoke agent tools manually.

Do not duplicate tool logic in UI event handlers. The UI should invoke the same underlying business operations already used by agent-facing tools, with a suitable user-interaction entry point.

If the existing implementation requires additional manufacturing information, preserve its established validation and parameter requirements.

## 7. hqpcb.com integration

hqpcb.com has been verified to load successfully in the current DSH MDI view.

Open the ordering page as a new MDI document using the existing webview infrastructure.

The URL must carry:

- The selected project context.
- The selected order type.
- Required manufacturing artifact/context references.
- The Huaqiu authentication token.

The authentication token handoff through the URL is an explicit integration requirement. Do not block implementation by imposing a token-free URL requirement.

Coordinate the exact URL contract with the hqpcb.com team.

The implementation must:

- Reuse the existing Huaqiu authentication source.
- Avoid independently implementing login.
- Avoid exposing tokens through unrelated logs, diagnostics or agent messages.
- Preserve the existing hqpcb.com URL conventions.
- Handle missing/expired authentication and failed page navigation.
- Avoid making the URL the authoritative source of local project-file truth.

The hqpcb.com side must validate the supplied context and handle its own quotation, manufacturing configuration and order submission.

## 8. Agent compatibility

The existing conversational ordering workflow must continue to work.

Both entry points must converge on the same manufacturing implementation:

- Agent-initiated ordering.
- User-initiated Place Order UI.

Do not remove existing agent tools or change their semantics merely to support the new UI.

Where appropriate, extract or reuse common project discovery and artifact-resolution logic rather than duplicating it.

## 9. Error handling

Cover at least:

- No valid KiCad projects.
- Project file cannot be read.
- Project has no usable PCB.
- PCBA BOM/component data unavailable.
- Duplicate project display names.
- Project files moved or deleted after discovery.
- Huaqiu authentication unavailable or expired.
- hqpcb.com navigation failure.
- MDI view creation failure.

Errors must be visible to the user and must not leave an apparently successful but unusable order view.

## 10. Acceptance criteria

1. A user can invoke the workflow without sending an agent message.
2. Multiple KiCad projects in one workspace are discovered correctly.
3. Projects with duplicate basenames remain distinguishable.
4. Discovery works independently of currently open MDI documents.
5. The project-selection view is hosted in MDI.
6. PCB ordering uses the selected project's actual PCB artifact.
7. PCBA ordering uses the selected project's associated PCB and BOM/component data.
8. Unavailable order types are clearly explained.
9. The hqpcb.com ordering page opens in MDI with the correct project, order type and Huaqiu token context.
10. Existing agent-initiated ordering remains functional.
11. No parallel manufacturing implementation is introduced.

## 11. Out of scope

- Native DSH desktop menu modifications.
- New project-management architecture.
- Workspace restructuring or migration.
- Order history/database implementation inside DSH.
- New manufacturing quotation backend.
- New authentication/login subsystem.
- 3D shell ordering.
- Redesign of hqpcb.com.
- Changes to official DSH workspace semantics.

## 12. Deliverables

- Source-code audit summary.
- Project discovery and artifact-resolution implementation.
- Plugin-owned project-selection MDI view.
- PCB/PCBA selection and invocation.
- hqpcb.com context and token handoff.
- Unit and integration tests.
- Agent compatibility regression results.
- Implementation report identifying modified source files, runtime dependencies, limitations and known issues.

**Implementation principle:** Extend the existing Huaqiu plugin. The plugin owns the workflow; the agent and desktop menu are two different entry points into it.
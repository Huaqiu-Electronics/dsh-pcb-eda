# PO-02 — Huaqiu DSH Desktop Native Place Order Menu

**Product:** Huaqiu Electronic Design Agent Platform  
**Component:** Huaqiu-maintained DSH desktop fork  
**Priority:** M1  
**Implementation owner:** DSH desktop team  
**Dependency:** PO-01 plugin-owned Place Order workflow

## 1. Objective

Add a native `Place Order` menu entry to the Huaqiu DSH desktop application.

The menu must appear beside the existing official `Application` and `Edit` menus, using a shopping-cart icon.

Selecting the menu item must invoke the Place Order workflow implemented by the existing Huaqiu plugin.

The desktop shell must remain a thin integration layer. It must not implement project discovery, project selection, PCB/PCBA manufacturing logic or hqpcb.com URL construction.

## 2. Target UI

The intended desktop menu is:

```text
Application    Edit    🛒 Place Order
```

Requirements:

- Use a shopping-cart icon.
- Use the existing desktop menu styling and interaction conventions.
- Position the menu beside the official menus.
- Keep it visible and discoverable from the main application shell.
- Follow the existing Huaqiu desktop branch's localization and theme conventions.
- Avoid modifying the semantics of existing official menus.

The implementation should be as small and isolated as possible.

## 3. Source-code audit

Before implementation, inspect the actual Huaqiu desktop branch and identify:

- Main desktop application entry point.
- Existing `Application` and `Edit` menu registration.
- Menu composition and extension mechanisms.
- Existing plugin registration and lifecycle.
- Plugin-to-desktop invocation mechanisms.
- MDI document/view creation and navigation APIs.
- Existing MDI webview hosting behavior.
- Existing error and notification presentation mechanisms.

Determine whether the native menu is registered directly by the desktop application or through an existing extension mechanism.

Prefer the existing mechanism if it supports this use case.

Do not introduce a generic menu-extension framework solely for one menu item.

## 4. Menu behavior

When the user clicks `Place Order`:

1. Resolve the active Huaqiu plugin instance or its registered workflow entry point.
2. Invoke the plugin-owned Place Order workflow.
3. Allow the plugin to discover projects and create its project-selection view.
4. Display the resulting view in the existing MDI infrastructure.

The shell should not know which projects exist or which order types are available.

It should not require an active PCB document to invoke Place Order.

The menu must work when:

- No engineering document is open.
- A schematic is active.
- A PCB is active.
- A STEP document is active.
- Multiple projects have documents open simultaneously.

The plugin determines the actual available projects from the current workspace.

## 5. Plugin integration contract

Integrate with the public or established internal plugin workflow interface delivered by PO-01.

The conceptual invocation is:

```ts
await huaqiu.placeOrder();
```

This is illustrative. Use the actual plugin registration and invocation conventions discovered during the source audit.

The contract must define:

- Workflow registration.
- Workflow invocation.
- Plugin availability.
- Invocation failure handling.
- MDI view creation ownership.
- Lifecycle behavior if the plugin reloads or becomes unavailable.

The shell should invoke the workflow once per user action and avoid duplicate MDI views caused by repeated event registration or accidental double invocation.

Do not directly invoke the plugin's underlying PCB/PCBA manufacturing tools from the menu handler.

## 6. MDI integration

The project-selection view and subsequent hqpcb.com ordering view are owned by the plugin workflow.

The desktop shell must provide or reuse the existing MDI hosting mechanism.

Requirements:

- Do not open a separate native window.
- Do not launch an external browser.
- Do not create a second webview framework.
- Preserve existing MDI tab behavior.
- Allow users to switch between engineering documents and ordering views.
- Follow existing MDI document lifecycle and cleanup behavior.

The shell must not duplicate hqpcb.com URL construction or token propagation.

## 7. Failure handling

Handle:

- Huaqiu plugin unavailable.
- Place Order workflow not registered.
- Plugin invocation failure.
- Plugin initialization or reload in progress.
- MDI view creation failure.
- Repeated menu invocation.

Provide appropriate user feedback through existing desktop notifications or error handling.

A plugin failure must not affect the availability of `Application`, `Edit` or normal engineering document operations.

Do not silently swallow invocation failures.

## 8. Compatibility requirements

- Preserve official DSH menu behavior.
- Do not modify unrelated desktop menus.
- Do not change MDI document semantics.
- Do not introduce new workspace/project concepts.
- Do not couple the desktop menu to a particular project file format beyond invoking the plugin.
- Do not duplicate existing agent-facing plugin capabilities.

## 9. Acceptance criteria

1. `Place Order` appears beside `Application` and `Edit`.
2. The shopping-cart icon is visible.
3. The menu is available regardless of the active MDI document type.
4. Clicking the menu invokes the existing Huaqiu plugin workflow.
5. The plugin opens its project-selection view in MDI.
6. The user can proceed through the PO-01 workflow to hqpcb.com.
7. Repeated clicks do not cause duplicate invocation registrations or uncontrolled duplicate views.
8. Plugin failure does not affect ordinary DSH functionality.
9. No project discovery or manufacturing business logic is implemented in the desktop shell.
10. The integration remains compatible with existing agent-initiated ordering.

## 10. Out of scope

- Project discovery.
- Project-selection UI.
- PCB/PCBA order preparation.
- Manufacturing quotation.
- hqpcb.com URL construction.
- Huaqiu authentication implementation.
- Order history.
- Workspace sidebar changes.
- New native project-management UI.

## 11. Deliverables

- Desktop source-code audit summary.
- Native menu implementation.
- Plugin workflow invocation integration.
- MDI integration verification.
- Error handling and regression tests.
- Final integrated E2E test results.
- Implementation report with changed source files and any remaining technical constraints.

**Implementation principle:** The Huaqiu DSH desktop fork provides a native entry point. All Place Order workflow logic remains in the existing Huaqiu plugin.
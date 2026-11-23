# DSH UI extension points — product layout feasibility audit

**Date:** 2026-11-23  
**Status:** Confirmatory source audit; no implementation source changed by this report  
**Question:** Can the existing DSH UI surface host the approved Hardware Engineering product experience **without modifying the DSH shell**?  
**Local baselines:** `deepseek-harness` `8097be700f` (clean, `master`), `dsh-pcb-eda` `8566f75` + uncommitted POC work, `deepseek-harness-desktop` `bdff3b7cb8` (older snapshot, not used by the gates)  
**Related reports:** `docs/research/hardware-engineering-ux-source-audit.md` (original source audit), `docs/research/ecad-viewer-and-quote-reference-source-study.md` (renderer/quote decisions), `docs/m1/hardware-engineering-artifact-viewer-poc-report.md` (implementation evidence)

---

## 1. Verdict

**Yes — the approved product layout fits the existing DSH client extension surface. No DSH shell modification is required for the POC.**

Every approved surface maps to a declared, plugin-reachable slot or service:

| Approved surface | Extension point | Plugin-only? |
|---|---|---|
| Persistent navigation before the conversation title | `conversation.header.leading` (`single`, `root`) | Yes |
| Persistent right-panel artifact viewer, surviving hide/session/dock | `sidebarRightTabs.register({ keepMounted: true })` + keyed `sidebar.right.pane.tab` | Yes |
| Exact artifact identity, selection and re-render without remount | `sidebar.right.openTab(kind, { params, revealIfOpened })`; `params` + `revision` via tab-info hook | Yes |
| Hardware Engineering settings inside the existing Settings UI | `settings.section` (`list`, `root`) + `ctx.configForms.get()` | Yes |
| Contextual native action in a session header | `conversation.session.header.actions` (`list`, `session`) **recommended**, or a viewer-owned action; **not** the occupied `corner` seat | Yes |

Two qualifications are important and are detailed below:

1. **The navigation is conversation-header-scoped, not full-window.** `conversation.header.leading` renders inside `ConversationHeader`, i.e. above the conversation column. It is available with no Session, as required, but it does not span the whole window above the sidebar and right panel. If the approved screenshot is non-negotiable about a full-width, always-mounted bar, one small core addition (`shell.header` in `AppFrame`) is the only shell change that could be justified — and it remains **optional**, not a POC requirement.
2. **The current POC plugin uses one occupied seat incorrectly.** It registers `ContextualOpenAction` in `conversation.session.header.corner`, which is already owned by `ui-sidebar-right`'s `ExpandButton`. Dynamic registrations receive descending negative priority and shadow the shipped occupant, so the product action can hide the control that re-opens a collapsed right panel. This is a **plugin-side correction**, not a reason to change the shell; the fix is to use the `conversation.session.header.actions` list slot or an action owned by the viewer body.

Nothing in this audit requires an Electron lifecycle change, agent-loop change, new floating window system, second right-sidebar architecture, new settings store, or modification of the open-in-app catalog.

---

## 2. What the shell actually provides

The authoritative shell for the release gates is `/Users/admin/code/deepseek-harness`, resolved by `dsh-pcb-eda/scripts/launch-dsh.mjs:55` (`HARNESS_DIR = path.resolve(SCRIPT_DIR, '..', '..', 'deepseek-harness')`) and used by `scripts/m1-activation/*` and `scripts/verify-huaqiu-desktop-distribution.ts:27` (`PRODUCT_VERSION = '0.7.11'`). The desktop repo is an older snapshot whose slot vocabulary does not contain the seats below (`deepseek-harness-desktop/deepseek-harness/.../slot-catalog.ts:81+`); it is not the gate-owned shell.

All client UI extension flows through the `ctx.slots` service:

- `deepseek-harness/packages/client/ui-slots/src/index.ts:26` declares the merged `SlotMap`; `:100-104` defines kinds (`single | list | keyed | chain | hoc`) and scopes (`root | session-maybe | session`); `:116-140` defines `SlotEntryDef`.
- `deepseek-harness/packages/client/ui-renderer/src/client/registry.ts:120` declares `SlotRegistry`; `:181` exposes the typed `register`; `:209-210` exposes `inject(key, callback)`; `:740-747` binds every registration to the caller's Cordis fiber so plugin unload disposes it.
- `deepseek-harness/packages/client/ui-renderer/src/client/registry.ts:28-45` marks `root` as reserved and directs plugins to `shell.overlay` instead; the root scope in the table below means *slot scope*, not the `root` slot.
- `deepseek-harness/packages/extensions/cordis-client-runner/src/client/guard.ts:96-143` wraps dynamic plugin registration: it verifies the slot is declared, auto-assigns a descending negative `priority` for shadowing kinds (`:127-132`), and records the claim in the plugin ledger. `deepseek-harness/packages/client/ui-slots/src/index.ts:1172-1178,1381-1405` confirms that the lowest live priority wins a `single`/`keyed` cell.
- Raw `register` into an undeclared slot throws (`ui-slots/src/index.ts:1241-1245`). The universal plugin pattern is therefore `ctx.slots.inject(key, () => ctx.slots.register({...}, Component))`, which defers until the owner declares the seat.

This is exactly the pattern already used by the independent external plugin `/Users/admin/code/dsh-plugin/dsh-market/src/client/index.ts:147-160,200-214` (settings section, plugins tab, overlay) and by the POC plugin.

---

## 3. Extension-point-by-extension-point confirmation

### 3.1 Navigation — `conversation.header.leading`

Declaration: `deepseek-harness/packages/client/ui-conversation/src/client/contract/slots.ts:265-270`:

```ts
/** Global navigation before the Session title, available without a Session. */
'conversation.header.leading': {
  kind: 'single'
  scope: 'root'
  owner: ConversationHeaderLeadingOwnerProps
}
```

Render site: `packages/client/ui-conversation/src/client/skeleton/ConversationHeader.tsx:18-21` — the seat is in the `<header>` before the session title row, and `ConversationHeader` is used for both blank and active sessions (`:12-26`). No shipped package registers into this seat; it is free for one product occupant. The owner props are markers, so state comes from the plugin's own store/inject.

**Confirmed:** five persistent destinations (Schematic, PCB, BOM, 3D CAD, Order — DFM removed per `ecad-viewer-and-quote-reference-source-study.md:25,272`) can render here with one occupant. Because the seat is `single`, all destinations must be rendered by that one component; that is what `dsh-hardware-ui/src/client/components.tsx:68-102` does.

**Limitation:** this header belongs to the conversation column, not the frame. The source audit already records the trade-off (`hardware-engineering-ux-source-audit.md:22-24,235,333`): "Strictly required: none for the POC if the navigation is accepted inside the conversation header"; full-width placement would need an optional root `shell.header` slot in `AppFrame`.

### 3.2 Right-panel viewer — `sidebarRightTabs` + `sidebar.right.pane.tab`

This is a two-stage, documented contract (`deepseek-harness/packages/client/ui-sidebar-right/src/client/index.ts:22-25`):

**Stage 1 — tab type.** `ctx.sidebarRightTabs.register(definition)` is provided at `ui-sidebar-right/src/client/index.ts:182-183` and typed in `ui-sidebar-right/src/client/tab-registry.ts:94-139`:

```ts
readonly id: string
readonly kind: string
readonly multiple?: boolean
/** Lazily keep a visited body mounted through hiding, Session changes and docking; default false. */
readonly keepMounted?: boolean
readonly patterns?: readonly string[]
readonly priority?: SidebarRightTabPriority
readonly canOpen?: (address: string) => boolean
readonly title: (address: string) => string
```

`register` at `tab-registry.ts:253-281` rejects duplicate ids, returns an idempotent disposer, and defaults the priority band to `extension` (`:120-121,49-59`). A plugin type can therefore outrank built-ins without touching them.

**Stage 2 — keyed body.** `sidebar.right.pane.tab` is declared `kind: 'keyed', scope: 'session'` at `ui-sidebar-right/src/client/index.ts:246` and `ui-sidebar-right/src/client/contract/slots.ts:59-64`; the plugin registers under the stage-1 definition `id`. `ui-sidebar-right/src/client/shell/SidebarRight.tsx:207-209` selects `definition?.id ?? tab.kind` as the dispatch key.

**keepMounted semantics:** `tab-registry.ts:107-108` declares it; `SidebarRight.tsx:208-209` calls `retainTab(tab.id, signal)` when true; `ui-sidebar-right/src/client/session-view.ts:60-75` holds the initialized body until unmount/occurrence cancellation; `ui-dockkit/src/components/TabLayout.tsx:15-21,46-48` keeps visited bodies mounted through hide/inert states. This is a shell-provided capability, not a plugin hack.

**Params and revision:** `ui-sidebar-right/src/client/contract/slots.ts:109-121` declares `SidebarRightNavigation { address, params, revision }`; `tab-domain.ts:136-143` sets `revision: 1` on first open and increments it on every subsequent open even when params are unchanged. `ctx.sidebarRight.openTab(kind, { params, revealIfOpened })` is typed at `ui-sidebar-right/src/client/service.ts:250`. A plugin augments `SidebarRightTabParamsMap` (`contract/params.ts:23-52`) to make its params typed. The body reads live data through `hooks.tabInfo` from `SidebarRightTabInjected` (`contract/slots.ts:217-220`, `tab-info.ts:11-55`).

**Confirmed:** one persistent viewer tab with exact artifact path/kind/destination in params and a revision that changes on every navigation; renderer disposal on revision change is an in-plugin concern and needs no shell support. The POC plugin already registers this shape at `dsh-hardware-ui/src/client/index.ts:146-151,162-167`.

### 3.3 Settings — `settings.section` + `configForms`

Declaration: `deepseek-harness/packages/client/ui-settings/src/client/contract/slots.ts:46-57`:

```ts
/** One settings page per list entry ... `id` ... `order` ... `label` ... */
'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps }
```

`settings.section.icon` is a separate `list` slot keyed by the same id (`:58-65`). The shell owns the Settings panel, navigation and Close button; the registrant owns all page copy and state (`SettingsSectionOwnerProps` only exposes `close`). `ui-settings-general/src/client/index.ts:232-247` declares the child seats; nav projection from the ledger is at `:161-186`.

Host-backed persistence is available through `ctx.configForms`, provided at `ui-settings/src/client/index.ts:31-54` and typed in `ui-settings/src/client/config-form.ts:223-236,284-293,109-167`: `get(namespace)`, `set`, `unset`, `mutate`, `dispose`. The external `dsh-market` plugin proves an out-of-tree package can use these seats (`dsh-plugin/dsh-market/src/client/index.ts:147-160,200-207`).

**Confirmed:** a Hardware Engineering section with KiCad/SolidCraft path inputs, Validate/Refresh and Host-backed persistence fits entirely inside plugin code. The shell's settings store is not duplicated.

### 3.4 Contextual action — seat selection matters

Free/additive options:

- `conversation.session.header.actions` — `list`, `session`, marker owner (`ui-conversation/src/client/contract/slots.ts:253-258`, owner type at `:421`); shipped use by `ui-agent-preset/src/client/index.ts` with `id` and `order`. A plugin adds a row without shadowing anyone.
- `sidebar.right.tab.menu.item` (`ui-sidebar-right/src/client/contract/slots.ts:105,222-234`) for context-menu placement.
- A button rendered by the viewer body itself, which is the most natural home for the POC's "top-right action of each viewer" requirement (`hardware-engineering-artifact-viewer-poc.md:631-649`).

**Occupied option — do not use as-is:** `conversation.session.header.corner` is `single`/`session` (`ui-conversation/src/client/contract/slots.ts:271-281`) and is registered by `ui-sidebar-right/src/client/index.ts` (`ExpandButton`, `shell/ExpandButton.tsx:1-16,34-55`) as the only way back into a collapsed right panel. Dynamic plugins get negative priority (`cordis-client-runner/src/client/guard.ts:127-132`) and therefore win the cell (`ui-slots/src/index.ts:1172-1178,1381-1405`), replacing the expand button. The current POC registration at `dsh-hardware-ui/src/client/index.ts:169-173` must be moved to a `list` slot or into the viewer; this is a plugin fix, not a shell change.

---

## 4. Mapping the approved layout end to end

| Requirement | Shell mechanism | Current POC status | Shell change needed? |
|---|---|---|---|
| Five destinations, visible without a project/Session | one `conversation.header.leading` occupant | implemented with six (`dfm` still present in `dsh-hardware-ui/src/client/model.ts:3-17`); remove DFM, keep five | No |
| Consistent selected project/board across destinations | plugin store + params/revision; no shell store | store + revision implemented (`client/store.ts:31-104`, `index.ts:99-110`); selectors are UI-only | No |
| Exact source filename/path displayed | plugin body reads params; tab type `title` | path shown as text (`components.tsx:201-202`) | No |
| Right panel stays mounted when hidden/session changes/docked | `keepMounted: true` on tab type | registered (`index.ts:146-151`) | No |
| Schematic / PCB canvas and GLB body | plugin renders into its own tab body; raw bytes from host route | **not implemented** — body is selectors/text (`components.tsx:104-208`) | No |
| Top-right native-open action with disabled/unconfigured state | viewer-owned button or `session.header.actions` list | currently in occupied `corner` seat (`index.ts:169-173`, `components.tsx:254-279`); relocate | No |
| Settings section with Host-backed config | `settings.section` + `configForms` | implemented (`index.ts:175-182`, `components.tsx:210-252`) | No |
| Order entry points using existing quote/order tools | plugin calls agent tools / host; no new backend | informational text only (`components.tsx:197-200`) | No |
| Host-only filesystem/process work | `hardwareArtifacts` service + `webServer` loopback routes | implemented and verified (`hardware-artifacts/src/*`, POC report §4) | No |
| Full-width nav bar above all three panels | no current seat; optional root `shell.header` | not approved as required; source audit marks optional | Only if this becomes a hard requirement |

---

## 5. Layout risks and how the existing surface handles them

- **Single-seat collisions.** `conversation.header.leading` and `conversation.session.header.corner` are `single`; one product occupant each. The nav is intentionally one component; the corner must be vacated. `list` slots (`session.header.actions`, `settings.section`) are additive and safe.
- **Priority.** The runner assigns negative priority to every dynamic registration (`guard.ts:127-132`). A plugin can accidentally shadow shipped chrome in any `single` seat. Rule: only occupy `single` seats that are documented free, and verify no shipped registrant exists.
- **No Session.** Navigation must be in a `root`-scope seat (`conversation.header.leading`), because `session`-scope seats disappear before a Session exists. The contextual action is legitimately `session`-scope.
- **Mount lifetime.** `keepMounted` is a property of the tab **type**, not of the slot registration; declaring it on `ctx.slots.register` would be ignored. Renderer disposal must be driven by `useTabInfo().navigation.revision` or the occurrence `signal`.
- **Bundling boundaries.** The client bundle is loaded through the host module table; cross-plugin value imports are forbidden by the client purity gate (`deepseek-harness/packages/client/tsdown.client.ts:839-853`). The plugin must declare every injected service in its own `inject` array (`guard.ts:206-214`); undeclared services are denied. The current POC declares `['slots','sidebarRight','sidebarRightTabs','configForms']` (`dsh-hardware-ui/src/client/index.ts:20`), which is sufficient for the four seats it uses.
- **Older desktop snapshot.** `deepseek-harness-desktop` lacks these slots. The POC targets the gate-owned `/Users/admin/code/deepseek-harness`; if the product must also run on that older snapshot, a separate compatibility decision is needed and is outside this POC.

---

## 6. Acceptance checks for the no-shell-change verdict

| ID | Check | Evidence in current source |
|---|---|---|
| U1 | Register a React component into `conversation.header.leading` with no Session and see all destinations | slot declaration `slots.ts:265-270`; render `ConversationHeader.tsx:18-21`; POC `index.ts:156-160` |
| U2 | Open a hardware tab with `{ destination, path, kind, revision }`, hide it, switch Session, re-show; body stays mounted | `tab-registry.ts:107-108`; `SidebarRight.tsx:208-209`; `session-view.ts:60-75`; `tab-domain.ts:136-143` |
| U3 | Re-open with changed params/revision and observe a new body render without tab remount | `tab-domain.ts:136-143`; `tab-info.ts:11-55`; POC `index.ts:99-110` |
| U4 | Settings section persists a path through `configForms` and survives reload | `settings/slots.ts:46-57`; `config-form.ts:109-167,284-293`; POC `index.ts:127-143` |
| U5 | Contextual action does not remove the right-panel expand control | `ExpandButton.tsx:1-16,34-55`; POC `index.ts:169-173` must be relocated |
| U6 | Product bundle boots with no DSH source diff and no HQ Edge | POC report §4: offline activation 24/24, 11/11 rows; `deepseek-harness` working tree clean |

U5 is the only current failure; U1–U4 and U6 are satisfied by the shell contracts and the existing P0 implementation.

---

## 7. Conclusion

The architectural risk called out by the user is resolved: **the approved product experience is deliverable with one product UI plugin and one host capability, using slots the DSH shell already declares.** The only shell-level question is the optional full-width header, which the source audit already classified as non-required for this POC. The outstanding work is product-side: remove DFM and SolidCraft launch, add the raw-content/GLB routes and renderers, wire Order to existing tools, and relocate the contextual action out of the occupied corner seat. None of those items requires a DSH core, Electron, agent-loop or settings-shell change.

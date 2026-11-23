# Hardware Engineering Artifact Viewer POC — implementation report

**Date:** 2026-11-23  
**Status:** P0 navigation/discovery/host-capability slice implemented and verified; viewer rendering phases remain partially open  
**Specs:** `docs/tasks/hardware-engineering-artifact-viewer-poc.md`, `docs/tasks/dsh-source-audit-hardware-engineering-ux.md`  
**Audit blueprint:** `docs/research/hardware-engineering-ux-source-audit.md`  
**Backplane local study:** `docs/research/backplane-local-source-study.md`  
**Revised rendering/quote spec:** `docs/research/ecad-viewer-and-quote-reference-source-study.md`  
**UI extension-point confirmation:** `docs/research/dsh-ui-extension-points-product-layout-audit.md`

## 1. Scope delivered

This pass completes the source audit and implements the first executable slice of the artifact-viewer POC:

1. reconciled the 0.7.10/0.7.11 distribution lockstep;
2. added a host capability for deterministic artifact discovery, installation resolution, validated native launch, and compact agent context;
3. added a product UI plugin for the six engineering destinations, a right-panel artifact tab, CAD settings, and a contextual native-app action;
4. wired both plugins into `@huaqiu/hardware-engineering`;
5. re-ran all integrity gates and the real offline DSH activation fixture at 0.7.11.

No HQ Edge dependency, daemon, separate application shell, agent-loop change, Python runtime, or new project database was introduced.

## 2. Packages and files

| Package | Change |
|---|---|
| `@huaqiu/hardware-artifacts` (new) | `hardwareArtifacts` host service, `/api/v1/hardware/{projects,installations,environment,open}`, installation settings schema, child-process environment names, compact prompt context. |
| `@huaqiu/dsh-hardware-ui` (new) | Six-destination `conversation.header.leading` nav, `keepMounted` `hardware-engineering` right-panel tab, declared shared store, settings section, `conversation.session.header.corner` native action. |
| `@huaqiu/hardware-engineering` | Added both exact-version workspace dependencies and two patch rows. Bundle now mounts **11** product rows. Ledger, README and contract tests updated. |
| `release-manifest/plugins-release-manifest.json` | Added the two new plugin entries; the product bundle itself remains deliberately unlisted. |
| `deepseek-harness` | `PRODUCT_VERSION` and workspace pins moved to 0.7.11; activation fixtures updated to 11 rows, `hardwareArtifacts`, and 0.7.11. |

Key implementation files:

- `packages/hardware-artifacts/src/service.ts` — canonical-path artifact identity, explicit-selection rules, KiCad/SolidCraft resolution, shell-free launch.
- `packages/hardware-artifacts/src/routes.ts` — loopback-guarded read/launch surface.
- `packages/hardware-artifacts/src/index.ts` — Cordis plugin, config schema, prompt-context contribution.
- `packages/dsh-hardware-ui/src/client/index.ts` — slot registrations and injected host operations.
- `packages/dsh-hardware-ui/src/client/store.ts` — store handle created inside `apply()`, shared by all registrations.
- `packages/dsh-hardware-ui/src/client/components.tsx` — navigation, viewer body, settings and contextual action.

## 3. How the implementation maps to the approved UX

This table records the as-built P0 slice. Section 5 applies the user's revised scope, which removes the DFM and SolidCraft-launch items and redefines the viewer gates.

| UX requirement | Implemented behavior |
|---|---|
| Persistent six destinations | One product-owned occupant in root-scoped `conversation.header.leading` renders Schematic, PCB, DFM, BOM, 3D CAD and Order Placing. All labels remain visible without a project. |
| Right-panel artifact viewer | One `sidebar.right.pane.tab` body with `keepMounted: true`; artifact identity travels in tab params/revision. The body displays the project and exact selected artifact path, with explicit empty/unconfigured states. |
| Shared product state | One declared store handle is attached to nav, tab body, corner action and settings. Native files remain authoritative; the store holds only selected paths. |
| Deterministic discovery | `.hardware-engineering.json` or an unambiguous `.kicad_pro` is required. Multiple projects, boards or sheets produce `selection-required` instead of a silent first match. Build/archive folders are excluded from default discovery. |
| CAD settings | Hardware Engineering settings section writes `kicadRoot` and `solidcraftRoot` through DSH config forms; the host resolves CLI/editor paths and validates on refresh. |
| Native handoff | Host validates the exact artifact path and configured executable, then launches with explicit argv, artifact-parent cwd, `shell: false` and detached stdio. |
| Agent context | `<hardware_environment>` contains only validated paths/versions and explicit unavailable states. Scoped env names: `HUAQIU_KICAD_CLI`, `HUAQIU_KICAD_PCBNEW`, `HUAQIU_KICAD_EESCHEMA`, `HUAQIU_SOLIDCRAFT`. No global `process.env` mutation. |

## 4. Executed verification

| Gate | Result |
|---|---|
| `@huaqiu/hardware-artifacts` typecheck + tests | PASS — 10/10 |
| `@huaqiu/dsh-hardware-ui` typecheck + tests + dual build | PASS — 2/2; browser `lib/client.js` emitted |
| `@huaqiu/hardware-engineering` contract tests + build | PASS — 16/16 |
| `check-release-version 0.7.11` | PASS — all 23 publishable packages |
| `check-publish` | PASS — 19 plugin catalog entries, manifests validated |
| `scripts/__tests__/*.test.mjs` | PASS — 45/45 |
| `pnpm build` in Huaqiu DSH fork | PASS — 10/10 gate groups |
| `verify-huaqiu-desktop-distribution` | PASS — 15/15 |
| Real offline activation, desktop family | PASS — **24/24 checks**, 11/11 product rows ACTIVE, 40 tools, `hardwareArtifacts` provided, no network escape |
| Negative control (`missing-provider`) | PASS — boot fails as intended with `huaqiu-auth=failed` and symbol/footprint pending |
| Functional e2e tool exercise | PASS — real tools executed; quote remains `FAILED_PRECONDITION` without a configured backend |

Evidence:

- `deepseek-harness/scripts/m1-activation/out/activation-desktop.json` / `.log`
- `deepseek-harness/scripts/m1-activation/out/activation-desktop-negative-missing-provider.json` / `.log`
- `deepseek-harness/scripts/m1-activation/out/e2e-desktop.json` / `.log`

Two warnings are expected and recorded honestly: the quote backend is not configured, and a Host provisioning step runs after the fixture's on-screen session is absent. Neither blocks activation.

## 5. Revised scope and remaining gaps

The original blockers have been resolved or re-scoped by the user:

1. **Viewer rendering is now a concrete adapter task, not an open architectural question.** The `ecad-viewer` source study at `docs/research/ecad-viewer-and-quote-reference-source-study.md` proves that `@huaqiu/kicad-sexpr-parser@0.1.1` and `@huaqiu/ecad-renderer@0.2.4` expose direct `parse` → `renderSchematic` / `renderPcb` APIs. The old requirement to re-host `@huaqiu/dsh-tool-pcb-viewer` is removed; that tool stays intact for its own turn-tail and standalone behavior.
2. **SolidCraft is configuration and agent context only.** No SolidCraft native launch, file-opening arguments or GUI handoff belongs to this POC. The existing settings field and scoped `HUAQIU_SOLIDCRAFT` context are sufficient.
3. **Interactive KiCad handoff is user-validated on Windows.** The shell-free, exact-artifact launch contract remains implemented and unit-tested; window-level confirmation is an external validation step.
4. **DFM is out of scope.** No DFM tab, score or action should be added.
5. **3D is GLB only.** The host derives GLB from the selected `.kicad_pcb` with `kicad-cli pcb export glb`; STEP/STP and mechanical-model conversion are removed from the POC gates.
6. **GLB rendering uses plain three.js.** ecad-viewer's GLB code is an app-only custom element around three.js with CDN decoder paths; DSH uses a small pinned three.js component and local assets instead.
7. **Quote/order reuses the existing backend path.** The user clarified the reference architecture on 2026-11-23: KiCad is simply a wrapper on the backend API — it builds the PCB or SMT form from the open board, POSTs it to the backend, and launches the returned URL in a webview or browser. This is confirmed by `pcbnew/fab/place_order_for_pcb.h`, `copilot/interface/settings/site_paths.h`, `copilot/assistant/quote/quote_controller.cpp` and `copilot/interface/settings/site_env.h`; the corrected endpoints are `https://www.eda.cn/openapi/api/hqpcb/External/fileQuote` and `https://www.eda.cn/openapi/pcba/saveDfmTmpOrder`. This is a host-side place-order flow, not a DSH backend requirement. `@huaqiu/dsh-tool-quote` already provides `quote_pcb`, `quote_smt`, `place_pcb_order` and `place_smt_order` over the hq-edge router; the place tools return the backend-owned `orderUrl` without reconstructing it. `FAILED_PRECONDITION` without a configured base URL is expected, not a defect.
8. **Publication is still pending.** The new packages are packed locally and pass release gates, but npm publication and the synchronized 0.7.11 manifest/CLI cut remain a release step.
9. **The UI surface requires no shell change.** `docs/research/dsh-ui-extension-points-product-layout-audit.md` confirms the five-destination nav, `keepMounted` right-panel tab, settings section and host-backed config are all plugin-reachable. One plugin-side correction is required: `ContextualOpenAction` currently occupies `conversation.session.header.corner`, which is shadowed-over by the dynamic registration priority and hides the shipped right-panel expand button; move it to `conversation.session.header.actions` or into the viewer body. A full-width header would be the only optional shell addition and is not a POC requirement.

The Backplane study at `docs/research/backplane-local-source-study.md` remains useful for artifact identity, deterministic discovery, saved-file BOM semantics and staged/cached export behavior. Its two discovery gaps — root-sheet hierarchy and project-owned board ranking — remain next-phase work. It no longer defines the renderer or quote architecture.

## 6. Recommended next sequence

The revised sequence follows `docs/research/ecad-viewer-and-quote-reference-source-study.md`:

1. Add authorized raw-content and bounded PCB→GLB routes to `@huaqiu/hardware-artifacts`, keeping native files authoritative.
2. Add parser/ecad-renderer canvas adapters inside the existing `@huaqiu/dsh-hardware-ui` client; dispose the previous viewer on artifact or revision change.
3. Add the small three.js GLB component for PCB 3D; remove DFM and STEP/STP/mechanical selectors.
4. Keep SolidCraft as a settings/agent-context path only; remove its native launch action.
5. Wire the Order destination to the existing four quote/order tools; do not build a backend or merge quote with submit.
6. Run package, bundle, release and activation gates; then publish 0.7.11 and let the user validate the Windows KiCad handoff and live quote backend.

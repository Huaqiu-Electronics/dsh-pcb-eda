# DSH → Official KiCad Integration: Edge Bridge Replacement Audit

**Priority:** P0  
**Type:** Source-code research / architecture audit  
**Implementation:** Not authorized  
**Primary objective:** Establish a source-proven replacement plan for `@hqedge/dsh-edge-bridge` using official KiCad CLI and IPC APIs.

---

## 1. Background and Objectives

We are moving towards a new product direction: **Hardware Engineering — from idea to manufactured product**.

The first POC should establish a direct integration between DSH and official KiCad, without depending on Huaqiu's customized KiCad or HQ Edge's integration layer.

The current integration is centered around:

```text
/Users/admin/code/hq-edge/apps/server/dsh-plugins/edge-bridge

Package:
@hqedge/dsh-edge-bridge
```

The intended POC architecture is:

```text
DSH
 |
 +-- @huaqiu/hardware-engineering
 |
 +-- Official KiCad Integration
       |
       +-- kicad-cli
       |
       +-- Official KiCad IPC API
```

The longer-term target is to remove HQ Edge completely from the DSH hardware engineering integration.

The new product plugin will be:

```text
@huaqiu/hardware-engineering
```

The investigation must establish exactly what is required to achieve both transitions without losing existing functionality.

### 1.1 Two architectural milestones

**Milestone A — Quick POC: Remove Edge Bridge**

Replace `@hqedge/dsh-edge-bridge` completely with direct official KiCad integration.

Requirements:

- No dependency on `@hqedge/dsh-edge-bridge`.
- No requirement to run the HQ Edge daemon.
- No requirement to communicate through HQ Edge RPC, HTTP or SSE endpoints.
- Official KiCad is the Tier 1 EDA host.
- Use `kicad-cli` for supported headless operations.
- Use the official KiCad IPC API for supported live application operations.
- Reuse existing DSH plugins wherever possible.
- Introduce `@huaqiu/hardware-engineering` as the new product-facing integration.

**Milestone B — Long-term: Remove HQ Edge**

Remove the remaining HQ Edge runtime and implementation dependencies.

Requirements:

- `@huaqiu/hardware-engineering` owns the hardware engineering integration.
- Native KiCad integration is implemented independently of HQ Edge.
- Existing DSH plugins remain reusable.
- No hidden dependency on HQ Edge configuration, runtime, credentials, service endpoints or internal package contracts.
- Huaqiu-specific KiCad functionality is optional rather than mandatory.

The report must distinguish the two milestones throughout.

A dependency that must be removed for Milestone A should not be confused with an infrastructure component that can remain temporarily but must be removed for Milestone B.

---

## 2. Source Code Scope

Inspect all four codebases.

| Codebase | Path | Investigation focus |
|---|---|---|
| HQ Edge | `/Users/admin/code/hq-edge` | Edge Bridge implementation, native integration, RPC, process management, host capabilities |
| KiCad Huaqiu | `/Users/admin/code/kicad` | Huaqiu-specific modifications, official KiCad functionality, native API implementation |
| DeepSeek Harness | `/Users/admin/code/deepseek-harness` | DSH runtime, plugin loading, tool registration, plugin APIs, execution and configuration |
| DSH PCB EDA | `/Users/admin/code/dsh-pcb-eda` | Existing plugins, workflows, prompts, tools and hardware-specific functionality |

Do not limit the investigation to the Edge Bridge directory.

Trace the complete execution path across all four repositories.

### 2.1 Establish repository provenance

For each repository, record:

- Current branch.
- Current HEAD commit.
- Working tree status.
- Relevant package versions.
- Relevant upstream or release baseline where identifiable.

For `/Users/admin/code/kicad`, explicitly identify:

- Whether the checkout is a Huaqiu fork.
- Its upstream KiCad remote and corresponding upstream revision.
- The fork-specific commit history.
- Relevant modified source files.
- Which modifications are actually consumed by current DSH workflows.

Do not assume that every difference between the Huaqiu fork and official KiCad is relevant.

Only classify a modification as a required Huaqiu dependency when source-level execution evidence establishes that the current workflow uses it.

---

## 3. Investigation A: Current DSH Plugin Integration Architecture

Establish how DSH plugins currently integrate with HQ Edge.

Start from:

```text
hq-edge/apps/server/dsh-plugins/edge-bridge
```

Package:

```text
@hqedge/dsh-edge-bridge
```

Trace the complete lifecycle.

### 3.1 Plugin discovery and loading

Identify:

1. How the Edge Bridge plugin is packaged.
2. Its manifest and entry point.
3. How it is installed or bundled into DSH.
4. How DSH discovers and loads it.
5. How plugin initialization occurs.
6. How configuration is passed into the plugin.
7. How the plugin discovers HQ Edge.
8. How authentication and credentials are obtained.
9. How it registers tools and other capabilities.
10. How it handles shutdown, errors and reconnection.

Include exact source locations and execution entry points.

### 3.2 Communication architecture

Trace every communication mechanism between:

- DSH runtime.
- Edge Bridge plugin.
- HQ Edge server.
- Native EDA host.
- Existing Huaqiu services where they participate in KiCad workflows.

Investigate:

- HTTP APIs.
- SSE.
- ConnectRPC / gRPC.
- Native IPC.
- Process spawning.
- Filesystem access.
- Environment variables.
- Configuration files.
- Authentication and token synchronization.
- Runtime discovery.
- Temporary files and artifact transfer.

For each communication channel, document:

| Field | Required evidence |
|---|---|
| Caller | Actual source module |
| Callee | Actual source module or service |
| Protocol | HTTP, RPC, IPC, filesystem, etc. |
| Endpoint / method | Exact name |
| Payload | Actual request and response types |
| Purpose | Why this communication exists |
| Failure handling | Retry, timeout, fallback, recovery |
| POC dependency | Whether it can be removed |
| Long-term dependency | Whether HQ Edge is still required |

Do not describe an architectural relationship without tracing an actual call path.

### 3.3 Plugin-to-plugin integration

Investigate how existing plugins consume HQ Edge capabilities.

In particular:

- Do existing plugins directly import Edge Bridge APIs?
- Do they invoke tools registered by Edge Bridge?
- Do they use shared service clients?
- Do they read Edge Bridge configuration?
- Do they depend on environment variables or credentials provided by HQ Edge?
- Are there hidden runtime assumptions?
- Can they continue functioning without Edge Bridge?
- Which capabilities are actually KiCad-specific?

Produce a dependency graph identifying all direct and transitive dependencies.

This investigation must cover both the Edge Bridge plugin and its consumers.

---

## 4. Investigation B: Actual KiCad Workflow Capability Inventory

This is the most important section.

Identify every actual capability exposed by the current DSH + Edge Bridge + HQ Edge integration that involves KiCad.

Do not assume the Edge Bridge manifest or tool descriptions represent the complete capability surface.

Trace each tool from its DSH registration through execution to the final native KiCad operation.

### 4.1 Build a complete capability inventory

For each capability, record:

| Field | Description |
|---|---|
| Capability ID | Actual tool or operation name |
| DSH plugin | Which plugin exposes it |
| Entry point | Tool registration source |
| Execution path | Complete call chain |
| HQ Edge involvement | Exact services or modules |
| Native KiCad involvement | Exact API, CLI, file or application operation |
| Huaqiu dependency | Whether a fork-specific feature is required |
| Inputs / outputs | Actual types and schemas |
| Side effects | Read-only, file modification, export, process launch |
| Current limitations | Actual implementation limitations |
| POC replacement | CLI, IPC, direct file operation or existing plugin |
| Long-term owner | Hardware Engineering, existing plugin or native adapter |

Include all operations, not just those that appear in the current chat interface.

### 4.2 Group capabilities by engineering domain

At minimum, investigate:

**A. Project and application**

- KiCad executable discovery.
- Version detection.
- Project discovery.
- Project opening.
- Project file access.
- Active project identification.
- Application process management.
- Document and editor discovery.
- Active document inspection.
- Project context synchronization.

**B. Schematic**

- Schematic document inspection.
- Symbol inspection.
- Component properties.
- Reference and value information.
- Net and connectivity inspection.
- Pin inspection.
- Symbol and library resolution.
- Schematic generation.
- Schematic modification.
- Save and reload behavior.
- ERC execution and report retrieval.

**C. PCB**

- Board inspection.
- Board outline.
- Footprint inspection.
- Component properties.
- Pad and net inspection.
- Track and via inspection.
- Zone inspection.
- Connectivity.
- Placement and movement.
- Routing and modification.
- Board save and reload.
- DRC execution and report retrieval.
- 3D board export or preview.

**D. BOM and libraries**

- BOM extraction.
- Reference designator mapping.
- Component property extraction.
- Footprint mapping.
- DNP handling.
- Datasheet and description.
- Manufacturer part number.
- Huaqiu library search.
- Symbol and footprint resolution.
- Library installation or synchronization.

**E. Manufacturing**

- Gerber generation.
- Drill file generation.
- BOM generation.
- CPL / pick-and-place generation.
- Assembly drawings.
- Manufacturing package preparation.
- Fabrication parameters.
- Manufacturing validation.
- Quote preparation.

**F. Additional integration**

- Selection and editor context.
- Native dialogs and URL handling.
- File opening.
- 3D viewer interaction.
- Screenshot or preview generation.
- Any other capability actually used by existing DSH workflows.

For each item, classify it as:

1. Used in an existing workflow.
2. Exposed but not currently used.
3. Implemented but inaccessible to DSH.
4. Huaqiu-specific extension.
5. Generic HQ Edge infrastructure.
6. Existing DSH plugin functionality independent of KiCad.

Do not invent capabilities simply because they would be useful in the future.

---

## 5. Investigation C: Huaqiu KiCad vs Official KiCad

Compare the current Huaqiu KiCad integration with official KiCad.

The purpose is to establish which current workflows depend on Huaqiu modifications and which can run against an official installation.

### 5.1 Source-level fork analysis

Identify relevant fork-specific changes in:

- KiCad IPC implementation.
- API server implementation.
- IPC transport.
- PCB editor.
- Schematic editor.
- Project manager.
- Plugin or scripting interfaces.
- File handling.
- Native dialogs.
- Application lifecycle.
- Custom commands or APIs.
- Any Huaqiu-specific RPC or protocol definitions.

For each relevant difference:

| Field | Required information |
|---|---|
| Feature | What the modification provides |
| Upstream availability | Whether official KiCad provides equivalent functionality |
| Huaqiu implementation | Exact modified files and symbols |
| Current consumer | Which HQ Edge or DSH component calls it |
| Runtime behavior | What actually happens |
| Official replacement | CLI, IPC, native API or another approach |
| Replacement difficulty | Low / Medium / High / Blocked |
| Evidence | Source references and call chain |

Use upstream KiCad source as the baseline where possible.

Do not infer that a feature is Huaqiu-specific merely because its current implementation resides in a Huaqiu source file.

### 5.2 Establish the official KiCad API baseline

Investigate official KiCad documentation and source for the actual supported versions.

At minimum, cover:

**kicad-cli**

- Version detection.
- Project and schematic export.
- ERC.
- DRC.
- BOM export.
- Gerber export.
- Drill export.
- Other supported manufacturing exports.
- Exit codes.
- Report generation.
- Batch execution.
- Headless availability.

**Official KiCad IPC API**

- API availability by version.
- API server startup.
- Connection establishment.
- Transport.
- Project and document access.
- Schematic API coverage.
- PCB API coverage.
- Board inspection and modification.
- Save and reload.
- Event notifications.
- Selection and editor state.
- Error handling and reconnection.

Explicitly distinguish:

- Officially documented and supported API.
- API available in source but not documented.
- Huaqiu extension.
- Current DSH-specific wrapper.
- Functionality available only through GUI automation or native file access.

Do not claim that an IPC feature exists just because a similarly named method exists in the Huaqiu fork.

### 5.3 Version compatibility

Build a compatibility matrix for the actual KiCad versions we intend to support.

At minimum, investigate KiCad 9 and 10, and assess KiCad 11 where relevant.

The matrix should show:

| Operation | CLI | Official IPC | Huaqiu extension | Version constraints |
|---|---|---|---|---|
| Schematic inspection | | | | |
| Schematic modification | | | | |
| ERC | | | | |
| PCB inspection | | | | |
| PCB modification | | | | |
| DRC | | | | |
| BOM | | | | |
| Gerber | | | | |
| Drill | | | | |
| CPL | | | | |
| Live selection | | | | |
| 3D export | | | | |

Use `Supported`, `Partial`, `Unsupported` and `Unknown` rather than making optimistic assumptions.

The official KiCad API may have substantial version-dependent differences. This must be reflected in the proposed adapter design.

---

## 6. Investigation D: Replacement Mapping

Produce a comprehensive replacement matrix covering every current KiCad-related capability.

Each row must have a concrete replacement strategy.

Allowed replacement classifications:

- `CLI`: Directly supported by official kicad-cli.
- `IPC`: Directly supported by official KiCad IPC API.
- `CLI + IPC`: Combination required.
- `Native files`: Direct native project-file manipulation, with appropriate format and integrity safeguards.
- `Existing DSH plugin`: Already implemented independently and reusable.
- `New hardware capability`: Must be implemented in `@huaqiu/hardware-engineering`.
- `Huaqiu-only`: Depends on Huaqiu-specific KiCad behavior and has no confirmed official equivalent.
- `HQ Edge infrastructure`: Generic infrastructure requiring replacement in Milestone B.
- `Not required`: Can be excluded from the POC.
- `Unknown`: Insufficient evidence; requires a proof experiment.

Required table:

| Current capability | Current implementation | Huaqiu-specific? | Official CLI replacement | Official IPC replacement | POC decision | Long-term owner |
|---|---|---|---|---|---|---|

Do not mark a capability as replaceable merely because an API has a similar name.

Check whether the API provides equivalent semantics, including:

- Data completeness.
- Mutation behavior.
- Save semantics.
- Validation behavior.
- Error reporting.
- Version compatibility.

For critical capabilities, describe any behavioral differences.

---

## 7. Investigation E: New Plugin Architecture

Propose how `@huaqiu/hardware-engineering` should replace `@hqedge/dsh-edge-bridge`.

The new plugin should own the product workflow, not KiCad implementation details.

The POC UI should contain these five tabs:

1. Schematic.
2. PCB.
3. DFM.
4. BOM.
5. Order.

Order should support three product categories:

- PCB.
- PCBA.
- 3D shell (TBD / SolidCraft integration later).

The initial real manufacturing flows are PCB and PCBA.

### 7.1 Define ownership boundaries

Investigate and recommend ownership for:

| Responsibility | Proposed owner |
|---|---|
| DSH agent runtime | DeepSeek Harness |
| Hardware workflow and five tabs | Hardware Engineering plugin |
| Hardware project state | Hardware Engineering plugin |
| KiCad CLI integration | Native KiCad adapter |
| KiCad IPC integration | Native KiCad adapter |
| EDA provider selection | Hardware Engineering integration |
| Library search | Existing library plugin |
| Quote calculation | Existing quote plugin |
| Authentication | Existing authentication integration |
| Manufacturing order lifecycle | Hardware Engineering + manufacturing service |
| Generic native application integration | Evaluate whether any existing functionality is still needed |
| Runtime and host lifecycle | Remove HQ Edge dependency for final target |

Identify existing code that can be reused and code that must be replaced.

### 7.2 Plugin integration

Inspect DSH's actual plugin registration, tool execution and inter-plugin integration mechanisms.

Determine how the new plugin can reuse existing plugins without:

- Copying their implementation.
- Importing private implementation internals.
- Making existing plugins depend on Hardware Engineering.
- Introducing duplicate tool names.
- Creating a new mandatory HQ Edge dependency.

If direct plugin-to-plugin invocation is not supported, recommend the smallest appropriate capability registry or service facade.

Do not assume a capability registry already exists.

### 7.3 EDA provider abstraction

Propose a provider contract that can eventually support:

- Official KiCad — Tier 1.
- KiCad Huaqiu — Tier 2.
- HQ EDA — Tier 2.

However, the first POC must only require official KiCad.

Explain how the common contract can be implemented without prematurely introducing a large universal EDA intermediate representation.

Native KiCad files should remain authoritative.

---

## 8. Investigation F: POC Architecture Without Edge Bridge

Produce a concrete target architecture for Milestone A.

The architecture must demonstrate that DSH can communicate with official KiCad without:

- `@hqedge/dsh-edge-bridge`.
- HQ Edge daemon.
- HQ Edge HTTP endpoints.
- HQ Edge ConnectRPC / gRPC endpoints.
- HQ Edge native IPC forwarding.
- Huaqiu-specific KiCad extensions.

The architecture should use:

```text
DSH
 |
 +-- @huaqiu/hardware-engineering
       |
       +-- Hardware project/workflow
       |
       +-- Native KiCad adapter
             |
             +-- kicad-cli
             |
             +-- Official KiCad IPC API
       |
       +-- Existing DSH plugins
             |
             +-- Library
             +-- Quote
             +-- Authentication
             +-- Other reusable capabilities
```

Identify any additional infrastructure required to support this architecture.

In particular, investigate:

- Executable discovery.
- KiCad version detection.
- IPC API server discovery and startup.
- Multiple KiCad instances.
- Active project selection.
- Process ownership.
- Windows process lifecycle.
- Timeouts and cancellation.
- Concurrent operations.
- File locking.
- Atomic modifications.
- Recovery after process termination.
- Artifact access.
- Logs and diagnostics.

Do not assume the native IPC API offers every feature that HQ Edge currently implements.

---

## 9. Investigation G: Long-Term Architecture Without HQ Edge

Milestone B should not be a second implementation of Milestone A with the same architecture hidden under a new name.

Identify every remaining dependency on HQ Edge after Edge Bridge is removed.

At minimum, inspect:

- Runtime configuration.
- Plugin installation and bundling.
- Environment variables.
- Credentials and token synchronization.
- Executable discovery.
- Native process management.
- IPC forwarding.
- Project and file access.
- Runtime updates.
- Logging.
- HTTP services.
- RPC services.
- Shared types and packages.
- Build and release dependencies.

For each dependency, determine whether it should:

1. Move into `@huaqiu/hardware-engineering`.
2. Move into a small reusable native adapter package.
3. Be provided directly by DSH.
4. Be replaced by a standard operating-system capability.
5. Be removed entirely.
6. Remain outside the hardware engineering product.

The long-term architecture should minimize infrastructure duplication.

Do not recommend recreating HQ Edge as another daemon unless the investigation establishes a compelling requirement.

---

## 10. Investigation H: Risks and Proof Experiments

List the uncertainties that cannot be settled through static source inspection.

Prioritize experiments that can invalidate the proposed architecture.

At minimum:

### Experiment 1 — Official KiCad CLI

Using an official KiCad installation:

- Discover executable and version.
- Open an existing project context.
- Run ERC and DRC.
- Generate BOM.
- Generate Gerber and drill files.
- Generate CPL where supported.
- Capture output, exit code and error behavior.

### Experiment 2 — Official KiCad IPC

- Start or connect to an official KiCad IPC server.
- Inspect the active project.
- Read schematic and PCB data where supported.
- Modify a simple design object.
- Save and reload.
- Verify changes in the native application.
- Test application shutdown and reconnection.

### Experiment 3 — DSH direct integration

- Load a minimal plugin that does not depend on HQ Edge.
- Discover official KiCad.
- Invoke a CLI operation.
- Invoke an IPC operation.
- Return structured results to DSH.
- Verify tool execution, cancellation and errors.

### Experiment 4 — Existing plugin reuse

- Load the new Hardware Engineering plugin alongside existing plugins.
- Verify library access.
- Verify quotation access.
- Verify authentication.
- Confirm that none of these operations require Edge Bridge or HQ Edge.

### Experiment 5 — End-to-end engineering workflow

Use a representative KiCad project and demonstrate:

```text
Project discovery
    ↓
Schematic inspection
    ↓
Schematic modification
    ↓
ERC
    ↓
PCB inspection
    ↓
PCB modification
    ↓
DRC
    ↓
BOM
    ↓
Gerber / Drill / CPL
    ↓
Manufacturing package
```

Clearly separate:

- Proven by source inspection.
- Proven by existing tests.
- Proven experimentally.
- Assumed but unverified.
- Blocked by missing APIs.

Do not claim successful replacement based solely on source-code similarity.

---

## 11. Required Deliverables

Create one comprehensive Markdown report.

Suggested destination:

```text
/Users/admin/code/hq-edge/docs/research/
  dsh-official-kicad-edge-bridge-replacement-audit.md
```

Follow existing repository documentation conventions if another research documentation directory is already established. Do not overwrite an existing document.

The report must contain:

### Part 1 — Executive summary

- Current integration architecture.
- Why Edge Bridge exists.
- What functionality it actually provides.
- Whether direct official KiCad integration is viable.
- Main Huaqiu-specific dependencies.
- Recommended POC architecture.
- Long-term HQ Edge removal feasibility.

### Part 2 — Current architecture

- Complete component diagram.
- Plugin loading and initialization.
- Communication and authentication flows.
- DSH plugin dependencies.
- HQ Edge execution paths.

### Part 3 — Capability inventory

- Every KiCad-related capability.
- Actual call chains.
- Inputs and outputs.
- Native KiCad involvement.
- Huaqiu-specific dependencies.
- Existing plugin ownership.

### Part 4 — Official KiCad compatibility

- Huaqiu fork versus upstream differences.
- CLI capability inventory.
- IPC capability inventory.
- Version compatibility.
- Missing or unsupported functionality.

### Part 5 — Replacement matrix

A complete mapping from current behavior to official KiCad CLI/IPC or other replacement mechanisms.

### Part 6 — New plugin boundaries

- `@huaqiu/hardware-engineering` responsibilities.
- Existing plugin reuse.
- Native adapter boundaries.
- EDA provider abstraction.
- Five-tab workflow ownership.

### Part 7 — Target architectures

Show both:

- Milestone A: DSH + Hardware Engineering + official KiCad, without HQ Edge.
- Milestone B: Long-term architecture without HQ Edge.

### Part 8 — Risks and proof experiments

Prioritized uncertainties and recommended tests.

### Part 9 — Migration plan

A phased sequence:

1. Understand and document current integration.
2. Identify reusable DSH plugins.
3. Implement direct official KiCad CLI/IPC adapter.
4. Introduce Hardware Engineering plugin.
5. Complete the five-tab POC workflow.
6. Remove Edge Bridge.
7. Remove remaining HQ Edge dependencies.
8. Add Tier 2 EDA providers later.

### Part 10 — Implementation task breakdown

Produce actionable follow-up tasks, each with:

- Scope.
- Affected repository.
- Relevant source modules.
- Dependencies.
- Acceptance criteria.
- Risks.

Do not implement these tasks as part of this research assignment.

---

## 12. Source Evidence Requirements

This is a source-proven investigation, not a conceptual architecture proposal.

Every important claim must include:

- Repository.
- File path.
- Class, function or symbol.
- Relevant line range.
- Actual execution relationship.
- Evidence classification.

Prefer evidence in this order:

1. Actual execution path.
2. Implementation source.
3. Tests.
4. Manifest and configuration.
5. Documentation.
6. Comments and naming.

Where possible, provide absolute file paths and line ranges.

For upstream KiCad behavior, cite the official source or documentation and record the corresponding version.

When a behavior cannot be established, explicitly mark it `Unknown` rather than inferring it.

Do not treat a tool description, README or prompt as proof that an operation works.

---

## 13. Research Method and Constraints

This is an investigation task only.

**DO NOT:**

- Modify source code.
- Change plugin manifests.
- Change package dependencies.
- Delete Edge Bridge.
- Implement the new Hardware Engineering plugin.
- Introduce a new IPC implementation.
- Modify KiCad source.
- Cherry-pick or merge commits.
- Change runtime configurations.
- Modify user or system-level KiCad installations.

You may:

- Read all four repositories.
- Run read-only Git commands.
- Search symbols and call sites.
- Inspect package manifests.
- Inspect build outputs where relevant.
- Run existing tests if they do not modify tracked files or external user state.
- Run isolated CLI/IPC proof experiments using a disposable project, provided they do not modify existing user projects or installations.
- Consult official KiCad documentation and upstream source.

Before running any experiment, establish its side effects and isolate its output.

Do not modify tracked or untracked user work.

---

## 14. Final Decision-Oriented Questions

The report must explicitly answer these questions.

1. What does `@hqedge/dsh-edge-bridge` actually contribute to the current DSH + KiCad workflow?
2. Which capabilities are implemented by HQ Edge rather than by Edge Bridge?
3. Which capabilities are provided by Huaqiu-specific KiCad modifications?
4. Which of those Huaqiu-specific capabilities have official KiCad CLI or IPC equivalents?
5. Which current DSH plugins can continue working unchanged after Edge Bridge is removed?
6. What is the minimum implementation required for direct DSH → official KiCad integration?
7. Can `kicad-cli` and official IPC cover the existing critical schematic and PCB workflow?
8. What operations require direct native file manipulation or another mechanism?
9. What functionality will be lost when moving from Huaqiu KiCad to official KiCad?
10. What is the smallest viable responsibility set for `@huaqiu/hardware-engineering`?
11. What HQ Edge dependencies remain after Milestone A?
12. How can those dependencies be eliminated for Milestone B without rebuilding HQ Edge under a different name?
13. What are the top five technical risks that could invalidate the proposed POC?

Conclude with a clear recommendation:

- **GO:** Can proceed with the proposed architecture.
- **CONDITIONAL GO:** Can proceed subject to identified proof experiments.
- **NO-GO:** A critical capability prevents the proposed architecture.

Explain the decision with source evidence.

---

## 15. Definition of Done

The investigation is complete only when:

- [ ] All four repositories have been inspected.
- [ ] Current Edge Bridge loading and execution paths are documented.
- [ ] All KiCad-related DSH capabilities have been inventoried.
- [ ] Huaqiu-specific KiCad dependencies have been identified and verified.
- [ ] Official CLI and IPC replacements have been mapped.
- [ ] Existing DSH plugin reuse has been assessed.
- [ ] Milestone A architecture has been defined.
- [ ] Milestone B HQ Edge removal dependencies have been identified.
- [ ] Five-tab Hardware Engineering workflow ownership has been established.
- [ ] Critical assumptions and missing evidence are explicitly listed.
- [ ] Implementation tasks and acceptance criteria are provided.
- [ ] The final report includes source paths and line-level evidence.

**Final expected outcome:** A decision-grade technical audit that allows us to implement `@huaqiu/hardware-engineering` and replace `@hqedge/dsh-edge-bridge` with direct official KiCad integration, while establishing a technically credible path to completely remove HQ Edge in the subsequent phase.

The report must prioritize what is actually implemented and required today over hypothetical future features. Keep the POC minimal, reuse the existing DSH ecosystem, and avoid designing infrastructure that the final product does not need.
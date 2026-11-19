# DSH Long-Term System Prompt Architecture and Authoring Guidance

> Reference copy of the design document from
> `hq-edge/docs/tasks/dsh-long-term-system-prompt-architecture-and-authoring-guidance.md`
> (synced 2026-11-19). Section numbers below are cited from `SKILL.md`.

**Priority:** P1 / Architecture  
**Scope:** DSH core `SystemPrompt`, agent-loop capability lifecycle, plugin prompt contributions, and HQ Edge integration  
**Objective:** Establish a predictable, task-scoped prompt architecture that preserves agent behavior while preventing unrelated plugin instructions from affecting every session.

## 1. Architectural principles

### 1.1 The system prompt is a behavioral contract, not a plugin documentation registry

The system prompt should contain only instructions that must govern the agent throughout the session.

It should not be the default storage location for:
- Complete plugin operating manuals.
- Domain-specific workflows unrelated to the current task.
- Tool parameter explanations already represented by tool schemas.
- Detailed examples that are only useful for a particular operation.
- Configuration values that can be supplied by the relevant tool or runtime context.

Every system-prompt contribution must have an explicit behavioral responsibility.

### 1.2 Separate instructions by lifetime and scope

Adopt four instruction layers:

| Layer | Content | Lifetime |
|---|---|---|
| Global system contract | Identity, truthfulness, EDA authority, safety and general tool-use invariants | Entire session |
| Capability guidance | Rules necessary to use a currently available capability correctly | While capability is exposed |
| Task guidance | Multi-step domain workflow, prerequisites, decision rules, failure handling and examples | Only when the task requires it |
| Runtime context | Current project, selection, environment, job state and other authoritative facts | Only while relevant and valid |

The distinction is behavioral, not merely organizational. Moving text between files does not reduce prompt consumption unless the runtime stops injecting it into the model request.

## 2. What the current source already provides

The design should extend existing DSH mechanisms rather than introduce a parallel prompt framework.

### 2.1 Ordered system-prompt sections

`SystemPrompt` already provides:
- Named sections with numeric ordering.
- Variable interpolation.
- Empty-section filtering.
- Optional `complete` sections.
- Assembly and rendering into a single system message.
- An assembly waterfall hook.

Use this as the single composition mechanism. Do not create a second independent system-prompt builder.

### 2.2 Tool-visibility-related registration

The audit confirms that several core instructions are registered only when their corresponding tools are visible.

Examples include:
- File-reference guidance when `read` is visible.
- Read/write/edit instructions alongside the corresponding filesystem tools.
- Search/fetch instructions alongside web tools.

This is an existing and useful coupling: instructions should not be present when the capability they govern is unavailable.

Extend this principle to plugin capabilities where appropriate.

### 2.3 Lazy skill loading

The current skill implementation does not inject full `SKILL.md` bodies into the initial system prompt. The skill catalog is exposed separately, and the full skill content is loaded through the skill tool.

Use this mechanism for substantial task-specific guidance rather than putting entire operating manuals into always-on system sections.

### 2.4 HQ Edge injection boundary

HQ Edge already controls plugin selection and whether a plugin receives `systemPrompt` injection through the generated overlay.

Retain HQ Edge as the deployment and capability-composition owner. Keep prompt content and prompt assembly behavior in DSH core and the plugin that owns the behavior.

These mechanisms are verified in the audited source. However, the audit does not establish that DSH currently supports per-user-intent activation or prompt updates during an agent turn. Those capabilities require explicit design and implementation.

## 3. Target architecture

### 3.1 Global prompt: small, stable and behaviorally critical

The global prompt should contain:

- Agent identity and operating role.
- Authoritative EDA data and tool-result requirements.
- No-fabrication and honest failure reporting.
- HQ Edge ownership of authentication, connection management and backend transport.
- General rules for handling untrusted external data.
- A small number of cross-domain execution invariants that genuinely apply to every task.

Do not put plugin-specific procedures into this layer.

The global prompt should be reviewed as a contract: removing a sentence requires identifying which behavior it protects and where that behavior will be enforced instead.

### 3.2 Capability guidance: coupled to capability exposure

A capability should carry its own minimal usage guidance.

For example:
- PCB preview guidance belongs with the PCB preview capability.
- Routing invariants belong with routing capabilities.
- Search/fetch policy belongs with the search capabilities.
- Schematic-generation entry-point guidance belongs with schematic-generation capabilities.

Where a capability is not exposed, its guidance should not be included in the prompt.

The existing tool-visibility-based section registration is a source-proven pattern to reuse. If a plugin has multiple independent capabilities, avoid making all of its guidance visible merely because one unrelated tool from that plugin is loaded.

### 3.3 Task guidance: load only when the task enters the domain

Long workflows belong in skills or another explicitly loaded task-guidance mechanism.

Examples:

**PCB routing guidance**
- Board prerequisites and save state.
- Authorized routing scope.
- Job lifecycle and progress interpretation.
- Cancellation and failure recovery.
- Connectivity and DRC verification.
- User-facing result reporting.

**Schematic-generation guidance**
- Requirement clarification.
- Design-document and script workflow.
- Skill invocation.
- File-generation constraints.
- Validation and delivery.

**Search guidance**
- Engine selection.
- Search/fetch sequencing.
- Fallback strategy.
- External-data trust boundaries.

The initial prompt should tell the agent when to load the relevant guidance. The detailed guidance should be loaded only when that domain is actually needed.

Prefer the existing skill mechanism when it can express the workflow and the agent can reliably discover and invoke the skill.

### 3.4 Domain activation: design a staged capability lifecycle

For capabilities whose guidance is too important or too complex to rely on a skill-discovery convention alone, introduce an explicit staged activation mechanism.

The target lifecycle is:

1. Start with the compact global prompt and a small baseline capability set.
2. The agent recognizes that a task requires a domain capability.
3. The agent activates or discovers the relevant capability through a bounded mechanism.
4. DSH exposes the corresponding tools and task guidance together.
5. The agent performs the task using the activated capability.
6. Capability-specific instructions are no longer included in subsequent unrelated requests when that capability is inactive.

The activation mechanism must be designed against the actual DSH agent-loop and tool lifecycle. Do not assume that a system-prompt section can already inspect user intent or be dynamically inserted between turns.

Prefer a tool/capability-driven transition over adding a separate LLM intent-classification request. An extra classification model call would introduce latency, cost, another failure point, and potentially a second interpretation of user intent.

If DSH cannot safely change tool visibility or prompt context mid-session, use a session-scoped activation boundary or a new task/session boundary rather than silently mutating the model's available capabilities.

### 3.5 Keep prompt and tool exposure consistent

A capability must not be in an ambiguous state where:
- Its tool is exposed but its mandatory safety guidance is absent.
- Its guidance is present but the tool is unavailable.
- A skill describes a different workflow from the actual tool implementation.
- A tool result contradicts an instruction that the agent has been told to treat as authoritative.

Capability activation should therefore treat tool availability and mandatory capability guidance as one logical unit.

## 4. Plugin authoring standards

Every plugin contributing system-prompt content must follow these rules.

### 4.1 Every section requires a declared purpose

For each section, document:

- Section name and owner.
- The behavior it protects.
- Whether it is global, capability-scoped or task-scoped.
- The capability or condition that requires it.
- Why the instruction cannot be enforced through a schema, tool description, skill or authoritative runtime result.
- Approximate token cost.
- Tests that demonstrate the behavior it protects.

A section without a clear behavioral responsibility should not be injected.

### 4.2 Prefer the narrowest effective instruction location

Use this precedence:

1. **Tool schema:** Parameter types, required fields, enums, constraints and machine-readable contracts.
2. **Tool description:** Concise invocation rules, important preconditions and tool-specific limitations.
3. **Skill/task guidance:** Multi-step procedures, domain policies, examples, recovery workflows and decision trees.
4. **Capability system section:** Mandatory behavior that must remain active whenever the capability is exposed and cannot safely live in a narrower location.
5. **Global system prompt:** Only cross-domain invariants.

Do not duplicate the same instruction at every layer. If duplication is intentional because a rule is safety-critical, document why.

### 4.3 Keep instructions operational and testable

Prefer:
- Clear preconditions.
- Explicit allowed and prohibited actions.
- Authoritative success/failure criteria.
- Recovery behavior.
- User-facing reporting requirements.

Avoid:
- Long narrative explanations.
- Repeated warnings with slightly different wording.
- Implementation details that do not affect agent decisions.
- Configuration snapshots that become stale.
- Instructions that merely restate a tool's schema.

### 4.4 Do not confuse prompt optimization with weakening behavior

A shorter prompt is not automatically a better prompt.

For each removed or relocated instruction, establish:
- Which behavior it protected.
- Which new location enforces it.
- Whether the replacement is loaded at the correct time.
- Whether the agent still follows the rule under success, failure, cancellation and retry scenarios.

A safety-critical instruction must not disappear simply because its token contribution is large.

## 5. Core implementation workstreams

### Workstream A — Prompt inventory and ownership

Build a machine-readable inventory of all registered sections.

For each section, capture:
- Name and owner package.
- Registration location.
- Order.
- Registration condition.
- Injection gate.
- Whether it depends on tool visibility.
- Rendered character/token estimate.
- Declared instruction scope.

Add a diagnostic output that can explain why a section appeared in a particular assembled prompt.

### Workstream B — Capability-scoped prompt registration

Extend the existing registration model only where required.

The implementation should:
- Preserve current ordering and interpolation semantics.
- Preserve the single authoritative `SystemPrompt` assembly path.
- Associate mandatory guidance with the capability it governs.
- Avoid loading unrelated plugin sections.
- Make missing mandatory guidance detectable.
- Define deterministic behavior when a capability is activated, deactivated or unavailable.

Do not introduce an undocumented convention based on section-name prefixes or numeric order. Capability ownership and activation should be explicit in the implementation.

### Workstream C — Task-guidance loading

Standardize the existing skill path for domain workflows.

Requirements:
- A capability can identify its relevant task guidance.
- The agent receives a concise discovery instruction at the correct scope.
- Full guidance is loaded only when needed.
- The loaded guidance has a clear owner and version.
- Missing or unavailable guidance produces an explicit failure path.
- Skills do not contradict tool schemas or runtime behavior.

### Workstream D — HQ Edge integration

Keep HQ Edge responsible for selecting and composing the deployed plugin/capability set.

Requirements:
- Preserve the existing generated overlay mechanism.
- Avoid embedding plugin prompt prose in `supervisor.ts`.
- Make capability injection explicit and auditable.
- Ensure plugin version changes cannot silently introduce large always-on prompt contributions.
- Keep deployment configuration separate from agent behavioral policy.

### Workstream E — Observability

For each model request, make it possible to inspect:

- Active system-prompt sections.
- Section owner and registration source.
- Active capabilities and visible tools.
- Loaded skills/task guidance.
- Token estimate per section and per owner.
- Whether a section was included because of global policy, capability activation or task guidance.

Do not log credentials, API keys or sensitive user/project content merely to provide prompt diagnostics.

## 6. Required tests

### Prompt assembly tests

- Stable ordering for equal and different section orders.
- Correct interpolation and strict failure for unknown variables.
- Empty sections remain omitted.
- `complete` section behavior remains explicit and tested.
- Capability-inactive sections are absent.
- Capability-active mandatory guidance is present.
- No duplicate section is rendered through multiple injection paths.

### Capability lifecycle tests

- A greeting does not activate PCB routing, schematic generation or unrelated search workflows.
- A routing request activates the routing capability and its mandatory guidance.
- A schematic-generation request activates its relevant workflow guidance.
- A search request activates the correct search policy.
- Failure to activate a required capability does not result in an unsupported tool call.
- Capability deactivation does not leave stale guidance or stale tools available.

### Behavioral contract tests

Test actual agent behavior, not only prompt text:

- No fabricated EDA facts or operation success.
- No unauthorized routing scope.
- No false claim of routing completion or connectivity.
- No automatic routing retry.
- Correct cancellation behavior.
- Correct search/fetch trust handling.
- Correct schematic-generation skill and file-generation constraints.
- Correct reporting of unavailable tools or missing task guidance.

### Regression and performance tests

Use identical user tasks and comparable model/runtime conditions.

Measure:
- Initial system-prompt tokens.
- First-request total prompt tokens.
- Follow-up request tokens.
- Task-specific guidance tokens when activated.
- Number of model requests.
- End-to-end latency.
- Tool-call correctness.
- Behavioral regression results.

The target is not to minimize every request independently. The target is to pay for domain guidance only when it is relevant, without adding unnecessary model calls or weakening task execution.

## 7. Migration strategy

Implement in stages:

**Phase 1 — Establish the contract**
- Inventory all sections.
- Classify each as global, capability-scoped or task-scoped.
- Identify duplicate instructions and missing behavioral tests.
- Preserve current behavior as the baseline.

**Phase 2 — Standardize plugin authoring**
- Apply the narrowest-location rule.
- Move long workflows to skills.
- Keep mandatory capability invariants with their capabilities.
- Add prompt contribution budgets and review requirements.

**Phase 3 — Introduce capability-scoped composition**
- Extend the existing DSH mechanisms.
- Implement explicit capability activation and lifecycle semantics.
- Keep tools and mandatory guidance synchronized.
- Verify compatibility with the current agent-loop and session model.

**Phase 4 — Roll out and validate**
- Compare old and new prompt composition.
- Run behavioral regression suites.
- Enable incrementally.
- Retain diagnostics and a rollback path.

## 8. Definition of done

- [ ] Global prompt contains only cross-domain behavioral invariants.
- [ ] Plugin operating manuals are not unconditionally injected.
- [ ] Capability-specific guidance is coupled to capability availability.
- [ ] Long workflows are loaded as task guidance when needed.
- [ ] Tool schemas, descriptions, skills and prompt sections have clear non-duplicated responsibilities.
- [ ] Prompt contributions have explicit ownership and token accounting.
- [ ] A greeting does not pay for unrelated EDA domain instructions.
- [ ] Routing, search and schematic-generation behavior passes regression tests.
- [ ] No additional LLM classification call is required for ordinary capability activation.
- [ ] HQ Edge remains the deployment/capability-composition owner; DSH and plugins remain the prompt-policy owners.

## 9. Explicit non-goals

- Rewriting the DSH session model.
- Moving system-prompt authorship into HQ Edge.
- Replacing the existing `SystemPrompt` service.
- Removing mandatory EDA safety or truthfulness constraints.
- Optimizing tokens at the expense of agent correctness.
- Introducing a second prompt framework or an independent intent-classification agent.
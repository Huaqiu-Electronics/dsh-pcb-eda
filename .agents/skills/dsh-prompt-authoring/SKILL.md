---
name: dsh-prompt-authoring
description: "Author or review DSH system-prompt contributions and plugin guidance. Use when adding, changing or auditing a systemPrompt section; deciding whether an instruction belongs in a tool schema, tool description, skill, capability section or the global prompt; reducing always-on prompt tokens; moving a long workflow into a skill; or designing capability-scoped activation, its lifecycle semantics and its tests."
---

# DSH prompt authoring

The system prompt is a **behavioral contract**, not a registry of plugin manuals. Every sentence must govern behavior for the whole time it is present. If an instruction is only needed while a capability is exposed, or only while a task is in a specific domain, it does not belong in the global prompt.

Full design rationale, implementation workstreams (A–E), migration phases and non-goals: [references/architecture.md](references/architecture.md). Read it before changing registration semantics or capability lifecycle; cite its section numbers in design reviews.

## Instruction layers

| Layer | Content | Lifetime | Lives in |
|---|---|---|---|
| Global system contract | Identity, truthfulness, EDA authority, safety, general tool-use invariants | Entire session | `SystemPrompt` global sections |
| Capability guidance | Rules required to use an exposed capability correctly | While the capability is exposed | Capability-owned section, registration gated on the capability/tool |
| Task guidance | Multi-step domain workflow, prerequisites, decision rules, failure handling, examples | Only while the task needs it | Skill (or another explicitly loaded mechanism) |
| Runtime context | Current project, selection, environment, job state | Only while valid | Runtime injection from authoritative state |

Moving text between files does not reduce prompt consumption. Only changing **what the runtime injects into the model request** does.

## Where the pieces live

- **`SystemPrompt` (DSH core)** — the only composition path: named sections with numeric order, interpolation, empty-section filtering, `complete` sections and an assembly waterfall. Extend it; never build a parallel builder.
- **Tool registration** — existing sections are already registered only when their tool is visible (file references with `read`, search/fetch policy with web tools). Reuse this pattern for plugin capabilities.
- **Skill catalog + skill tool** — the catalog is always visible, `SKILL.md` bodies are loaded on demand. This is the default home for substantial task guidance.
- **HQ Edge overlay (`cordis.patch.yml`)** — decides which plugins load and whether a plugin receives `systemPrompt` injection. Prompt prose stays in DSH core and the owning plugin.

## Choose the location first

Apply this precedence before writing anything (architecture §4.2):

1. **Tool schema** — parameter types, required fields, enums, structural constraints.
2. **Tool description** — invocation rules, preconditions, tool-specific limits.
3. **Skill / task guidance** — multi-step procedures, domain policy, examples, recovery trees.
4. **Capability system section** — mandatory behavior that must hold whenever the capability is exposed and cannot safely live in a narrower layer.
5. **Global system prompt** — cross-domain invariants only.

To decide between a capability section (4) and the global prompt (5), ask: *would this instruction be wrong or irrelevant when the capability is unavailable?* If yes, it is capability-scoped. If it is a procedure with branches and recovery steps, it is task guidance: write it as a skill.

Never duplicate the same instruction across layers. If a safety-critical rule is intentionally repeated, record why and which copy is authoritative.

## Non-negotiable rules

- A plugin's operating manual is never unconditionally injected. Only cross-domain invariants go into the global prompt.
- Every section declares: name and owner package; the behavior it protects; scope (global / capability / task); the capability or condition that requires it; why a schema, tool description, skill or runtime result cannot enforce it; approximate token cost; the tests that demonstrate the protected behavior. A section without a behavioral responsibility is not injected.
- Couple guidance to exposure. Register capability sections only when the capability (or its tool) is actually available. Do not expose all of a plugin's guidance because one unrelated tool from that plugin is loaded.
- Treat tool availability and mandatory capability guidance as **one logical unit**. Fail closed when mandatory guidance is missing: a visible tool with absent safety rules, or guidance with an unavailable tool, is a defect.
- Keep one authoritative assembly path: the existing `SystemPrompt` (named sections, numeric ordering, interpolation, empty-section filtering, `complete` sections, assembly waterfall). Do not build a second prompt builder.
- Do not rely on section-name prefixes or numeric order to express ownership or activation. Ownership and activation must be explicit in code.
- Prefer a tool/capability-driven transition over an extra LLM intent-classification call. If the agent loop cannot safely change tools or prompt context mid-session, use a session/task boundary instead of silently mutating capabilities.
- HQ Edge owns deployment and capability composition (generated overlay); DSH core and the owning plugin own prompt content and policy. Do not embed plugin prompt prose in `supervisor.ts`.
- Never weaken behavior to save tokens. For every removed or relocated instruction, record what behavior it protected, where it is enforced now, when that replacement loads, and that success/failure/cancellation/retry paths still follow it.
- Keep the assembled prompt diagnosable and budgeted: given a model request, it must be possible to say which sections were active, their owner and registration source, which capabilities and skills were active, and the token estimate per section. A plugin that grows its always-on contribution beyond its budget is a review finding, not a silent regression.

## Procedure: add or change a prompt contribution

1. **Search for an existing home.** Inventory the current sections and check whether the instruction already exists in a schema, description, skill or another section. Prefer editing that location over adding a section.
2. **Classify** the instruction as global, capability-scoped or task-scoped using the table above.
3. **Write it operationally**: preconditions, allowed and prohibited actions, authoritative success/failure criteria, recovery behavior, user-facing reporting. Remove narrative explanation, repeated warnings, implementation trivia and configuration snapshots.
4. **Wire the registration condition** to the capability/tool that requires it, preserving ordering and interpolation semantics. Make absence of mandatory guidance detectable.
5. **Add tests** (see below) and record the section's declaration (owner, behavior, scope, condition, token cost).
6. **Re-read the assembled prompt** and confirm the section appears only when its condition holds.

For a long workflow, keep a one-line discovery instruction in the always-on layer ("when doing X, load skill Y") and move the procedure itself into a skill.

## Procedure: move a workflow into a skill

- **Stays in the prompt**: when to load the skill, and any mandatory invariant that must hold even if the skill fails to load.
- **Moves to the skill**: prerequisites, sequencing, decision rules, examples, failure recovery, verification and reporting requirements.
- **Must not move**: safety and truthfulness constraints, or anything the runtime must enforce regardless of whether guidance was loaded.
- The skill's owner and version must be clear; a missing or unavailable skill must produce an explicit failure path, not a silent fallback.
- Skills must not contradict tool schemas or runtime behavior. If they drift, fix the skill or the tool — never both into two different stories.

## Tests to require

**Assembly** — stable ordering (equal and different orders); interpolation, with strict failure on unknown variables; empty sections omitted; `complete` behavior explicit; capability-inactive sections absent; capability-active mandatory guidance present; no section rendered twice through different injection paths.

**Lifecycle** — a greeting activates no PCB routing, schematic generation or unrelated search workflow; each domain request activates exactly its capability and guidance; a failed activation never leaves an unsupported tool call; deactivation leaves no stale guidance or tools.

**Behavioral** — test what the agent does, not only the prompt text: no fabricated EDA facts or success; no unauthorized routing scope; no false completion/connectivity claims; no automatic retry; correct cancellation; correct handling of untrusted external data; correct reporting when a tool or task guidance is unavailable.

**Regression and cost** — with identical tasks and comparable runtime conditions, measure initial prompt tokens, first-request and follow-up prompt tokens, task-guidance tokens when activated, number of model requests, end-to-end latency, tool-call correctness and behavioral results. The goal is to pay for domain guidance only when relevant — not to minimize each request at the cost of correctness or extra model calls.

## Review checklist

- [ ] The instruction is at the narrowest layer that can enforce it.
- [ ] It is absent when its capability or domain is inactive.
- [ ] Ownership, condition and token cost are declared, and a test protects the behavior.
- [ ] No duplicate or contradictory copy exists in another layer.
- [ ] Tool exposure and mandatory guidance cannot diverge.
- [ ] Activation needs no extra classification model call; mid-session mutation is either supported or replaced by a session/task boundary.
- [ ] HQ Edge still composes deployment; the plugin still owns its prompt policy.
- [ ] Removing this text would be a regression that some test would catch.

## Reference

- [references/architecture.md](references/architecture.md) — full design: principles (§1), existing mechanisms to extend (§2), target architecture (§3), authoring standards (§4), workstreams (§5), required tests (§6), migration phases (§7), definition of done (§8), non-goals (§9).

/**
 * The `huaqiu:schematic-gen` system-prompt section.
 *
 * Split out from `src/index.ts` so the text and the registration are
 * unit-testable without a cordis context, tools, or a skill registry — the
 * same split `@huaqiu/dsh-eda-selection` uses for its `eda:selection` section.
 *
 * ── Why a section at all ────────────────────────────────────────────────────
 * The composer chip's model form is the bare `@schematic-gen` token (see
 * `client/schematic-ref.ts`): the token is a UI affordance with no semantics
 * of its own, and whatever `codec.serialize` returns lands in the USER
 * message — repeating it on every send is noise the user reads back in their
 * own transcript. The section carries the semantics once, in the system
 * prompt, where policy text belongs.
 *
 * ── Why static, not a per-session provider ──────────────────────────────────
 * "Once the user chose Schematic Gen, the rest of the conversation continues
 * that work" is already true without any session state: the token sits in the
 * conversation history for every later turn, and the section is re-read on
 * every assembly. A dynamic provider would need a session-state source — the
 * only candidates are message-history I/O or a client→node signal, and prompt
 * assembly is on the agent's hot path (`dsh-eda-selection` documents the same
 * no-I/O rule). So the section is static text gated on the token, not a
 * per-session flag.
 *
 * @module
 */

/**
 * Unique prompt-section name.
 *
 * Reuses the retired `huaqiu:schematic-gen` name: `dsh-eda-selection` records
 * that the old section "has moved to the bundled kicad-schematic-design
 * skill", and this is that section coming back for the chip era — same slot,
 * same adjacency, no other registration to collide with.
 */
export const HUAQIU_SCHEMATIC_GEN_SECTION = 'huaqiu:schematic-gen'

/**
 * Centrally allocated placement: 590, between DSH's `PLAN_POLICY` (500) and
 * `TEAM_POLICY` (600).
 *
 * That is where `dsh-eda-selection` pins its `eda:selection` section, so both
 * Huaqiu policy blocks stay adjacent and both precede the tool-list sections
 * (`TOOL_*` at 1000+) they refer to. `ctx.systemPrompt.getSectionOrder()`
 * resolves only DSH's own named positions, so the number is pinned here and
 * asserted by a test.
 */
export const HUAQIU_SCHEMATIC_GEN_SECTION_ORDER = 590

/** The chip token the section is gated on — the chip's clipboard projection. */
export const SCHEMATIC_GEN_TOKEN = '@schematic-gen'

/**
 * The section text: what the `@schematic-gen` token MEANS.
 *
 * Static on purpose (see the module header). Four jobs, each mapping to a
 * failure mode observed with the earlier inline-payload chip:
 * 1. define the token as an explicit user choice — a bare token alone is an
 *    opaque string the model has no trained semantics for;
 * 2. pin the `kicad-schematic-design` skill — the retired online tools are
 *    gone, so an unpinned agent may reach for a dead entry point;
 * 3. forbid hand-written `.kicad_sch` files — asked for "an ESP32 mini", an
 *    LLM will otherwise author KiCad files itself, which KiCad cannot open;
 * 4. defer requirements to the user's own words — a gesture is not a spec.
 *
 * It never claims the token carries content: it says what the token means,
 * nothing about what the user asked for.
 */
export function schematicGenSectionText(): string {
  return [
    `Schematic Gen: ${SCHEMATIC_GEN_TOKEN} is the Schematic Gen chip; the user explicitly chose it. ` +
      'Use the kicad-schematic-design skill. Its entry routes parent, module child and focused edits; read only the relevant references.',
    "Use the user's own words as the design description; ask for the requirements when missing. " +
      'For a new project without a confirmed hardware design brief, show scope, unknowns and recommended choices, ask with ask_user_question and wait for a real reply before formal documents or scripts. If unavailable, ask in chat and end the turn. Silence, timeout, cancellation or preselection is not confirmation. Reuse the same project baseline.',
    'Save the hardware design brief and read it back with run-design.mjs --read-plan before generation; pass its path and sha256. Update and reread changed circuit decisions. Never hand-write .kicad_sch files or KiCad project files; use the skill APIs. Follow-up messages continue the same work without repeating the chip.',
    'Before implementing multiple independent functions, prepare libraries, parts.json and module-plan.json. Choose the sheet size and reserve non-overlapping module regions. Call dispatch_kicad_module_tasks with action:plan first; split concentrated work only at independently reviewable, confirmed interfaces. The builder fits frames around finished circuits; whitespace alone needs no child continuation. MODULE_DELEGATION_REQUIRED persists for this design: prepare and dispatch real independent-context children. Refresh/fill slots on completion without shell polling. Declare expectedConnections including repeated supply, ground and shield pins. The parent owns shared inputs and --modules assembly.',
    'A module child reads task.md, assigned reference notes and reference images before writing. Use the actual pin directions, field anchors and exact net names in the task; consult per-part geometry only as needed. Reuse confirmed requirements. Batch confirmed fixes and submit once after reading the current full-frame image. Advisory-only results do not need another build unless inspection confirms a defect. If the frame is unreadable, submit the candidate with visual review pending and identify the areas for parent inspection. Parent repair starts after child inactivity; retry is for explicit major redesign or interruption. Focused repair or unavailable delegation uses --sequential-reason.',
    'The parent matches each child handoff to the current candidate and report, then reviews flagged areas, cross-module interfaces and the whole sheet. Collect concrete defects before editing and recheck affected modules together. Refresh dispatch status after changes and require readyForAssembly before assembly; separately inspect the final sheet before publishing. Keep functional groups compact, local branches directly wired and readable. Fix real defects; conservative warnings do not need to reach zero.',
  ].join('\n')
}

/**
 * Structural view of `ctx.systemPrompt` — only the face we use.
 *
 * Structural so this module compiles without depending on
 * `@deepseek-ai/dsh-system-prompt` (whose `Context` augmentation would
 * otherwise have to be in the compilation for a typed `ctx.systemPrompt`).
 */
export interface SystemPromptLike {
  section(section: {
    name: string
    order: number
    text: string | ((context: unknown) => string)
  }): () => void
}

/**
 * Register the static Schematic Gen section.
 *
 * Never throws: a DSH deployment without the prompt service, or one where a
 * duplicate registration races (hot reload), must still load the tools and
 * the skill — the section is an enhancement, not a dependency of the rest of
 * the plugin. A duplicate is the expected hot-reload case, so it is swallowed
 * rather than surfaced; the first registration keeps serving.
 *
 * @param systemPrompt - `ctx.systemPrompt`, or undefined.
 * @returns the section's disposer, or `undefined` when nothing was registered.
 */
export function registerSchematicGenSection(systemPrompt: unknown): (() => void) | undefined {
  if (
    systemPrompt === undefined || systemPrompt === null ||
    typeof (systemPrompt as SystemPromptLike).section !== 'function'
  ) {
    return undefined
  }
  try {
    const dispose = (systemPrompt as SystemPromptLike).section({
      name: HUAQIU_SCHEMATIC_GEN_SECTION,
      order: HUAQIU_SCHEMATIC_GEN_SECTION_ORDER,
      text: schematicGenSectionText(),
    })
    return typeof dispose === 'function' ? dispose : undefined
  } catch {
    // Duplicate registration (hot reload) — the first one is still live.
    return undefined
  }
}

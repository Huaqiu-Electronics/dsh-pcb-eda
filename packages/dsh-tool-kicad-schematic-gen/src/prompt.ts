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
    `Schematic Gen: the ${SCHEMATIC_GEN_TOKEN} token in a user message is the ` +
      'Schematic Gen chip — the user explicitly chose it for that request. ' +
      'Produce the design with the `kicad-schematic-design` skill, which ' +
      'starts from the hardware design brief when none exists yet.',
    'For every new schematic project, first show the requirements summary, scope, key unknowns and recommended choices. Ask with ask_user_question and wait for an actual user reply BEFORE writing formal design documents or generation scripts. If the tool is unavailable, ask in chat and end the turn to wait. Silence, timeout, cancellation or a preselected option is not confirmation. Reuse an already confirmed requirements baseline for the same project; do not ask again unless core requirements change.',
    'Before writing or running a schematic generation script, save the hardware design document and read it back with run-design.mjs --read-plan. Implement that document; pass its path and sha256 to generation. Never postpone the plan until after drawing. ',
    'Never hand-write .kicad_sch files or KiCad project files yourself; go ' +
      'through the skill and its tools.',
    "Use the user's own words as the design description — if they have not " +
      'described the circuit yet, ask for the requirements instead of ' +
      'assuming them.',
    'Follow-up messages in the same conversation continue that work without ' +
      'repeating the token.',
    'For a simple schematic, plan layout before the first build, collect concrete readability defects and fix them together once, then verify and deliver. Stop layout edits when connections, grid, readability, page fit and project files meet the delivery criteria. Further iterations require an identified blocking defect; do not rebuild for cosmetic preferences or to drive conservative layout warnings to zero. Real errors must still be fixed, regardless of iteration count.',
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

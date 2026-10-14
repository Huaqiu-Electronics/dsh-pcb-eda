/**
 * `@huaqiu/dsh-tool-schematic-gen` — standing node-side prompt guidance.
 *
 * This is the *always-on policy* half of the integration. The other half is
 * per-turn: the `@schematic-gen` chip's `codec.serialize()` splices explicit
 * "the user chose Schematic Gen for this request" intent into the user message
 * at the chip's position (see `src/client/schematic-ref.ts`). Keeping them
 * separate is deliberate — a system-prompt section cannot express per-turn
 * intent, and the chip should not carry tool policy.
 *
 * @module
 */

/** Unique prompt-section name. */
export const SCHEMATIC_GEN_SECTION = 'huaqiu:schematic-gen'

/**
 * Centrally allocated placement: between DSH's `PLAN_POLICY` (500) and
 * `TEAM_POLICY` (600), so tool policy precedes the tool-list sections
 * (`TOOL_*` at 1000+) the guidance refers to.
 *
 * `ctx.systemPrompt.getSectionOrder()` only resolves DSH's own named
 * positions, so the number is pinned here and asserted by a test.
 */
export const SCHEMATIC_GEN_SECTION_ORDER = 590

/**
 * Standing guidance text.
 *
 * Concise on purpose: it states *when* to reach for the generation tools, and
 * leaves the *what* to the user's own words. It must never imply that a design
 * description already exists — that claim belongs to the user message.
 */
export const SCHEMATIC_GEN_GUIDANCE =
  'Schematic generation (Huaqiu EDA):\n' +
  'When the user asks for a schematic, circuit or system design to be produced, ' +
  'call `generate_schematic_from_description` (single design) or ' +
  '`generate_system_module_graph` (multi-module / system-level design) instead of ' +
  'writing .kicad_sch files, symbols or netlists by hand.\n' +
  'Pass the user\'s own requirements through as the design description; do not ' +
  'invent specifications they did not give. Generation is triggered by the ' +
  "user's request — never merely because these tools are available."

/** Structural view of `ctx.systemPrompt` (only the face we use). */
export interface SystemPromptLike {
  section(section: {
    name: string
    order: number
    text: string | ((context: unknown) => string)
  }): () => void
}

/**
 * Register the standing guidance section.
 *
 * Never throws: a DSH deployment without the prompt service (or one where a
 * duplicate registration races) must still load the tools.
 *
 * @param systemPrompt - `ctx.systemPrompt`, or undefined.
 * @returns disposer (a no-op when the section was not registered).
 */
export function registerSchematicGenPromptSection(systemPrompt: unknown): () => void {
  if (
    systemPrompt === undefined || systemPrompt === null ||
    typeof (systemPrompt as SystemPromptLike).section !== 'function'
  ) {
    return () => {}
  }
  try {
    const dispose = (systemPrompt as SystemPromptLike).section({
      name: SCHEMATIC_GEN_SECTION,
      order: SCHEMATIC_GEN_SECTION_ORDER,
      // A constant string is enough: the guidance is static policy, and the
      // provider must never perform I/O during prompt assembly.
      text: SCHEMATIC_GEN_GUIDANCE,
    })
    return typeof dispose === 'function' ? dispose : () => {}
  } catch {
    return () => {}
  }
}

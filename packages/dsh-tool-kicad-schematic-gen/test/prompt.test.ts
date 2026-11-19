/**
 * The `huaqiu:schematic-gen` system-prompt section.
 *
 * The contract under test:
 *
 *   - identity and placement: the retired section name, pinned between
 *     `PLAN_POLICY` (500) and `TEAM_POLICY` (600), beside `eda:selection`;
 *   - content: the section DEFINES the `@schematic-gen` token, pins the
 *     `kicad-schematic-design` skill, forbids hand-written KiCad files, and
 *     requires real user confirmation — while leaving detailed procedure to
 *     the skill. It never claims the token carries design content, nor names
 *     a retired tool;
 *   - registration is guarded: a missing `systemPrompt` service, a duplicate
 *     registration (hot reload) or a disposer-less `section()` must not throw.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HUAQIU_SCHEMATIC_GEN_SECTION,
  HUAQIU_SCHEMATIC_GEN_SECTION_ORDER,
  SCHEMATIC_GEN_TOKEN,
  registerSchematicGenSection,
  schematicGenSectionText,
  type SystemPromptLike,
} from '../src/prompt.ts'

/** The section argument `systemPrompt.section()` is called with. */
type SectionArg = Parameters<SystemPromptLike['section']>[0]

/** A `section` mock that records its argument and reports disposal. */
function sectionMock() {
  const calls: SectionArg[] = []
  let disposed = 0
  const section = (section: SectionArg): (() => void) => {
    calls.push(section)
    return () => { disposed += 1 }
  }
  return { section, calls, disposed: () => disposed }
}

test('section identity and placement', () => {
  assert.equal(HUAQIU_SCHEMATIC_GEN_SECTION, 'huaqiu:schematic-gen')
  assert.equal(SCHEMATIC_GEN_TOKEN, '@schematic-gen')
  // Beside eda:selection: between PLAN_POLICY (500) and TEAM_POLICY (600)…
  assert.ok(HUAQIU_SCHEMATIC_GEN_SECTION_ORDER > 500)
  assert.ok(HUAQIU_SCHEMATIC_GEN_SECTION_ORDER < 600)
  // …and well before the tool-list sections (TOOL_* at 1000+) it refers to.
  assert.ok(HUAQIU_SCHEMATIC_GEN_SECTION_ORDER < 1000)
})

test('the section defines the token, pins the skill, and carries the guardrails', () => {
  const text = schematicGenSectionText()
  // Defines the token as an explicit user choice.
  assert.match(text, /@schematic-gen/)
  assert.match(text, /explicitly chose/)
  // Pins the local skill entry point and the user's own description.
  assert.match(text, /kicad-schematic-design/)
  assert.match(text, /own words/)
  // Guardrails: no hand-written KiCad files; requirements come from the user.
  assert.match(text, /Never hand-write \.kicad_sch files/)
  assert.match(text, /confirm requirements with the user/)
  assert.match(text, /wait for a real reply/)
  // Follow-ups continue without repeating the token.
  assert.match(text, /Follow-up messages/)
  // Never claims the token carries design content, and never names a tool —
  // the skill pin is a name, not an invocation contract.
  assert.doesNotMatch(text, /generate_schematic_from_description/)
  assert.doesNotMatch(text, /generate_system_module_graph/)
  assert.doesNotMatch(text, /the circuit is/)
})

test('the section stays short and does not duplicate the skill procedure', () => {
  const text = schematicGenSectionText()
  assert.ok(text.length < 1000, `section grew to ${text.length} chars`)
  assert.doesNotMatch(text, /run-design\.mjs --read-plan/)
  assert.doesNotMatch(text, /plan layout before the first build/)
  assert.doesNotMatch(text, /Silence, timeout, cancellation/)
})

test('registration forwards the section and its disposer', () => {
  const mock = sectionMock()
  const dispose = registerSchematicGenSection({ section: mock.section } as SystemPromptLike)

  assert.equal(mock.calls.length, 1)
  assert.equal(mock.calls[0]?.name, HUAQIU_SCHEMATIC_GEN_SECTION)
  assert.equal(mock.calls[0]?.order, HUAQIU_SCHEMATIC_GEN_SECTION_ORDER)
  assert.equal(mock.calls[0]?.text, schematicGenSectionText())

  assert.equal(typeof dispose, 'function')
  dispose?.()
  assert.equal(mock.disposed(), 1)
})

test('registration is guarded: absent or hostile services never throw', () => {
  assert.equal(registerSchematicGenSection(undefined), undefined)
  assert.equal(registerSchematicGenSection(null), undefined)
  assert.equal(registerSchematicGenSection({}), undefined)
  // A duplicate registration (hot reload) is swallowed — the first serves.
  const hostile: SystemPromptLike = {
    section: () => { throw new Error('duplicate section name') },
  }
  assert.equal(registerSchematicGenSection(hostile), undefined)
  // A section() that returns no disposer still counts as registered.
  assert.equal(registerSchematicGenSection({ section: () => undefined } as unknown as SystemPromptLike), undefined)
})

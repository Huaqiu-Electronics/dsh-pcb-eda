/**
 * `@huaqiu/dsh-tool-schematic-gen` — the `@schematic-gen` reference source.
 *
 * One module owns the identity of the chip, its menu row, and the model text
 * the chip expands to at submit time. Registering the source is MANDATORY, not
 * cosmetic: DSH's submit plane routes every chip to its owner's codec and
 * rejects the whole send when the owner or its codec is missing
 * (`InputTriggerController.serializeReference` — "no serializer for reference
 * source"). A chip inserted without a registered source would therefore block
 * the user's message instead of degrading quietly.
 *
 * Registering it also buys the typed path for free: the user can type `@` and
 * pick *Generate schematic* (生成原理图 under a Chinese UI) from a group beside
 * *Files & folders* / *Sessions*.
 *
 * Everything the pipeline needs is declared STRUCTURALLY — no DSH package is
 * imported, so the client bundle stays pure (see `test/client-bundle-purity`).
 * The one import, `@huaqiu/dsh-sidebar-entry`, is our own plain library and is
 * covered by `alwaysBundle`; it is read for the host `<html lang>`, which is
 * how the chip label follows the UI language.
 *
 * @module
 */

import { detectHostLocale, type HostLocale } from '@huaqiu/dsh-sidebar-entry'

/** Menu group / chip owner name (unique per trigger char). */
export const SCHEMATIC_GEN_SOURCE = 'schematic-gen'

/** Owner-scoped reference id carried by the chip. */
export const SCHEMATIC_GEN_REF = 'generate'

/**
 * Inline chip label and menu candidate name — the ENGLISH copy, exported for
 * tests and for callers that need a stable literal.
 *
 * Never use it as the rendered string: `schematicGenLabel()` is the localized
 * accessor. The label used to BE this constant, which is why the chip in the
 * composer stayed English under a Chinese UI — the sidebar row, the tooltip and
 * the HIT card were all localized, and only the chip they insert was not.
 */
export const SCHEMATIC_GEN_LABEL = 'Generate schematic'

/**
 * Browser-console tag — greppable so the chip's language can be traced end to
 * end in the DSH WebView without a debugger.
 *
 * Every line is `console.debug` and every helper is wrapped, so a host without
 * a console (or one that rejects the payload) can never break the plugin.
 */
const TRACE = '[schematic-gen:ref]'

/** Emit one trace line. Never throws. */
function trace(event: string, payload?: unknown): void {
  try {
    // eslint-disable-next-line no-console
    console.debug(TRACE, event, payload ?? '')
  } catch {
    /* a non-console host must never break the composer */
  }
}

/**
 * Localized chip label / menu candidate name.
 *
 * Read fresh on every call rather than captured at registration: the chip is
 * created on a user gesture (button click or menu pick), so the language at
 * that moment is the language the user is looking at. zh is the fallback,
 * matching the sidebar row and the HIT card.
 */
export function schematicGenLabel(lang: HostLocale | undefined = detectHostLocale()): string {
  const label = lang === 'en' ? 'Generate schematic' : '生成原理图'
  // The one line that answers "why is my chip English": it shows both what the
  // host reported (`<html lang>`) and what we rendered from it.
  trace('label', { hostLang: lang ?? null, htmlLang: readHtmlLang(), label })
  return label
}

/** `<html lang>` as the plugin sees it, for the trace (null when unavailable). */
function readHtmlLang(): string | null {
  try {
    return document.documentElement?.getAttribute('lang') ?? null
  } catch {
    return null
  }
}

/** Clipboard / draft-persistence projection of the chip. */
export const SCHEMATIC_GEN_CLIPBOARD = '@schematic-gen'

/** Trigger char this source binds to. */
export const SCHEMATIC_GEN_TRIGGER = '@'

/** Menu group display order (lower = higher in the list). */
export const SCHEMATIC_GEN_ORDER = 10

/** Menu/group candidate description — the English copy (see {@link schematicGenDescription}). */
export const SCHEMATIC_GEN_DESCRIPTION = 'Generate a KiCad schematic from a description'

/** Localized menu/group candidate description (zh fallback, like the label). */
export function schematicGenDescription(lang: HostLocale | undefined = detectHostLocale()): string {
  return lang === 'en'
    ? 'Generate a KiCad schematic from a description'
    : '根据描述生成 KiCad 原理图'
}

/**
 * Model form of the chip: what the agent actually reads at the chip's position
 * in the user message.
 *
 * Deliberately an *intent*, never a fabricated design description — the user's
 * own words stay the only source of requirements, and the plugin being loaded
 * is never by itself a reason to generate.
 */
export const SCHEMATIC_GEN_SERIALIZED =
  '<schematic-gen intent="generate_schematic_from_description">\n' +
  'The user explicitly chose Schematic Gen for this request. Produce the design ' +
  'with the `generate_schematic_from_description` tool; for a multi-module or ' +
  'system-level design use `generate_system_module_graph` instead.\n' +
  'Never hand-write .kicad_sch files or KiCad project files yourself — always go ' +
  'through the tools.\n' +
  "Use the user's own words as the design description. If they have not described " +
  'the circuit yet, ask for the requirements instead of assuming them.\n' +
  '</schematic-gen>'

/** Menu/group candidate description. */
/**
 * The frozen `ReferenceInsert` shape DSH's composer consumes.
 *
 * Structural — declared here so the insertion path and the pick path cannot
 * drift apart. `appearance` is intentionally omitted: `ReferenceChip` renders
 * the standard `@` marker when it is undefined, which is exactly the look the
 * shipped `@ Files & folders` chips have.
 */
export interface ReferenceInsertLike {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly clipboardText: string
}

/**
 * The `ReferenceInsert` this source produces on pick (and on button click).
 *
 * The label is resolved against the host UI language at call time, so the chip
 * that lands in the composer reads in the language the user is currently in.
 */
export function schematicGenInsert(lang?: HostLocale): ReferenceInsertLike {
  const insert = {
    source: SCHEMATIC_GEN_SOURCE,
    ref: SCHEMATIC_GEN_REF,
    label: schematicGenLabel(lang),
    clipboardText: SCHEMATIC_GEN_CLIPBOARD,
  }
  trace('insert', insert)
  return insert
}

/** Structural view of one `@` menu candidate (DSH `InputTriggerCandidate`). */
export interface CandidateLike {
  readonly name: string
  readonly description?: string
}

/** Structural view of the DSH trigger-source registry (`ctx.inputTriggers`). */
export interface InputTriggerRegistryLike {
  registerSource(src: unknown): () => void
}

/** The source as DSH expects it (structurally typed). */
export interface SchematicGenSource {
  readonly trigger: string
  readonly name: string
  readonly order: number
  readonly showGroupTitle: boolean
  candidates(): Promise<readonly CandidateLike[]>
  onPick(): { readonly insert: ReferenceInsertLike }
  codec: {
    clipboardText(ref: string): string
    serialize(ref: string, signal: unknown): Promise<string>
  }
}

/**
 * Build the source object. Pure — nothing here touches the DOM or the
 * composer, so it is fully unit-testable.
 *
 * `getLang` defaults to the host `<html lang>` read and is called fresh on
 * every `candidates()` / `onPick()`, so a language change takes effect without
 * re-registering the source (and without a locale-service dependency). It is a
 * parameter so tests can pin the language without a DOM.
 *
 * @param extraCandidates - optional extra rows merged ahead of the built-in one.
 * @returns the source, ready for `registerSource`.
 */
export function createSchematicGenSource(
  extraCandidates: readonly CandidateLike[] = [],
  getLang: () => HostLocale | undefined = detectHostLocale,
): SchematicGenSource {
  return {
    trigger: SCHEMATIC_GEN_TRIGGER,
    name: SCHEMATIC_GEN_SOURCE,
    order: SCHEMATIC_GEN_ORDER,
    showGroupTitle: true,
    candidates: () => {
      const lang = getLang()
      const rows = [
        ...extraCandidates,
        {
          name: schematicGenLabel(lang),
          description: schematicGenDescription(lang),
        },
      ]
      trace('candidates', rows)
      return Promise.resolve(rows)
    },
    onPick: () => {
      const insert = schematicGenInsert(getLang())
      trace('onPick', insert)
      return { insert }
    },
    codec: {
      clipboardText: () => SCHEMATIC_GEN_CLIPBOARD,
      serialize: () => Promise.resolve(SCHEMATIC_GEN_SERIALIZED),
    },
  }
}

/**
 * Register the source and return its disposer.
 *
 * Never throws: a missing service, a duplicate registration (a second live
 * copy of this plugin) or a throwing registry must not take the whole client
 * half down. Without a registered source the sidebar button degrades to
 * inserting nothing rather than producing a chip that would block submission.
 * @param registry - `ctx.get('inputTriggers')`, or undefined.
 * @returns disposer (a no-op when registration did not happen).
 */
export function registerSchematicGenSource(registry: unknown): () => void {
  if (
    registry === undefined || registry === null ||
    typeof (registry as InputTriggerRegistryLike).registerSource !== 'function'
  ) {
    return () => {}
  }
  try {
    const dispose = (registry as InputTriggerRegistryLike).registerSource(createSchematicGenSource())
    return typeof dispose === 'function' ? dispose : () => {}
  } catch {
    // Already registered (duplicate trigger/name) — the existing owner keeps
    // serving our chips, which is the correct outcome.
    return () => {}
  }
}

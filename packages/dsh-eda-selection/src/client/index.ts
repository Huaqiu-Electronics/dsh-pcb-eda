/**
 * `@huaqiu/dsh-eda-selection` — browser half.
 *
 * Contributes ONE entry to the public `conversation.input.dock` slot: an
 * ambient `Current selection · N items (editor)` chip that appears above the
 * composer whenever the FOCUSED KiCad editor has a selection, and disappears
 * the moment it does not.
 *
 * ── Where the state comes from ──────────────────────────────────────────────
 * The `hqEdge` host service provided by `@hqedge/dsh-edge-bridge`. Its
 * `selection` face is fed by the bridge's OWN `/runtime/dsh` poll, so this
 * plugin adds NO second polling loop and never talks to HQ Edge itself.
 *
 * `inject` declares `hqEdge`, so DSH holds this plugin's activation until the
 * bridge has provided it — `ctx.get('hqEdge')` inside `apply()` therefore
 * resolves. The accessor is still built lazily (a closure, not a captured
 * value) because the service object is created once but its `selection` face
 * is read on every subscription.
 *
 * The bridge's `onChanged` replays the current state immediately when one is
 * already known, so a chip mounted after the first summary does not wait for a
 * change; and it returns a disposer, which is what the slot's own lifecycle
 * expects.
 *
 * ── Unknown vs known-empty ──────────────────────────────────────────────────
 * `hqEdge.selection.getCurrent()` returns `null` when the state is UNKNOWN
 * (nothing published yet, or the sync failed). That is NOT a selection, and
 * the chip renders nothing for it — a chip must never appear on screen that
 * the host does not currently back.
 *
 * ── No second composer ──────────────────────────────────────────────────────
 * This entry never touches the draft, the input state, or the reference
 * pipeline. It is a read-only projection of host state; the agent reaches the
 * real selection through the existing EDA selection tools.
 *
 * @module @huaqiu/dsh-eda-selection/client
 */
import { createElement, useEffect, useState, type ReactElement } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SelectionChip } from './SelectionChip.js'
import { en, zh, type EdaSelectionKey } from './locales.js'
import {
  normalizeSelectionSnapshot,
  type HqEdgeLike,
  type SelectionSnapshot,
} from './hq-edge.js'

export const inject = ['slots', 'locale', 'hqEdge'] as const

/** This plugin's dictionary namespace. */
export const EDA_SELECTION_NS = 'huaqiu:eda-selection'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'huaqiu:eda-selection': EdaSelectionKey
  }
}

/**
 * Minimal structural client context (the DSH client runtime provides these
 * faces). Declared structurally, never imported, so the package stays
 * independently installable — the same pattern as
 * `@huaqiu/dsh-tool-schematic-gen` and `@huaqiu/dsh-huaqiu-about`.
 */
export interface ClientContext {
  slots?: {
    inject(key: string, callback: () => () => void): () => void
    register(
      spec: {
        name: string
        id?: string
        order?: number
        label?: () => string
        locale?: string
      },
      component: unknown,
    ): () => void
  }
  locale?: {
    register(namespace: string, dictionaries: unknown): unknown
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
  }
  get<T = unknown>(name: string): T | undefined
  effect?(fn: () => (() => void) | void, label?: string): void
}

/** Translation function shape (the locale service's `bind` result). */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/**
 * Resolve the `hqEdge` service defensively.
 *
 * `inject` already guarantees it exists by `apply()` time; the try/catch and
 * the shape checks keep a standalone DSH (no edge-bridge) from taking the
 * plugin down. In that case the chip simply never renders.
 */
function getHqEdge(ctx: ClientContext): HqEdgeLike | undefined {
  try {
    const edge = ctx.get<HqEdgeLike | undefined>('hqEdge')
    if (!edge || !edge.selection || typeof edge.selection.getCurrent !== 'function') return undefined
    return edge
  } catch {
    return undefined
  }
}

/** Browser-console tag — greppable so the sync loop can be traced end to end. */
const TRACE = '[dsh-eda-selection]'

/**
 * Emit one line describing a snapshot the dock received.
 *
 * The chip is the last hop of a four-stage chain (KiCad selection tool → gRPC
 * `SubscribeSelection` → hq-edge `SelectionWatcher` → `/runtime/dsh` poll →
 * this component), and a blank chip can originate at any of them. Logging
 * what arrived here is what separates "the host never published" from "the
 * state arrived but was not renderable".
 *
 * Never throws and never blocks render: a host console that is not a real
 * console (or one that rejects the object) must not take the composer down.
 */
function traceSnapshot(where: string, snapshot: SelectionSnapshot | null): void {
  try {
    // eslint-disable-next-line no-console
    console.debug(
      TRACE,
      where,
      snapshot === null
        ? 'unknown'
        : {
            revision: snapshot.revision,
            editor: snapshot.editor,
            hasSelection: snapshot.hasSelection,
            itemCount: snapshot.itemCount,
            labels: snapshot.labels,
            // The gate the chip applies — `hasSelection && itemCount > 0`. A
            // state that arrives but fails this is the "no chip, but not
            // because the sync broke" case.
            renderable: snapshot.hasSelection && snapshot.itemCount > 0,
          },
    )
  } catch {
    /* a non-console host must never break the composer */
  }
}

/**
 * Read and normalize the current snapshot from the bridge.
 *
 * The bridge already normalizes; re-normalizing here keeps this plugin honest
 * when pointed at an older bridge (or a test double) that does not.
 */
function readSnapshot(edge: HqEdgeLike | undefined): SelectionSnapshot | null {
  if (!edge) return null
  try {
    return normalizeSelectionSnapshot(edge.selection?.getCurrent())
  } catch {
    return null
  }
}

export interface SelectionDockProps {
  /** Bound dictionary, injected by the client entry. */
  t: Translate
  /** Lazy bridge accessor — a closure over `ctx`, never a captured value. */
  getEdge: () => HqEdgeLike | undefined
}

/**
 * The dock component: subscribes to the bridge and renders the chip.
 *
 * A hook rather than a plain read, because the snapshot arrives asynchronously
 * (the bridge's first poll lands after this component mounts).
 */
export function SelectionDock({ t, getEdge }: SelectionDockProps): ReactElement | null {
  const [snapshot, setSnapshot] = useState<SelectionSnapshot | null>(null)

  useEffect(() => {
    const edge = getEdge()

    // No bridge (standalone DSH) or a bridge without the selection face
    // (older edge-bridge): render nothing, permanently. Not an error.
    if (!edge || typeof edge.selection?.onChanged !== 'function') {
      traceSnapshot('mount: no bridge selection face — nothing will render', null)
      setSnapshot(null)
      return
    }

    // `onChanged` replays the current state immediately when one is known, so
    // this read is only needed for the unknown-at-mount case.
    const initial = readSnapshot(edge)
    traceSnapshot('mount', initial)
    setSnapshot(initial)

    let alive = true
    const dispose = edge.selection.onChanged((next) => {
      if (!alive) return
      // Normalize on the way in too: a listener must never be handed a shape
      // it did not expect, whatever the bridge did.
      const normalized = normalizeSelectionSnapshot(next)
      traceSnapshot('onChanged', normalized)
      setSnapshot(normalized)
    })

    return () => {
      alive = false
      dispose()
    }
  }, [getEdge])

  return createElement(SelectionChip, { snapshot, t })
}

/**
 * Install the dock entry on the running client context.
 *
 * Never throws: a deployment without the slot service, the locale service, or
 * the `hqEdge` bridge must still load — it simply shows no chip.
 */
export function apply(ctx: ClientContext): void {
  // Dictionaries first, so the first render already has localized text. The
  // untyped register form is used because this namespace is declared by this
  // package (not by DSH), which keeps DSH core untouched.
  const locale = ctx.locale
  if (locale && typeof locale.register === 'function') {
    try {
      locale.register(EDA_SELECTION_NS, { zh, en })
    } catch {
      // A duplicate registration (hot reload, double mount) is not fatal —
      // the first registration's dictionaries are already live.
    }
  }

  const t: Translate =
    locale && typeof locale.bind === 'function'
      ? locale.bind(EDA_SELECTION_NS)
      : (key: string) => key

  const getEdge = (): HqEdgeLike | undefined => getHqEdge(ctx)

  const slots = ctx.slots
  if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
    return
  }

  ctx.effect?.(
    () =>
      slots.inject('conversation.input.dock', () =>
        slots.register(
          {
            name: 'conversation.input.dock',
            // Our own id: a fresh id is added BESIDE the shipped entries
            // (queue / todo / goal) instead of replacing one of them.
            id: 'eda-selection',
            // Ascending among the dock entries. `queue` is 20 and `todo` is 0,
            // so 5 puts the ambient chip near the top — closest to the composer
            // it describes — without displacing the todo dock at 0.
            order: 5,
            label: () => t('dock.label'),
            locale: EDA_SELECTION_NS,
          },
          () => createElement(SelectionDock, { t, getEdge }),
        ),
      ),
    'huaqiu eda-selection: composer dock chip',
  )
}

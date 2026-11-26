/**
 * First-run toolchain onboarding, riding DSH's `settings.onboarding` seat.
 *
 * The seat, not the right panel, owns first run: a blank first session mounts
 * exactly one ordered step, and the step draws its own modal surface because the
 * shell paints no chrome. That is also why the step renders **nothing** until the
 * Host has answered — a mounted-but-deciding step must show and block nothing.
 *
 * The modal follows `docs/prototype/huaqiu_eda_hardware_toolchain_ux_prototype.html`
 * line for line: header (H badge, "Welcome to HuaQiu EDA Agent" + a "First-Time
 * Setup" pill, close button), the blue callout, one card per tool, and a footer
 * that says where the settings live with `Skip for Now` / `Save & Get Started`.
 *
 * Two hard-won rules are encoded here:
 *   - **Never mark `#root` inert.** The slot renders *inside* `#root`, so inerting
 *     the root froze the whole application — including this modal — on every
 *     launch and every reload. The backdrop alone is enough to own the pointer.
 *   - **Never subscribe to a form snapshot that is rebuilt per call.** The Host
 *     form returns a fresh object from `getSnapshot()`, so feeding it straight to
 *     `useSyncExternalStore` re-rendered forever. {@link useFormValue} keeps a
 *     stable local copy instead.
 *
 * Gating (§4.6) is a pure function so the "must not reopen on every start"
 * promise stays testable: deferred and completed both stop the step from
 * returning. Skipping marks `toolchainSetup = 'deferred'`, not `'complete'` — the
 * setup is still missing, so the sidebar dot and Settings keep saying so; it
 * merely stops interrupting.
 *
 * @module @huaqiu/dsh-hardware-ui/client/wizard
 */
import { createElement, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { HUAQIU_LOGO_SRC } from './brand.js'
import { COPY } from './copy.js'
import type { ConfigFormLike, HardwareInstallationConfig } from './model.js'
import { ToolchainCard, TOOLCHAIN_ICONS } from './toolchain-view.js'
import {
  setupComplete, type ToolchainController, type ToolchainId, type ToolchainSnapshot, type ToolchainStatus,
} from './toolchain.js'
import { buttonStyle, C, disabled, MUTED, R } from './theme.js'

/** Step id claimed on `settings.onboarding`; also the launcher's `openOnboarding(id)`. */
export const TOOLCHAIN_ONBOARDING_STEP = 'hardware-engineering-toolchain'

/** Both cards, in prototype order. */
const TOOLCHAIN_IDS: readonly ToolchainId[] = ['kicad', 'solidcraft']

/** What the seat's registrant receives: the shell's own props plus our face. */
export interface OnboardingProps {
  /** Shell: the step currently selected by the coordinator. */
  readonly stepId?: string
  /** Shell: reopened explicitly from the launcher (not first run). */
  readonly explicit?: boolean
  /** Shell: hand ownership back to the next entry. */
  readonly complete?: () => void
  readonly toolchain?: ToolchainController
  /** The Host-backed config form, used to persist the skip flag. */
  readonly configForm?: () => ConfigFormLike<HardwareInstallationConfig> | undefined
}

/** How the step resolves for one render. */
export type OnboardingPhase =
  /** No controller (a Host without the capability) — nothing may paint. */
  | 'no-controller'
  /** The Host has not answered yet: render null, decide nothing. */
  | 'waiting'
  /** Show the modal. */
  | 'open'
  /** Both tools already validate: complete silently, no modal. */
  | 'configured'
  /** Previously completed or skipped: stay away. */
  | 'dismissed'

/**
 * Decide whether the step may mount, without guessing.
 *
 * The regression this guards is the flash: the previous panel-mounted wizard
 * decided on initial `loading`/`undefined` values and appeared before the status
 * was known. Here `waiting` renders null, and only a definite "incomplete"
 * answer yields `open`.
 */
export function onboardingPhase(input: {
  readonly hasController: boolean
  readonly status?: ToolchainStatus
  readonly loading: boolean
  readonly setup?: string
}): OnboardingPhase {
  if (!input.hasController) return 'no-controller'
  // `toolchainSetup` is the only record of what the first-run step was told:
  // `complete` and `deferred` both mean "never interrupt again". The old
  // `onboardingComplete` boolean is deliberately not honoured — this product is
  // still in internal test, and one source of truth is worth more than the
  // compatibility. A profile that only carries the legacy flag is treated as
  // unanswered.
  if (input.setup === 'complete' || input.setup === 'deferred') return 'dismissed'
  if (input.status === undefined || input.loading) return 'waiting'
  if (setupComplete(input.status)) return 'configured'
  return 'open'
}

/**
 * May the footer's primary button submit?
 *
 * The prototype's wizard card carries no per-card validate control, so this
 * button is the step's *only* way to persist a typed path. Gating it on "both
 * tools already configured" made a clean first launch a dead end: nothing could
 * be configured because the button that configures was disabled. Readiness is
 * therefore "there is something to save".
 */
export function saveReady(snapshot: ToolchainSnapshot): boolean {
  if (snapshot.saving !== undefined) return false
  if (TOOLCHAIN_IDS.some(id => (snapshot.drafts[id] ?? '').trim() !== '')) return true
  return snapshot.status === undefined
    ? false
    : TOOLCHAIN_IDS.some(id => snapshot.status![id].state === 'configured')
}

/** Fields of the stored configuration this step reacts to. */function sameConfig(left: HardwareInstallationConfig | undefined, right: HardwareInstallationConfig | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  return left.kicadRoot === right.kicadRoot
    && left.solidcraftRoot === right.solidcraftRoot
    && left.toolchainSetup === right.toolchainSetup
}

/**
 * The form's value, read through a *stable* snapshot.
 *
 * `form.getSnapshot()` allocates a new object on every call; handing that straight
 * to `useSyncExternalStore` makes React see a changed store on every render and
 * spin. Keeping the last value in local state, and replacing it only when a
 * relevant field actually moved, is what makes this safe.
 */
function useFormValue(form: ConfigFormLike<HardwareInstallationConfig> | undefined): HardwareInstallationConfig | undefined {
  const [value, setValue] = useState<HardwareInstallationConfig | undefined>(() => form?.getSnapshot().value)
  useEffect(() => {
    if (form === undefined) {
      setValue(undefined)
      return
    }
    const read = (): void => {
      const next = form.getSnapshot().value
      setValue(previous => (sameConfig(previous, next) ? previous : next))
    }
    read()
    return form.subscribe(read)
  }, [form])
  return value
}

const BACKDROP: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center',
  justifyContent: 'center', padding: 16, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(2px)',
}

const HEADER: CSSProperties = {
  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16,
  padding: '20px 22px 14px', borderBottom: `1px solid ${C.borderSoft}`,
  background: 'linear-gradient(90deg, #241B1C 0%, #1C1C1E 100%)', borderRadius: `${R.lg}px ${R.lg}px 0 0`,
}

const CALLOUT: CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 10, padding: 12, borderRadius: R.md,
  background: 'rgba(59,130,246,0.10)', border: '1px solid rgba(59,130,246,0.22)',
  color: '#BFDBFE', fontSize: 11, lineHeight: 1.6,
}

const FOOTER: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
  padding: '14px 22px', borderTop: `1px solid ${C.borderSoft}`, background: '#161618',
  borderRadius: `0 0 ${R.lg}px ${R.lg}px`,
}

/** Small line icon, same drawing rules as the cards. */
function Glyph(props: { readonly path: string; readonly size?: number; readonly color?: string; readonly extra?: string }): ReactNode {
  return createElement(
    'svg',
    {
      viewBox: '0 0 24 24', width: props.size ?? 14, height: props.size ?? 14, 'aria-hidden': true,
      style: { flex: '0 0 auto', color: props.color ?? 'inherit' },
    },
    createElement('path', {
      d: props.path, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
    }),
    ...(props.extra === undefined
      ? []
      : [createElement('path', {
          d: props.extra, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        })]),
  )
}

/** Stable empty snapshot for the no-controller case (identity must not churn). */
const EMPTY: ToolchainSnapshot = { loading: true, jobs: {}, drafts: { kicad: '', solidcraft: '' }, toasts: [] }
const emptySnapshot = (): ToolchainSnapshot => EMPTY

/**
 * The step itself.
 *
 * `complete()` is the shell's own hand-back; the plugin additionally records
 * `toolchainSetup` so a later launch knows the difference between "configured"
 * and "the user said not now".
 */
export function ToolchainOnboarding(props: OnboardingProps): ReactNode {
  const controller = props.toolchain
  const form = props.configForm?.()
  const value = useFormValue(form)
  const snapshot = useSyncExternalStore<ToolchainSnapshot>(
    controller === undefined ? (): (() => void) => () => {} : controller.subscribe,
    controller === undefined ? emptySnapshot : controller.getSnapshot,
    controller === undefined ? emptySnapshot : controller.getSnapshot,
  )
  const autoCompleted = useRef(false)
  const phase = onboardingPhase({
    hasController: controller !== undefined,
    ...(snapshot.status === undefined ? {} : { status: snapshot.status }),
    loading: snapshot.loading,
    ...(value?.toolchainSetup === undefined ? {} : { setup: value.toolchainSetup }),
  })

  const persist = async (patch: Partial<HardwareInstallationConfig>): Promise<void> => {
    for (const [field, entry] of Object.entries(patch)) {
      await form?.set(field, entry)
    }
  }

  // §4.7: both tools configured means the step has nothing left to ask, so it
  // completes itself the moment the Host confirms — the user never sees a
  // redundant "Save & Get Started".
  const complete = props.complete
  useEffect(() => {
    if (phase !== 'configured' || autoCompleted.current) return
    autoCompleted.current = true
    void persist({ toolchainSetup: 'complete' }).then(() => complete?.())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  if (phase !== 'open' || controller === undefined) return null

  const skip = async (): Promise<void> => {
    await persist({ toolchainSetup: 'deferred' })
    controller.toast('info', COPY.toolchain.toastSkipped)
    props.complete?.()
  }

  const save = async (): Promise<void> => {
    // The footer's primary button is this step's only save affordance (the
    // prototype has no per-card validate), so it must persist what is typed:
    // each path is validated and written through the Host first, and a rejected
    // path leaves the modal open with the Host's reason already toasted.
    for (const id of TOOLCHAIN_IDS) {
      const path = (snapshot.drafts[id] ?? '').trim()
      if (path === '') continue
      const outcome = await controller.save(id, path)
      if (!outcome.ok) return
    }
    await persist({ toolchainSetup: 'complete' })
    props.complete?.()
  }

  // Ready means "there is something worth saving": a typed path, or a tool that
  // is already configured (so pressing the button simply ends the step). It is
  // *not* "everything is configured" — SolidCraft is optional, and a disabled
  // primary button with no other way to submit was a dead end.
  const ready = saveReady(snapshot)

  return createElement(
    'div',
    {
      style: BACKDROP,
      role: 'dialog',
      'aria-modal': true,
      'aria-label': COPY.toolchain.onboardingAria,
      'data-hardware-toolchain-onboarding': true,
    },
    createElement(
      'div',
      {
        style: {
          display: 'flex', flexDirection: 'column', width: 672, maxWidth: '100%', maxHeight: '92vh',
          background: '#1C1C1E', border: '1px solid rgba(255,255,255,0.15)', borderRadius: R.lg,
          boxShadow: '0 24px 64px rgba(0,0,0,0.5)', overflow: 'hidden',
        },
      },
      // Header: the HuaQiu mark (`assets/huaqiu.svg`, inlined in `brand.ts`), title,
      // First-Time Setup pill, close.
      createElement(
        'div',
        { style: HEADER },
        createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 } },
          createElement('img', {
            src: HUAQIU_LOGO_SRC,
            alt: '',
            'aria-hidden': true,
            width: 40,
            height: 40,
            // The vendor file draws its own rounded frame; the tile adds no colour of
            // its own so the shipped mark is what the user sees.
            style: { width: 40, height: 40, flex: '0 0 auto', display: 'block' },
          }),
          createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
            createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              createElement('h2', { style: { margin: 0, fontSize: 15, fontWeight: 600, color: C.text } }, COPY.wizard.title),
              createElement('span', {
                style: {
                  fontSize: 10, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase',
                  padding: '2px 8px', borderRadius: 999, color: C.accent,
                  background: 'rgba(198,58,62,0.20)', border: `1px solid rgba(198,58,62,0.35)`,
                },
              }, COPY.wizard.badge),
            ),
            createElement('p', { style: { ...MUTED, margin: 0, lineHeight: 1.5 } }, COPY.wizard.lead),
          ),
        ),
        createElement('button', {
          type: 'button',
          title: COPY.wizard.skip,
          'aria-label': COPY.wizard.skip,
          onClick: () => { void skip() },
          style: { ...buttonStyle('quiet', { padding: 6 }), flex: '0 0 auto' },
        }, createElement(Glyph, { path: TOOLCHAIN_ICONS.close, size: 16 })),
      ),

      // Body: callout + one card per tool.
      createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14, padding: 22, overflowY: 'auto' } },
        createElement(
          'div',
          { style: CALLOUT },
          createElement(Glyph, {
            path: TOOLCHAIN_ICONS.info, size: 16, color: '#60A5FA', extra: 'M12 3a9 9 0 1018 0 9 9 0 00-18 0z',
          }),
          createElement('div', { style: { minWidth: 0 } }, COPY.wizard.callout),
        ),
        createElement(ToolchainCard, { tool: 'kicad', controller, snapshot, variant: 'wizard' }),
        createElement(ToolchainCard, { tool: 'solidcraft', controller, snapshot, variant: 'wizard' }),
      ),

      // Footer: where the settings live, then Skip / Save & Get Started.
      createElement(
        'div',
        { style: FOOTER },
        createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, ...MUTED, minWidth: 0 } },
          createElement(Glyph, { path: TOOLCHAIN_ICONS.gear, color: C.text3 }),
          createElement('span', { style: { minWidth: 0 } }, COPY.wizard.footer),
        ),
        createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, flex: '0 0 auto' } },
          createElement('button', {
            type: 'button',
            style: buttonStyle('quiet'),
            onClick: () => { void skip() },
          }, COPY.wizard.skip),
          createElement('button', {
            type: 'button',
            style: { ...buttonStyle('primary', { padding: '8px 16px', fontSize: 12, fontWeight: 600 }), ...disabled(!ready) },
            disabled: !ready,
            onClick: () => { void save() },
          }, COPY.wizard.save),
        ),
      ),
    ),
  )
}

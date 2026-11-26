/**
 * First-run toolchain onboarding, riding DSH's `settings.onboarding` seat.
 *
 * The seat, not the right panel, owns first run: a blank first session mounts
 * exactly one ordered step, and the step is expected to draw its own modal
 * surface (including `#root` inert ownership) because the shell paints no
 * chrome. That is why this module renders nothing at all until the Host has
 * answered — a mounted-but-deciding step must show and block nothing — and why
 * it never shows the two cards twice: the same {@link ToolchainCard} used by
 * Settings is rendered here.
 *
 * Gating (§4.6) is a pure function so the "must not reopen on every start"
 * promise is testable: deferred and completed both stop the step from returning.
 * Skipping marks `toolchainSetup = 'deferred'`, not `'complete'` — the setup is
 * still missing, so the sidebar dot and the Settings panel keep saying so; it
 * merely stops interrupting.
 *
 * @module @huaqiu/dsh-hardware-ui/client/wizard
 */
import { createElement, useEffect, useRef, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { COPY } from './copy.js'
import type { ConfigFormLike, HardwareInstallationConfig } from './model.js'
import { ToolchainCard } from './toolchain-view.js'
import {
  setupComplete, type ToolchainController, type ToolchainSnapshot, type ToolchainStatus,
} from './toolchain.js'
import { buttonStyle, C, cardStyle, disabled, MUTED, MONO } from './theme.js'

/** Step id claimed on `settings.onboarding`; also the launcher's `openOnboarding(id)`. */
export const TOOLCHAIN_ONBOARDING_STEP = 'hardware-engineering-toolchain'

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
 * decided on initial `loading`/`undefined` values and appeared before the
 * status was known. Here `waiting` renders null, and only a definite
 * "incomplete" answer yields `open`.
 */
export function onboardingPhase(input: {
  readonly hasController: boolean
  readonly status?: ToolchainStatus
  readonly loading: boolean
  readonly setup?: string
  readonly onboardingComplete?: boolean
}): OnboardingPhase {
  if (!input.hasController) return 'no-controller'
  if (input.setup === 'complete' || input.setup === 'deferred') return 'dismissed'
  // Legacy configs only carried the boolean: honour it instead of re-interrupting.
  if (input.onboardingComplete === true) return 'dismissed'
  if (input.status === undefined || input.loading) return 'waiting'
  if (setupComplete(input.status)) return 'configured'
  return 'open'
}

/** The config form's live value, without a React dependency at module scope. */
function useFormSnapshot(form: ConfigFormLike<HardwareInstallationConfig> | undefined): HardwareInstallationConfig | undefined {
  const empty = (): { value?: HardwareInstallationConfig } => ({})
  return useSyncExternalStore<{ value?: HardwareInstallationConfig }>(
    form === undefined ? () => () => {} : listener => form.subscribe(listener),
    form === undefined ? empty : () => form.getSnapshot(),
    form === undefined ? empty : () => form.getSnapshot(),
  ).value
}

const BACKDROP: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center',
  justifyContent: 'center', padding: 24, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)',
}

const TITLE: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600, color: C.text }

/**
 * The `<style>` the pulse needs.
 *
 * A keyframe cannot be expressed in an inline style, and this bundle ships no
 * stylesheet, so the one animation the product needs is declared here inside the
 * modal it belongs to and removed with it.
 */
const PULSE = '@keyframes hw-toolchain-pulse{0%,100%{opacity:1}50%{opacity:.55}}'

/** Stable empty snapshot for the no-controller case (identity must not churn). */
const EMPTY: ToolchainSnapshot = { loading: true, drafts: { kicad: '', solidcraft: '' }, toasts: [] }
const emptySnapshot = (): ToolchainSnapshot => EMPTY

/** The step itself.
 *
 * `complete()` is the shell's own hand-back; the plugin additionally records
 * `toolchainSetup` so a later launch knows the difference between "configured"
 * and "the user said not now".
 */
export function ToolchainOnboarding(props: OnboardingProps): ReactNode {
  const controller = props.toolchain
  const form = props.configForm?.()
  const value = useFormSnapshot(form)
  const subscribe = controller === undefined ? (): (() => void) => () => {} : controller.subscribe
  const snapshot = useSyncExternalStore<ToolchainSnapshot>(
    subscribe,
    controller === undefined ? emptySnapshot : controller.getSnapshot,
    controller === undefined ? emptySnapshot : controller.getSnapshot,
  )
  const shown = useRef(false)
  const phase = onboardingPhase({
    hasController: controller !== undefined,
    ...(snapshot.status === undefined ? {} : { status: snapshot.status }),
    loading: snapshot.loading,
    ...(value?.toolchainSetup === undefined ? {} : { setup: value.toolchainSetup }),
    ...(value?.onboardingComplete === undefined ? {} : { onboardingComplete: value.onboardingComplete }),
  })

  const persist = async (patch: Partial<HardwareInstallationConfig>): Promise<void> => {
    for (const [field, entry] of Object.entries(patch)) {
      await form?.set(field, entry)
    }
  }

  // §4.7: both tools configured means the step has nothing left to ask, so it
  // completes itself the moment the Host confirms — the user never sees a
  // redundant "Done".
  useEffect(() => {
    if (phase !== 'configured' || shown.current) return
    shown.current = true
    void persist({ toolchainSetup: 'complete', onboardingComplete: true }).then(() => props.complete?.())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // The step owns the modal mask, so it also owns `#root`'s inert flag: the
  // shell deliberately paints no chrome and marks nothing.
  const visible = phase === 'open'
  useEffect(() => {
    if (!visible) return
    const root = document.getElementById('root')
    if (root === null) return
    root.setAttribute('inert', '')
    return () => { root.removeAttribute('inert') }
  }, [visible])

  if (!visible || controller === undefined) return null

  const skip = async (): Promise<void> => {
    await persist({ toolchainSetup: 'deferred', onboardingComplete: true })
    controller.toast('info', COPY.toolchain.toastSkipped)
    props.complete?.()
  }

  const done = async (): Promise<void> => {
    await persist({ toolchainSetup: 'complete', onboardingComplete: true })
    props.complete?.()
  }

  const complete = snapshot.status === undefined ? false : setupComplete(snapshot.status)

  return createElement(
    'div',
    {
      style: BACKDROP,
      role: 'dialog',
      'aria-modal': true,
      'aria-label': COPY.toolchain.onboardingAria,
      'data-hardware-toolchain-onboarding': true,
    },
    createElement('style', { dangerouslySetInnerHTML: { __html: PULSE } }),
    createElement(
      'div',
      { style: cardStyle({ gap: 12, width: 620, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', padding: 16 }) },
      createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        createElement('h2', { style: TITLE }, COPY.toolchain.onboardingTitle),
        createElement('p', { style: MUTED }, COPY.toolchain.onboardingLead),
      ),
      createElement(ToolchainCard, { tool: 'kicad', controller, snapshot, compact: true }),
      createElement(ToolchainCard, { tool: 'solidcraft', controller, snapshot, compact: true }),
      createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingTop: 2 } },
        createElement('span', { style: { ...MUTED, fontFamily: MONO, fontSize: 10 } }, COPY.toolchain.footNote),
        createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          createElement('button', { type: 'button', style: buttonStyle('quiet'), onClick: () => { void skip() } },
            COPY.toolchain.skip),
          createElement('button', {
            type: 'button',
            style: { ...buttonStyle('primary'), ...disabled(!complete) },
            disabled: !complete,
            onClick: () => { void done() },
          }, COPY.toolchain.finish),
        ),
      ),
    ),
  )
}

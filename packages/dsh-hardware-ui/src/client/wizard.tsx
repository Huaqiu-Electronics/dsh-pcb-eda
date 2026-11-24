/**
 * First-run setup wizard.
 *
 * Rendered from the root navigation seat so it can appear before any session
 * exists. It only guides the user towards a local KiCad/SolidCraft executable:
 * everything on it is skippable, and completion is recorded in the host-backed
 * product config (`onboardingComplete`) rather than in browser storage.
 *
 * It is a full-screen modal, so it must never mount on a guess. Both facts it
 * depends on arrive asynchronously — the host's synced config (is onboarding
 * recorded?) and one local install probe (is KiCad already usable?) — and
 * {@link wizardPhase} refuses to decide until they are known. Deciding on the
 * initial `loading`/`undefined` values is what made the wizard flash on first
 * launch and on every browser refresh: it mounted, then unmounted a frame later
 * when the real answer landed.
 */
import {
  createElement, useEffect, useMemo, useState, useSyncExternalStore,
  type CSSProperties, type ReactNode,
} from 'react'
import type { HardwareInstallationConfig, InstallationsInfo } from './model.js'
import type { HardwareProps } from './components.js'
import { buttonStyle, C, dotStyle, INPUT, MUTED, MONO_TEXT, pillStyle, R } from './theme.js'

const BACKDROP: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 16, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)',
}
const PANEL: CSSProperties = {
  width: 'min(520px, 100%)', maxHeight: '85vh', overflow: 'auto', borderRadius: R.lg, padding: 16,
  display: 'flex', flexDirection: 'column', gap: 12,
  color: C.text,
  background: C.panel,
  border: `1px solid ${C.border}`,
  boxShadow: '0 28px 70px rgba(0,0,0,0.55)',
  fontSize: 12, lineHeight: 1.5,
}
const TITLE: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: 0.1 }
const LEAD: CSSProperties = { margin: 0, fontSize: 11.5, lineHeight: 1.6, color: C.text2 }
const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const SPREAD: CSSProperties = { ...ROW, justifyContent: 'space-between' }
const STEP_LABEL: CSSProperties = { fontSize: 10, color: C.text3 }
const BRAND_MARK: CSSProperties = {
  width: 26, height: 26, borderRadius: R.sm, display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 11, fontWeight: 700, color: '#fff', background: C.accent,
  boxShadow: '0 4px 14px rgba(225,27,27,0.35)', flex: '0 0 auto',
}
const FIELD_CARD: CSSProperties = {
  border: `1px solid ${C.borderSoft}`, borderRadius: R.md, background: C.base, padding: 10,
  display: 'flex', flexDirection: 'column', gap: 6,
}

const STEPS = ['Welcome', 'KiCad', 'SolidCraft'] as const

/**
 * Dismissal remembered for the life of this client bundle, not one mount.
 *
 * The navigation seat is remounted by the framework (a conversation switch, a
 * slot refresh), so component state alone lets a just-closed wizard come back
 * for a frame while the host config write is still in flight. A browser refresh
 * reloads the bundle, so the host config stays the only cross-session source of
 * truth and this cannot outlive the tab.
 */
let dismissedInClient = false

/**
 * How the wizard resolves for one render.
 *
 * `waiting` and `no-form` render nothing, exactly like `completed`; they exist
 * so the reason a modal is absent is testable instead of being implicit in an
 * `if` chain.
 */
export type WizardPhase =
  /** No host config form: there is nowhere to record completion. */
  | 'no-form'
  /** Config sync or the install probe has not answered yet. */
  | 'waiting'
  /** The host already recorded completion or a skip. */
  | 'completed'
  /** KiCad validates now, so first-run setup has nothing left to ask. */
  | 'configured'
  /** Closed in this browser session. */
  | 'dismissed'
  /** Render it. */
  | 'open'

/**
 * Decide whether the wizard may mount, without guessing.
 *
 * Order matters: a completed onboarding needs no probe, so it must not wait on
 * one; a `loading` config must not fall through to "not completed", which is the
 * flash this function exists to prevent.
 */
export function wizardPhase(input: {
  readonly hasForm: boolean
  /** `ConfigFormSnapshot.status`; `loading` until the host answered once. */
  readonly status?: string
  readonly onboardingComplete: boolean
  /** KiCad readiness; `undefined` while the probe is still in flight. */
  readonly kicadConfigured?: boolean | undefined
  readonly dismissed: boolean
}): WizardPhase {
  if (!input.hasForm) return 'no-form'
  if (input.dismissed) return 'dismissed'
  if (input.status === 'loading') return 'waiting'
  if (input.onboardingComplete) return 'completed'
  if (input.kicadConfigured === undefined) return 'waiting'
  return input.kicadConfigured ? 'configured' : 'open'
}

export function OnboardingWizard(props: HardwareProps): ReactNode {
  const { actions, configForm, saveInstallation, installations, useStore } = props
  const installed = useStore(state => state.installations)
  const form = configForm()
  const empty = useMemo<{ value?: HardwareInstallationConfig; status?: string }>(() => ({}), [])
  const snapshot = useSyncExternalStore<{ value?: HardwareInstallationConfig; status?: string }>(
    form === undefined ? () => () => {} : listener => form.subscribe(listener),
    form === undefined ? () => empty : () => form.getSnapshot(),
    form === undefined ? () => empty : () => form.getSnapshot(),
  )

  const [step, setStep] = useState(0)
  const [closed, setClosed] = useState(dismissedInClient)
  const [kicadRoot, setKicadRoot] = useState('')
  const [solidcraftRoot, setSolidcraftRoot] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  /**
   * This seat's own install probe: `undefined` while in flight, `null` when it
   * failed (the wizard stays usable, paths can be typed). A result another seat
   * already wrote to the store counts too, so a mounted viewer does not make the
   * navigation row probe twice before deciding.
   */
  const [probe, setProbe] = useState<InstallationsInfo | null>()

  useEffect(() => {
    let live = true
    installations()
      .then((result) => {
        if (!live) return
        setProbe(result)
        actions.setInstallations(result)
      })
      .catch(() => { if (live) setProbe(null) })
    return () => { live = false }
  }, [actions, installations])

  const facts = probe ?? installed
  const phase = wizardPhase({
    hasForm: form !== undefined,
    status: snapshot.status,
    onboardingComplete: snapshot.value?.onboardingComplete === true,
    kicadConfigured: probe === undefined && installed === undefined
      ? undefined
      : facts?.kicad?.configured === true,
    dismissed: closed,
  })

  useEffect(() => {
    if (kicadRoot !== '' || facts?.kicad?.root === undefined) return
    setKicadRoot(facts.kicad.root)
  }, [facts?.kicad?.root, kicadRoot])

  // `form === undefined` is already `no-form`; repeating it here is what lets
  // TypeScript narrow it for the handlers below.
  if (form === undefined || phase !== 'open') return null

  const complete = async (): Promise<void> => {
    // Close first: the write is a host round-trip, and the user's click must
    // dismiss the modal whether or not the host accepts it.
    dismissedInClient = true
    setClosed(true)
    try {
      await form.set('onboardingComplete', true)
    } catch {
      // A refused host write must not trap the user in the wizard.
    }
  }

  const finish = async (): Promise<void> => {
    setBusy(true)
    try {
      if (kicadRoot !== '') await saveInstallation('kicad', kicadRoot)
      if (solidcraftRoot !== '') await saveInstallation('solidcraft', solidcraftRoot)
    } catch (error) {
      setMessage(String(error))
      setBusy(false)
      return
    }
    // Record completion before the probe refresh: a valid KiCad root makes this
    // wizard unmount on the next render, and a write issued after that would
    // rely on an unmounted component finishing its async tail.
    await complete()
    try {
      actions.setInstallations(await installations())
    } catch {
      // The viewer re-probes on its own; nothing here depends on the answer.
    }
  }

  const next = async (): Promise<void> => {
    if (step < STEPS.length - 1) {
      setStep(step + 1)
      return
    }
    await finish()
  }

  const stepBody = (): ReactNode => {
    if (step === 0) {
      return createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        createElement(
          'div',
          { style: { ...ROW, gap: 10 } },
          createElement('span', { style: BRAND_MARK }, 'H!'),
          createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 1 } },
            createElement('h2', { style: TITLE }, 'Set up your hardware toolchain'),
            createElement('span', { style: STEP_LABEL }, 'one-time · skippable'),
          ),
        ),
        createElement('p', { style: LEAD },
          'Hardware Engineering previews KiCad projects, exports PCB 3D models, packages fabrication files and opens native files. Point it at your local installations once.'),
        createElement('div',
          { style: FIELD_CARD },
          createElement('span', { style: { fontSize: 11, fontWeight: 600 } }, 'What it uses'),
          createElement('p', { style: { ...MUTED, color: C.text3 } },
            'kicad-cli for previews, BOM, GLB and gerber/drill packaging. SolidCraft is shared with the agent as environment context only.'),
        ),
        createElement('p', { style: { ...MUTED, color: C.text3 } },
          'Only local executables are used. Nothing is uploaded, and nothing is installed for you.'),
      )
    }
    if (step === 1) {
      return createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        createElement(
          'div',
          { style: SPREAD },
          createElement('h2', { style: TITLE }, 'KiCad installation'),
          createElement('span', { style: facts?.kicad?.configured === true ? pillStyle('ok') : pillStyle('muted') },
            facts?.kicad?.configured === true ? `v${facts.kicad.version ?? '?'}` : 'optional'),
        ),
        createElement('p', { style: LEAD },
          'Enter a KiCad installation folder or a kicad-cli path. It is used for .kicad_sch / .kicad_pcb previews, PCB GLB export, fabrication packaging, and “Open in KiCad”.'),
        createElement('input', {
          style: INPUT, value: kicadRoot, autoFocus: true, spellCheck: false,
          placeholder: 'C:\\Program Files\\KiCad\\8.0\\  or  /usr/bin/kicad-cli',
          onChange: event => setKicadRoot(event.currentTarget.value),
        }),
        createElement('p', { style: { ...MUTED, color: C.text3 } },
          'Leave it empty to skip. You can configure it later in Settings → Hardware Engineering.'),
      )
    }
    return createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      createElement(
        'div',
        { style: SPREAD },
        createElement('h2', { style: TITLE }, 'SolidCraft installation'),
        createElement('span', { style: pillStyle('muted') }, 'optional'),
      ),
      createElement('p', { style: LEAD },
        'SolidCraft is shared with the agent as environment context only in this POC — no native launch, no mechanical preview.'),
      createElement('input', {
        style: INPUT, value: solidcraftRoot, autoFocus: true, spellCheck: false,
        placeholder: 'C:\\Program Files\\SolidCraft\\bin\\SolidCraft.exe',
        onChange: event => setSolidcraftRoot(event.currentTarget.value),
      }),
    )
  }

  return createElement(
    'div',
    { style: BACKDROP, role: 'dialog', 'aria-modal': true, 'aria-label': 'Hardware Engineering setup', 'data-hardware-wizard': true },
    createElement(
      'div',
      { style: PANEL },
      createElement(
        'div',
        { style: SPREAD },
        createElement(
          'div',
          { style: { ...ROW, gap: 6 } },
          ...STEPS.map((label, index) => createElement('span', {
            key: label,
            style: { ...dotStyle(index === step ? C.accent : index < step ? C.ok : C.text3, 6) },
            title: label,
          })),
          createElement('span', { style: { ...STEP_LABEL, ...MONO_TEXT } }, `${String(step + 1)}/${String(STEPS.length)} · ${STEPS[step]}`),
        ),
        createElement('button', {
          type: 'button', style: buttonStyle('quiet', { fontSize: 10.5 }),
          onClick: () => { void complete() },
        }, 'Skip setup'),
      ),
      stepBody(),
      ...(message === '' ? [] : [createElement('p', { key: 'msg', style: { ...MUTED, color: C.text2 }, role: 'status' }, message)]),
      createElement(
        'div',
        { style: { ...SPREAD, paddingTop: 6, borderTop: `1px solid ${C.borderSoft}` } },
        createElement('span', { style: { ...MUTED, color: C.text3, fontSize: 10 } },
          'You can change this any time in Settings → Hardware Engineering.'),
        createElement(
          'span',
          { style: ROW },
          step > 0
            ? createElement('button', {
                type: 'button', style: buttonStyle('secondary'),
                onClick: () => { setStep(step - 1) },
              }, 'Back')
            : null,
          createElement('button', {
            type: 'button', style: buttonStyle('primary'), disabled: busy,
            onClick: () => { void next() },
          }, busy ? 'Saving…' : step === STEPS.length - 1 ? 'Finish' : 'Next'),
        ),
      ),
    ),
  )
}

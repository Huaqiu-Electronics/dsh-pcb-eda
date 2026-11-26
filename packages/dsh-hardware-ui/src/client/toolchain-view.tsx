/**
 * The two toolchain surfaces that are not the wizard: the install card, the
 * transient notice overlay, and the quiet sidebar indicator.
 *
 * Everything here is a projection of {@link ToolchainController} — no component
 * keeps its own copy of "configured" or of a path. The card is rendered by BOTH
 * the wizard step and the Settings section, so a fix to how a failure reads, or
 * where the download button sits, lands in both places at once (§10.5).
 *
 * Styling is self-drawn from `theme.ts`: this bundle declares no runtime
 * dependency beyond `react`, `slots` and `locale`, so importing DSH's primitives
 * here would add a dependency this plugin does not otherwise need.
 *
 * @module @huaqiu/dsh-hardware-ui/client/toolchain-view
 */
import { createElement, useCallback, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { COPY } from './copy.js'
import {
  jobPercent, jobRunning, setupIncomplete, setupSummary,
  type InstallJob, type ToolStatus, type ToolchainController, type ToolchainId,
  type ToolchainSnapshot,
} from './toolchain.js'
import { buttonStyle, C, cardStyle, disabled, dotStyle, INPUT, MUTED, MONO, MONO_TEXT, pillStyle, R } from './theme.js'

/** Keeping the controller's snapshot subscribed is one call; every surface uses it. */
export function useToolchain(controller: ToolchainController): ToolchainSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

/**
 * Which tool is on screen, with its product name and card accent.
 *
 * `blurb` is a function, not a string: copy is read at render time so a locale
 * switch reaches these cards like every other surface.
 */
const TOOL_META = {
  kicad: { name: 'KiCad', letter: 'Ki', color: C.info, blurb: (): string => COPY.settings.kicadBlurb },
  solidcraft: { name: 'SolidCraft', letter: 'Sc', color: C.warn, blurb: (): string => COPY.settings.solidcraftBlurb },
} as const

/** Tone of the status pill for one tool, from its authoritative state (§10.3). */
export function statusPill(
  tool: ToolStatus,
  job: InstallJob | undefined,
): { readonly text: string; readonly tone: 'ok' | 'warn' | 'info' | 'muted' | 'accent' } {
  if (job !== undefined && job.tool === tool.tool && jobRunning(job)) {
    const percent = jobPercent(job)
    if (job.phase === 'download') {
      return { text: COPY.toolchain.statusDownloading(`${percent ?? 0}%`), tone: 'info' }
    }
    return { text: COPY.toolchain.statusExtracting, tone: 'info' }
  }
  if (job !== undefined && job.tool === tool.tool && job.phase === 'failed') {
    return { text: COPY.toolchain.statusFailed, tone: 'accent' }
  }
  switch (tool.state) {
    case 'configured': return { text: `v${tool.version ?? '?'}`, tone: 'ok' }
    case 'invalid': return { text: COPY.toolchain.statusInvalid, tone: 'accent' }
    case 'validating': return { text: COPY.toolchain.statusValidating, tone: 'muted' }
    default: return { text: COPY.toolchain.statusUnconfigured, tone: 'warn' }
  }
}

/** One line describing what discovery found, or that it is still looking. */
export function discoveryLine(tool: ToolStatus): { readonly text: string; readonly tone: 'muted' | 'ok' | 'warn' } | undefined {
  const discovery = tool.discovery
  if (discovery.state === 'running') return { text: COPY.toolchain.discovering, tone: 'muted' }
  if (discovery.state === 'failed') return { text: discovery.error ?? COPY.toolchain.notDetected, tone: 'warn' }
  const selected = discovery.selected
  if (selected !== undefined && selected.valid && tool.state !== 'configured') {
    return { text: COPY.toolchain.detected(selected.path, selected.version ?? '?'), tone: 'ok' }
  }
  if (selected !== undefined && !selected.valid) {
    return { text: COPY.toolchain.detectedInvalid(selected.path, selected.error ?? COPY.toolchain.notDetected), tone: 'warn' }
  }
  return undefined
}

const PROGRESS_TRACK: CSSProperties = {
  position: 'relative', height: 4, borderRadius: R.pill, background: C.borderSoft, overflow: 'hidden', flex: 1,
}

/**
 * One installation card: identity, status, path, three independent ways in, and
 * inline progress (§10.2). Nothing here decides whether a tool is configured —
 * the pill, the version and the download affordance all read the Host status.
 */
export function ToolchainCard(props: {
  readonly tool: ToolchainId
  readonly controller: ToolchainController
  readonly snapshot: ToolchainSnapshot
  /** Wizard layout drops the blurb line; Settings keeps it. */
  readonly compact?: boolean
}): ReactNode {
  const { controller, snapshot } = props
  const meta = TOOL_META[props.tool]
  const tool = snapshot.status?.[props.tool]
  const job = snapshot.status?.job
  const draft = snapshot.drafts[props.tool]
  const saving = snapshot.saving === props.tool
  const ownJob = job !== undefined && job.tool === props.tool ? job : undefined
  const running = jobRunning(ownJob)
  const percent = jobPercent(ownJob)
  const pill = tool === undefined ? { text: COPY.toolchain.statusValidating, tone: 'muted' as const } : statusPill(tool, job)
  const line = tool === undefined ? undefined : discoveryLine(tool)
  const entry = tool?.download
  const busy = running || saving

  const onSave = useCallback((): void => {
    void controller.save(props.tool, controller.getSnapshot().drafts[props.tool])
  }, [controller, props.tool])

  const header = createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 } },
    createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 } },
      createElement('span', {
        style: {
          width: 22, height: 22, borderRadius: R.sm, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 10, fontWeight: 700, fontFamily: MONO, flex: '0 0 auto',
          color: meta.color, background: `color-mix(in srgb, ${meta.color} 18%, transparent)`,
          border: `1px solid color-mix(in srgb, ${meta.color} 40%, transparent)`,
        },
      }, meta.letter),
      createElement('span', { style: { fontSize: 12, fontWeight: 600 } }, meta.name),
    ),
    createElement('span', { style: pillStyle(pill.tone) }, pill.text),
  )

  const facts = tool === undefined
    ? [createElement('p', { key: 'checking', style: MUTED }, COPY.toolchain.checking)]
    : [
        createElement(
          'p',
          { key: 'facts', style: { ...MUTED, ...MONO_TEXT, fontSize: 10, wordBreak: 'break-all' } },
          tool.state === 'configured' || tool.state === 'invalid'
            ? `${tool.installPath ?? ''}${tool.cliPath === undefined ? '' : `  ·  ${tool.cliPath}`}`
            : COPY.toolchain.checking,
        ),
        ...(tool.error === undefined || tool.state === 'configured'
          ? []
          : [createElement('p', { key: 'error', style: { ...MUTED, color: C.accent } }, tool.error)]),
        ...(line === undefined
          ? []
          : [createElement('p', {
              key: 'discovery',
              style: { ...MUTED, ...MONO_TEXT, fontSize: 10, color: line.tone === 'ok' ? C.ok : line.tone === 'warn' ? C.warn : C.text3, wordBreak: 'break-all' },
            }, line.text)]),
      ]

  const pathRow = createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
    createElement('input', {
      style: INPUT, value: draft, spellCheck: false, disabled: busy,
      placeholder: props.tool === 'kicad' ? COPY.settings.kicadPlaceholder : COPY.settings.solidcraftPlaceholder,
      'aria-label': COPY.settings.pathField(meta.name),
      onChange: event => controller.setDraft(props.tool, event.currentTarget.value),
      onKeyDown: (event: { key: string }) => { if (event.key === 'Enter') onSave() },
    }),
    createElement('button', {
      type: 'button',
      style: { ...buttonStyle('secondary'), ...disabled(busy) },
      disabled: busy,
      onClick: () => { void controller.browse(props.tool) },
    }, COPY.toolchain.browse),
    createElement('button', {
      type: 'button',
      style: { ...buttonStyle('primary'), ...disabled(busy) },
      disabled: busy,
      onClick: onSave,
    }, saving ? COPY.settings.validating : COPY.settings.validate),
  )

  const downloadRow = running || entry !== undefined
    ? createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
        running
          ? createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 } },
              createElement(
                'div',
                { style: PROGRESS_TRACK, role: 'progressbar', 'aria-valuenow': percent ?? 0, 'aria-valuemin': 0, 'aria-valuemax': 100 },
                createElement('div', {
                  style: {
                    position: 'absolute', inset: 0, width: `${percent ?? 0}%`, background: C.info,
                    transition: 'width 200ms ease',
                  },
                }),
              ),
              createElement('span', { style: { ...MUTED, ...MONO_TEXT, fontSize: 10, flex: '0 0 auto' } }, ownJob?.message ?? ''),
            )
          : createElement('span', { style: { ...MUTED, flex: 1 } }, COPY.toolchain.downloadUnavailable(meta.name)),
        createElement('button', {
          type: 'button',
          style: buttonStyle(running ? 'quiet' : 'secondary'),
          onClick: () => {
            if (running && ownJob !== undefined) void controller.cancel(ownJob.id)
            else void controller.install(props.tool)
          },
        }, running ? COPY.toolchain.cancel : COPY.toolchain.download(meta.name, entry?.version ?? '?')),
      )
    : undefined

  // §9.2: when no in-app download exists, the official page is the only honest
  // affordance — never a disabled button pretending to be one.
  const official = entry === undefined && !running && tool !== undefined
    ? createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
        createElement('span', { style: { ...MUTED, flex: 1 } }, COPY.toolchain.downloadUnavailable(meta.name)),
        createElement('button', { type: 'button', style: buttonStyle('quiet'), onClick: () => controller.discover(props.tool) },
          COPY.toolchain.retryCheck),
        createElement('a', {
          href: snapshot.status?.official[props.tool] ?? '#',
          target: '_blank',
          rel: 'noreferrer noopener',
          style: { fontSize: 11, color: C.info, textDecoration: 'none', whiteSpace: 'nowrap' },
        }, COPY.toolchain.official),
      )
    : undefined

  return createElement(
    'div',
    { style: cardStyle({ gap: 7 }), 'data-hardware-toolchain-card': props.tool },
    header,
    props.compact === true ? null : createElement('p', { style: MUTED }, meta.blurb()),
    ...facts,
    pathRow,
    ...(downloadRow === undefined ? [] : [downloadRow]),
    ...(official === undefined ? [] : [official]),
  )
}

/** Colour of one notice tone, for the overlay's left edge and text. */
function toastTone(tone: 'ok' | 'warn' | 'error' | 'info'): { readonly color: string; readonly background: string } {
  switch (tone) {
    case 'ok': return { color: C.ok, background: C.okSoft }
    case 'warn': return { color: C.warn, background: C.warnSoft }
    case 'error': return { color: C.accent, background: C.accentSoft }
    default: return { color: C.info, background: C.infoSoft }
  }
}

/**
 * `shell.overlay` occupant: the product's own notices (§11).
 *
 * The overlay is a click-through root layer, so the stack is pinned bottom-right
 * and only the cards themselves accept pointer events. Nothing here is modal:
 * an ordinary failure must never trap the user, and a notice that is dismissed
 * stays dismissed — the controller owns the list, not this component.
 */
export function ToolchainToastHost(props: { readonly controller: ToolchainController }): ReactNode {
  const snapshot = useToolchain(props.controller)
  if (snapshot.toasts.length === 0) return null
  return createElement(
    'div',
    {
      style: {
        position: 'fixed', right: 16, bottom: 16, display: 'flex', flexDirection: 'column',
        gap: 6, zIndex: 2100, pointerEvents: 'none', maxWidth: 320,
      },
      'data-hardware-toolchain-toasts': true,
    },
    ...snapshot.toasts.map(toast => {
      const tone = toastTone(toast.tone)
      return createElement(
        'div',
        {
          key: toast.id,
          role: 'status',
          style: {
            pointerEvents: 'auto', display: 'flex', alignItems: 'flex-start', gap: 8,
            padding: '8px 10px', borderRadius: R.md, border: `1px solid ${tone.color}44`,
            background: C.card, boxShadow: '0 8px 24px rgba(0,0,0,0.28)', fontSize: 11, lineHeight: 1.5, color: C.text,
          },
        },
        createElement('span', { style: { ...dotStyle(tone.color, 6), marginTop: 4, background: tone.color } }),
        createElement('span', { style: { flex: 1, minWidth: 0 } }, toast.text),
        createElement('button', {
          type: 'button',
          'aria-label': 'Dismiss',
          onClick: () => props.controller.dismiss(toast.id),
          style: { ...buttonStyle('quiet', { padding: '0 2px', fontSize: 11 }), color: C.text3 },
        }, '×'),
      )
    }),
  )
}

/**
 * `sidebar.footer.action` occupant: one quiet dot while setup is incomplete.
 *
 * Deliberately not a badge on the settings toggle — that seat is single and
 * owned by the desktop-update indicator. The dot is inert (no click handler):
 * the settings panel is opened by the shell, and the plugin has no seat that can
 * open it, so a button here would promise navigation it cannot deliver.
 */
export function ToolchainIndicator(props: { readonly controller: ToolchainController }): ReactNode {
  const snapshot = useToolchain(props.controller)
  if (snapshot.status === undefined || !setupIncomplete(snapshot.status)) return null
  const label = COPY.toolchain.indicator(setupSummary(snapshot.status))
  return createElement(
    'div',
    {
      title: label,
      'aria-label': label,
      style: {
        display: 'flex', alignItems: 'center', gap: 5, padding: '3px 6px', borderRadius: R.sm,
        color: C.warn, fontSize: 10, fontFamily: MONO,
      },
      'data-hardware-toolchain-indicator': true,
    },
    createElement('span', {
      style: { ...dotStyle(C.warn, 6), boxShadow: '0 0 0 3px rgba(251,191,36,0.16)' },
    }),
    createElement('span', { style: { whiteSpace: 'nowrap' } }, COPY.toolchain.pending),
  )
}

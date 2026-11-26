/**
 * The toolchain surfaces that are not the wizard itself: the install card, the
 * transient notice overlay, and the quiet sidebar indicator.
 *
 * Layout and wording follow `docs/prototype/huaqiu_eda_hardware_toolchain_ux_prototype.html`
 * (a letter badge + status pill per card, one path row with `Select Local File`,
 * the download bar, and an inline progress block). One component serves both the
 * wizard and Settings — a text or a fix lands in both places at once (§10.5) —
 * with `variant` selecting the few strings the prototype differentiates.
 *
 * Everything here is a projection of {@link ToolchainController}: no component
 * keeps its own copy of "configured" or of a path. Styling is self-drawn from
 * `theme.ts`; this bundle declares no runtime dependency beyond `react`, `slots`
 * and `locale`.
 *
 * @module @huaqiu/dsh-hardware-ui/client/toolchain-view
 */
import { createElement, Fragment, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { COPY } from './copy.js'
import {
  jobPercent, jobRunning, setupIncomplete, setupSummary,
  type InstallJob, type ToolStatus, type ToolchainController, type ToolchainId,
  type ToolchainSnapshot,
} from './toolchain.js'
import {
  buttonStyle, C, cardStyle, disabled, dotStyle, INPUT, MONO, MONO_TEXT, MUTED, pillStyle, R,
} from './theme.js'

/** Keeping the controller's snapshot subscribed is one call; every surface uses it. */
export function useToolchain(controller: ToolchainController): ToolchainSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

/** Product identity of one tool, with the prototype's badge colour. */
const TOOL_META = {
  kicad: {
    name: (): string => COPY.wizard.kicadTitle,
    short: 'KiCad',
    letter: 'Ki',
    color: '#2563EB',
    accent: '#60A5FA',
    bar: '#3B82F6',
    /** The prototype shows the CLI name beside the title for KiCad only. */
    code: 'kicad-cli' as string | undefined,
  },
  solidcraft: {
    name: (): string => COPY.wizard.solidcraftTitle,
    short: 'SolidCraft',
    letter: 'Sc',
    color: '#B45309',
    accent: '#FBBF24',
    bar: '#F59E0B',
    code: undefined as string | undefined,
  },
} as const

/** Stroke props shared by every glyph in this surface. */
const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

/**
 * One small line icon.
 *
 * The prototype uses inline SVGs; taking an icon dependency for five glyphs would
 * be the tail wagging the dog, so they are drawn from path data here.
 */
function Icon(props: { readonly path: string; readonly size?: number; readonly color?: string; readonly extra?: string }): ReactNode {
  return createElement(
    'svg',
    {
      viewBox: '0 0 24 24', width: props.size ?? 14, height: props.size ?? 14, 'aria-hidden': true,
      style: { flex: '0 0 auto', color: props.color ?? 'inherit' },
    },
    createElement('path', { d: props.path, ...STROKE }),
    ...(props.extra === undefined ? [] : [createElement('path', { d: props.extra, ...STROKE })]),
  )
}

/** Glyph paths: folder, download, info, gear, close. */
export const TOOLCHAIN_ICONS = {
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  info: 'M12 16v-4M12 8h.01',
  gear: 'M12 3v2M12 19v2M3 12h2M19 12h2M6.4 6.4l1.4 1.4M16.2 16.2l1.4 1.4M17.6 6.4l-1.4 1.4M7.8 16.2L6.4 17.6',
  close: 'M6 18L18 6M6 6l12 12',
  /** Executable row in the picker (prototype's document glyph). */
  file: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
} as const

/** Small square letter badge ("Ki" / "Sc") in the prototype's tool colour. */
function LetterBadge(props: { readonly letter: string; readonly color: string; readonly size: number }): ReactNode {
  return createElement('span', {
    style: {
      width: props.size, height: props.size, borderRadius: props.size >= 28 ? 8 : 6,
      display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
      background: props.color, color: '#fff', fontWeight: 700,
      fontSize: props.size >= 28 ? 12 : 11, fontFamily: MONO,
    },
  }, props.letter)
}

/** Muted chip for "Required for PCB/Sch" / "Optional • MCAD". */
function Chip(props: { readonly text: string }): ReactNode {
  return createElement('span', {
    style: {
      fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.08)',
      color: C.text2, whiteSpace: 'nowrap',
    },
  }, props.text)
}

/**
 * Tone of the status pill for one tool, from its authoritative state (§10.3).
 *
 * Green only ever follows a successful validation; a running job reports
 * progress; a failure is red.
 */
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
    default: return { text: COPY.toolchain.statusNotConfigured, tone: 'warn' }
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
  position: 'relative', height: 6, borderRadius: 999, background: 'rgba(0,0,0,0.5)', overflow: 'hidden', flex: 1,
}

/** Inline download progress: label + percent on one line, bar underneath (§7.4). */
function Progress(props: { readonly job: InstallJob; readonly color: string }): ReactNode {
  const percent = jobPercent(props.job) ?? 0
  return createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8, borderTop: `1px solid ${C.borderSoft}` } },
    createElement(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, fontFamily: MONO, color: props.color } },
      createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        props.job.message === '' ? COPY.toolchain.downloading : props.job.message),
      createElement('span', { style: { flex: '0 0 auto' } }, `${percent}%`),
    ),
    createElement(
      'div',
      { style: PROGRESS_TRACK, role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 },
      createElement('div', {
        style: { position: 'absolute', inset: 0, width: `${percent}%`, background: props.color, transition: 'width 150ms ease' },
      }),
    ),
  )
}

/**
 * One installation card.
 *
 * `variant: 'wizard'` reproduces the first-run prototype card (chip, "Select
 * Local File...", "Don't have KiCad? … Download from HuaQiu Server");
 * `variant: 'settings'` reproduces the Settings card (longer description,
 * "Browse...", a verdict line beside the validate button, and an inline download
 * link). Both read the same Host status, so neither can claim something the other
 * denies.
 *
 * The executable picker is rendered **by the card that opened it**, not by an
 * overlay seat: the shell's overlay layer paints below the settings modal, so a
 * picker hosted there would end up behind the very dialog that asked for it.
 */
export function ToolchainCard(props: {
  readonly tool: ToolchainId
  readonly controller: ToolchainController
  readonly snapshot: ToolchainSnapshot
  readonly variant: 'wizard' | 'settings'
}): ReactNode {
  const { controller, snapshot, variant, tool: id } = props
  const meta = TOOL_META[id]
  const tool = snapshot.status?.[id]
  const job = snapshot.status?.job
  const draft = snapshot.drafts[id]
  const saving = snapshot.saving === id
  const ownJob = job !== undefined && job.tool === id ? job : undefined
  const running = jobRunning(ownJob)
  const pill = tool === undefined
    ? { text: COPY.toolchain.statusValidating, tone: 'muted' as const }
    : statusPill(tool, job)
  const entry = tool?.download
  const busy = running || saving

  const onSave = (): void => { void controller.save(id, controller.getSnapshot().drafts[id]) }

  // Header: badge + name (+ CLI name) + chip, status pill on the right.
  const header = createElement(
    'div',
    { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, minWidth: 0 } },
    createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
      createElement(LetterBadge, { letter: meta.letter, color: meta.color, size: variant === 'wizard' ? 28 : 24 }),
      createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          createElement('span', { style: { fontSize: 13, fontWeight: 600, color: C.text } }, meta.name()),
          ...(meta.code === undefined
            ? []
            : [createElement('code', { key: 'code', style: { fontSize: 11, fontFamily: MONO, color: meta.accent } }, `(${meta.code})`)]),
          variant === 'wizard'
            ? createElement(Chip, { text: id === 'kicad' ? COPY.wizard.kicadChip : COPY.wizard.solidcraftChip })
            : null,
        ),
        variant === 'wizard'
          ? createElement('span', { style: { fontSize: 11, color: C.text3 } },
              id === 'kicad' ? COPY.wizard.kicadBlurb : COPY.wizard.solidcraftBlurb)
          : null,
      ),
    ),
    createElement('span', { style: pillStyle(pill.tone) }, pill.text),
  )

  const description = variant === 'settings'
    ? createElement('p', { style: { ...MUTED, lineHeight: 1.6 } },
        id === 'kicad' ? COPY.settings.kicadBlurb : COPY.settings.solidcraftBlurb)
    : null

  // Path row: the placeholder is the prototype's own example path for the
  // wizard, and its "paste or browse" hint in Settings.
  const pathRow = createElement(
    'div',
    { style: { display: 'flex', gap: 8, minWidth: 0 } },
    createElement('input', {
      style: { ...INPUT, flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11 },
      value: draft, spellCheck: false, disabled: busy,
      placeholder: id === 'kicad'
        ? (variant === 'wizard' ? COPY.wizard.kicadPlaceholder : COPY.settings.kicadPlaceholder)
        : (variant === 'wizard' ? COPY.wizard.solidcraftPlaceholder : COPY.settings.solidcraftPlaceholder),
      'aria-label': COPY.settings.pathField(meta.short),
      onChange: (event: { currentTarget: { value: string } }) => controller.setDraft(id, event.currentTarget.value),
      onKeyDown: (event: { key: string }) => { if (event.key === 'Enter') onSave() },
    }),
    createElement('button', {
      type: 'button',
      style: { ...buttonStyle('secondary', { display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }), ...disabled(busy) },
      disabled: busy,
      title: COPY.toolchain.browseTitle,
      onClick: () => { controller.openPicker(id) },
    },
    createElement(Icon, { path: TOOLCHAIN_ICONS.folder, color: '#FBBF24' }),
    variant === 'wizard' ? COPY.wizard.selectFile : COPY.toolchain.browse),
  )

  // Verdict beside the validate button, in the prototype's muted mono voice.
  //
  // It reports what the Host knows — except while the field holds an edit the Host
  // has never seen, where saying "awaiting executable path" beside a filled input
  // would be plainly false.
  const savedRoot = tool?.installPath ?? ''
  const dirty = draft.trim() !== '' && draft.trim() !== savedRoot
  const statusText = dirty
    ? COPY.settings.statusUnsaved
    : tool?.state === 'configured'
      ? (tool.cliPath ?? COPY.settings.statusVerified)
      : tool?.error ?? COPY.settings.statusAwaiting

  const validateRow = createElement(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 } },
    createElement('button', {
      type: 'button',
      style: { ...buttonStyle('secondary'), ...disabled(busy) },
      disabled: busy,
      onClick: onSave,
    }, saving ? COPY.settings.validating : COPY.settings.validate),
    variant === 'settings'
      ? createElement('span', {
          style: { ...MONO_TEXT, fontSize: 11, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          title: statusText,
        }, statusText)
      : null,
  )

  /** Download affordance: a plugin job first, the vendor page as the honest fallback. */
  const download = entry === undefined && tool !== undefined
    ? officialFallback(id, snapshot)
    : createElement('a', {
        href: entry?.url ?? snapshot.status?.official[id] ?? '#',
        target: '_blank',
        rel: 'noreferrer noopener',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 500,
          color: meta.accent, textDecoration: 'none', padding: '4px 8px', borderRadius: R.sm, whiteSpace: 'nowrap',
        },
        onClick: (event?: { preventDefault?: () => void }) => {
          // A download is a plugin-owned job (progress, checksum, promotion) rather
          // than a browser transfer; href stays as the fallback if the click fails.
          if (entry === undefined) return
          event?.preventDefault?.()
          void controller.install(id)
        },
      },
      createElement(Icon, { path: TOOLCHAIN_ICONS.download, color: meta.accent }),
      variant === 'settings'
        ? COPY.settings.download(id, entry?.version ?? '?')
        : COPY.wizard.serverDownload)

  // The prototype's wizard card carries no per-card validate button: the modal
  // footer's `Save & Get Started` validates and saves both tools at once.
  const actionRow = variant === 'settings'
    ? createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
        validateRow,
        download,
      )
    : null

  // The wizard puts the download in its own bordered bar, as the prototype does.
  const downloadBar = variant === 'wizard'
    ? createElement(
        'div',
        {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            paddingTop: 8, borderTop: `1px solid ${C.borderSoft}`, fontSize: 11, color: C.text3,
          },
        },
        createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          createElement(Icon, { path: TOOLCHAIN_ICONS.download, color: C.text3 }),
          createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            COPY.wizard.dontHave(meta.short)),
          createElement('span', { style: { ...MONO_TEXT, fontSize: 11, color: C.text2, whiteSpace: 'nowrap' } },
            entry === undefined ? COPY.toolchain.notDetected : `v${entry.version} (Win x64)`),
        ),
        download,
      )
    : null

  const card = createElement(
    'div',
    {
      style: cardStyle({ gap: variant === 'wizard' ? 10 : 12, padding: variant === 'wizard' ? 14 : 16 }),
      'data-hardware-toolchain-card': id,
      'data-variant': variant,
    },
    header,
    ...(description === null ? [] : [description]),
    pathRow,
    ...(actionRow === null ? [] : [actionRow]),
    ...(downloadBar === null ? [] : [downloadBar]),
    ...(running && ownJob !== undefined ? [Progress({ job: ownJob, color: meta.bar })] : []),
  )

  const picker = snapshot.picker === undefined || snapshot.picker.tool !== id
    ? null
    : createElement(ExecutablePicker, { controller, picker: snapshot.picker })
  return picker === null ? card : createElement(Fragment, null, card, picker)
}

/** §9.2: no in-app build for this platform means the vendor page, never a fake button. */
function officialFallback(tool: ToolchainId, snapshot: ToolchainSnapshot): ReactNode {
  return createElement('a', {
    href: snapshot.status?.official[tool] ?? '#',
    target: '_blank',
    rel: 'noreferrer noopener',
    style: { fontSize: 11, color: C.info, textDecoration: 'none', whiteSpace: 'nowrap' },
  }, COPY.toolchain.official)
}

/** Colour of one notice tone, for the overlay's dot and border. */
function toastTone(tone: 'ok' | 'warn' | 'error' | 'info'): { readonly color: string; readonly background: string } {
  switch (tone) {
    case 'ok': return { color: C.ok, background: C.okSoft }
    case 'warn': return { color: C.warn, background: C.warnSoft }
    case 'error': return { color: C.accent, background: C.accentSoft }
    default: return { color: C.info, background: C.infoSoft }
  }
}

/**
 * The executable picker (prototype §"SIMULATED OS SYSTEM FILE EXPLORER DIALOG").
 *
 * Browse no longer jumps straight into the OS dialog: it opens this list of the
 * executables discovery already found, lets the user pick one, and offers the
 * real OS chooser as the "Open Native OS Picker ↗" link in the breadcrumb bar —
 * exactly the prototype's shape. Rows that failed validation stay visible (so the
 * reason is readable) but cannot be selected: the picker never offers a path the
 * Host would reject.
 */
function ExecutablePicker(props: {
  readonly controller: ToolchainController
  readonly picker: NonNullable<ToolchainSnapshot['picker']>
}): ReactNode {
  const { controller, picker } = props
  const meta = TOOL_META[picker.tool]
  const tool = controller.getSnapshot().status?.[picker.tool]
  const executable = picker.tool === 'kicad' ? 'kicad-cli' : 'SolidCraft'

  // Breadcrumb: the folder of the highlighted row when there is one, otherwise the
  // configured root's, otherwise the prototype's neutral root.
  const chosenDir = (() => {
    const path = picker.chosen ?? tool?.installPath
    if (path === undefined) return undefined
    const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
    return cut > 0 ? path.slice(0, cut) : undefined
  })()

  const hint = tool === undefined
    ? COPY.toolchain.checking
    : picker.candidates.length === 0
      ? (discoveryLine(tool)?.text ?? COPY.toolchain.notDetected)
      : COPY.toolchain.pickerHint

  const row = (candidate: NonNullable<ToolStatus['discovery']['candidates']>[number], index: number): ReactNode => {
    const selected = picker.chosen === candidate.path
    const name = candidate.path.slice(Math.max(candidate.path.lastIndexOf('\\'), candidate.path.lastIndexOf('/')) + 1)
    return createElement(
      'div',
      {
        key: `${candidate.path}-${index}`,
        role: 'button',
        tabIndex: candidate.valid ? 0 : -1,
        'aria-disabled': !candidate.valid,
        'data-picker-row': candidate.path,
        onClick: candidate.valid ? () => controller.choosePick(candidate.path) : undefined,
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '10px 12px', borderRadius: R.sm, cursor: candidate.valid ? 'pointer' : 'default',
          border: `1px solid ${selected ? 'rgba(59,130,246,0.5)' : 'transparent'}`,
          background: selected ? 'rgba(37,99,235,0.20)' : 'transparent',
          opacity: candidate.valid ? 1 : 0.55,
        },
      },
      createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
        createElement(
          'span',
          {
            style: {
              width: 32, height: 32, borderRadius: 8, flex: '0 0 auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: `${meta.color}33`, color: meta.accent,
            },
          },
          createElement(Icon, { path: TOOLCHAIN_ICONS.file, size: 16 }),
        ),
        createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
          createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            createElement('span', { style: { fontSize: 12, fontWeight: 600, color: C.text } }, name),
            createElement(Chip, { text: COPY.toolchain.pickerOrigin(candidate.origin) }),
          ),
          createElement('span', {
            style: {
              ...MONO_TEXT, fontSize: 11, color: C.text3,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            },
            title: candidate.path,
          }, candidate.path),
        ),
      ),
      createElement(
        'div',
        { style: { textAlign: 'right', flex: '0 0 auto' } },
        candidate.valid
          ? createElement('div', { style: { ...MONO_TEXT, fontSize: 11, color: C.ok } }, `v${candidate.version ?? '?'}`)
          : null,
        candidate.valid
          ? createElement('div', { style: { fontSize: 10, color: C.text3 } }, COPY.toolchain.pickerValid)
          : createElement('div', {
              title: candidate.error ?? COPY.toolchain.pickerInvalid,
              style: {
                fontSize: 10, color: C.warn, maxWidth: 172,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
            }, candidate.error ?? COPY.toolchain.pickerInvalid),
      ),
    )
  }

  const openDisabled = picker.chosen === undefined || picker.nativePending

  return createElement(
    'div',
    {
      style: {
        position: 'fixed', inset: 0, zIndex: 2200, display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: 16, background: 'rgba(0,0,0,0.75)',
        pointerEvents: 'auto',
      },
      role: 'dialog',
      'aria-modal': true,
      'aria-label': COPY.toolchain.pickerTitle(executable),
      'data-hardware-toolchain-picker': picker.tool,
      onClick: (event: { target: unknown; currentTarget: unknown }) => {
        if (event.target === event.currentTarget) controller.closePicker()
      },
    },
    createElement(
      'div',
      {
        style: {
          display: 'flex', flexDirection: 'column', width: 512, maxWidth: '100%', maxHeight: '85vh',
          background: '#202022', border: '1px solid rgba(255,255,255,0.15)', borderRadius: R.md,
          boxShadow: '0 24px 64px rgba(0,0,0,0.5)', overflow: 'hidden',
        },
      },
      // OS-style title bar.
      createElement(
        'div',
        {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            padding: '12px 16px', background: '#2B2B2E', borderBottom: `1px solid ${C.borderSoft}`,
          },
        },
        createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontSize: 12, fontWeight: 500, color: C.text2 } },
          createElement(Icon, { path: TOOLCHAIN_ICONS.folder, color: '#FBBF24', size: 16 }),
          createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            COPY.toolchain.pickerTitle(executable)),
        ),
        createElement('button', {
          type: 'button',
          style: { ...buttonStyle('quiet', { padding: 4 }), flex: '0 0 auto' },
          title: COPY.toolchain.pickerCancel,
          'aria-label': COPY.toolchain.pickerCancel,
          onClick: () => controller.closePicker(),
        }, createElement(Icon, { path: TOOLCHAIN_ICONS.close, size: 16 })),
      ),

      // Breadcrumb + the real OS chooser link.
      createElement(
        'div',
        {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            padding: '8px 16px', background: '#18181A', borderBottom: `1px solid ${C.borderSoft}`,
            ...MONO_TEXT, fontSize: 11, color: C.text3,
          },
        },
        createElement('span', {
          style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          title: chosenDir ?? '',
        }, chosenDir ?? COPY.toolchain.pickerRoot),
        createElement('button', {
          type: 'button',
          style: {
            ...buttonStyle('quiet', { padding: 0, flex: '0 0 auto' }),
            color: C.info, fontWeight: 500, textDecoration: 'underline', fontSize: 11,
          },
          onClick: () => { void controller.nativePick() },
        }, picker.nativePending ? COPY.toolchain.pickerNativeWaiting : COPY.toolchain.pickerNative),
      ),

      // Rows. The prototype caps the list at max-h-60 (240px); rows here carry a
      // little more text than the mock, so the cap is 288px to keep the same number
      // of rows visible before the list starts scrolling.
      createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 2, padding: 10, overflowY: 'auto', maxHeight: 288 } },
        picker.candidates.length === 0
          ? [createElement('p', { key: 'hint', style: { ...MUTED, fontSize: 11, padding: '6px 4px', margin: 0 } }, hint)]
          : picker.candidates.map(row),
      ),

      // Selected file + Cancel / Open.
      createElement(
        'div',
        {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
            padding: '12px 16px', background: '#18181A', borderTop: `1px solid ${C.borderSoft}`,
          },
        },
        createElement('div', {
          title: picker.chosen ?? '',
          style: {
            ...MONO_TEXT, flex: 1, minWidth: 0, fontSize: 11, color: picker.chosen === undefined ? C.text3 : C.text2,
            background: '#121212', border: `1px solid ${C.borderSoft}`, borderRadius: 4, padding: '6px 10px',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          },
        }, picker.chosen ?? COPY.toolchain.pickerNoSelection),
        createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' } },
          createElement('button', {
            type: 'button',
            style: buttonStyle('quiet'),
            onClick: () => controller.closePicker(),
          }, COPY.toolchain.pickerCancel),
          createElement('button', {
            type: 'button',
            // Prototype's OS dialog confirms in system blue, not in HuaQiu red: it is
            // the OS's action, not ours.
            style: {
              padding: '6px 14px', borderRadius: R.sm, border: 'none', cursor: 'pointer',
              background: '#2563EB', color: '#fff', fontSize: 12, fontWeight: 500,
              font: 'inherit', ...disabled(openDisabled),
            },
            disabled: openDisabled,
            onClick: () => controller.confirmPick(),
          }, COPY.toolchain.pickerOpen),
        ),
      ),
    ),
  )
}

/**
 * `shell.overlay` occupant: the product's own notices (§11).
 *
 * The overlay is a click-through root layer, so the stack is pinned bottom-right
 * and only the cards accept pointer events. Nothing here is modal: an ordinary
 * failure must never trap the user.
 */
export function ToolchainToastHost(props: { readonly controller: ToolchainController }): ReactNode {
  const snapshot = useToolchain(props.controller)
  if (snapshot.toasts.length === 0) return null
  return createElement(
    'div',
    { style: { position: 'fixed', inset: 0, zIndex: 2100, pointerEvents: 'none' }, 'data-hardware-toolchain-toasts': true },
    createElement(
      'div',
      {
        style: {
          position: 'fixed', right: 16, bottom: 16, display: 'flex', flexDirection: 'column',
          gap: 6, maxWidth: 320,
        },
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
          createElement('span', { style: { ...dotStyle(tone.color, 6), marginTop: 4 } }),
          createElement('span', { style: { flex: 1, minWidth: 0 } }, toast.text),
          createElement('button', {
            type: 'button',
            'aria-label': 'Dismiss',
            onClick: () => props.controller.dismiss(toast.id),
            style: { ...buttonStyle('quiet', { padding: '0 2px', fontSize: 11 }), color: C.text3 },
          }, '×'),
        )
      }),
    ),
  )
}

/**
 * `sidebar.footer.action` occupant: one quiet dot while setup is incomplete.
 *
 * Deliberately not a badge on the settings toggle — that seat is single and owned
 * by the desktop-update indicator — and deliberately inert: the plugin owns no
 * seat that can open Settings, so a button here would promise navigation it
 * cannot deliver.
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
    createElement('span', { style: { ...dotStyle(C.warn, 6), boxShadow: '0 0 0 3px rgba(251,191,36,0.16)' } }),
    createElement('span', { style: { whiteSpace: 'nowrap' } }, COPY.toolchain.pending),
  )
}

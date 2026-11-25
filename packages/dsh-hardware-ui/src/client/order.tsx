/**
 * Order Placing destination.
 *
 * The panel never prices anything and never keeps its own order backend. It
 * prepares the fabrication package with `kicad-cli` through the host, shows
 * exactly what would be uploaded, and submits only after the user confirms in
 * a dialog. The URL shown afterwards is the backend's own URL, passed through.
 */
import { createElement, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { isAbortError } from './ecad.js'
import { COPY } from './copy.js'
import {
  loadOrderConfig, messageOf, placeOrder, prepareFabrication,
  type FabricationProjection, type OrderConfigInfo, type PlacedOrder,
} from './transport.js'
import { openOrderPage } from './order-page.js'
import {
  buttonStyle, C, cardStyle, disabled, dotStyle, MUTED, MONO, MONO_TEXT, pillStyle, R, SECTION_TITLE, SELECT,
} from './theme.js'

export interface OrderPanelProps {
  readonly boardPath: string
  readonly boardTitle: string
  readonly schematicPath?: string
  /** Workspace root of the session showing this panel; the base for relative paths. */
  readonly workspaceRoot?: string
  /** DSH session the panel belongs to, used to scope host-side discovery. */
  readonly session?: string
  readonly configured: boolean
}

const QUANTITIES = [5, 20, 100] as const

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function specRows(facts: FabricationProjection['facts']): { label: string; value: string }[] {
  return [
    { label: COPY.order.layers, value: COPY.order.layersValue(facts.layers) },
    { label: COPY.order.outline, value: `${facts.widthMm.toFixed(1)} × ${facts.heightMm.toFixed(1)} mm` },
    { label: COPY.order.thickness, value: `${facts.thicknessMm.toFixed(2)} mm` },
    { label: COPY.order.minTrace, value: facts.minTrackMm === undefined ? COPY.order.defaultValue : `${facts.minTrackMm.toFixed(2)} mm` },
    { label: COPY.order.minDrill, value: facts.minViaDrillMm === undefined ? COPY.order.defaultValue : `${facts.minViaDrillMm.toFixed(2)} mm` },
    { label: COPY.order.outerCopper, value: COPY.order.copperValue(facts.outerOz ?? 1) },
  ]
}

const SPEC_GRID: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(88px, 1fr))', gap: 6,
}
const SPEC_CELL: CSSProperties = {
  border: `1px solid ${C.borderSoft}`, borderRadius: R.md, background: C.base,
  padding: '5px 7px', display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0,
}
const SPEC_LABEL: CSSProperties = { fontSize: 9.5, color: C.text3, letterSpacing: 0.2 }
const SPEC_VALUE: CSSProperties = { fontSize: 11, ...MONO_TEXT, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }
const SPREAD: CSSProperties = { ...ROW, justifyContent: 'space-between' }
const TAG: CSSProperties = {
  fontSize: 9.5, fontWeight: 600, letterSpacing: 0.6, padding: '1px 5px', borderRadius: R.sm,
  border: '1px solid currentColor', fontFamily: MONO,
}
const LINK: CSSProperties = {
  color: C.info, fontSize: 11, fontFamily: MONO, wordBreak: 'break-all', textDecoration: 'underline',
  textUnderlineOffset: 2,
}
const DIALOG_BACKDROP: CSSProperties = {
  position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 14, zIndex: 20,
}
const DIALOG: CSSProperties = {
  width: '100%', maxWidth: 420, maxHeight: '90%', overflow: 'auto', background: C.card,
  border: `1px solid ${C.border}`, borderRadius: R.lg, boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
  padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
}

/** One workflow card: what it will do, what it needs, and its action. */
function workflowCard(input: {
  readonly tag: string
  readonly tagColor: string
  readonly title: string
  readonly subtitle: string
  readonly details: readonly { label: string; value: string }[]
  readonly action: string
  readonly onAction: () => void
  readonly busy: boolean
  readonly blocked?: string
}): ReactNode {
  const blocked = input.blocked !== undefined
  return createElement(
    'div',
    { style: cardStyle({ gap: 9 }), 'data-hardware-order-card': input.tag.toLowerCase() },
    createElement(
      'div',
      { style: { ...ROW, gap: 7 } },
      createElement('span', { style: { ...TAG, color: input.tagColor } }, input.tag),
      createElement('span', { style: { fontSize: 12, fontWeight: 600, color: C.text, minWidth: 0 } }, input.title),
    ),
    createElement('p', { style: MUTED }, input.subtitle),
    createElement(
      'div',
      { style: SPEC_GRID },
      ...input.details.map(detail => createElement(
        'div',
        { key: detail.label, style: SPEC_CELL },
        createElement('span', { style: SPEC_LABEL }, detail.label),
        createElement('span', { style: SPEC_VALUE, title: detail.value }, detail.value),
      )),
    ),
    blocked
      ? createElement('p', { style: { ...MUTED, color: C.warn } }, input.blocked ?? '')
      : null,
    createElement(
      'button',
      {
        type: 'button', style: { ...buttonStyle('primary'), width: '100%', ...disabled(blocked || input.busy) },
        disabled: blocked || input.busy,
        'data-hardware-order-action': input.tag.toLowerCase(),
        onClick: input.onAction,
      },
      input.busy ? COPY.order.submitting : input.action,
    ),
  )
}

export function OrderPanel(props: OrderPanelProps): ReactNode {
  const { boardPath, boardTitle, schematicPath, workspaceRoot, session, configured } = props
  const [config, setConfig] = useState<OrderConfigInfo>()
  const [prepared, setPrepared] = useState<FabricationProjection>()
  const [preparing, setPreparing] = useState(false)
  const [message, setMessage] = useState<string>()
  const [quantity, setQuantity] = useState<number>(20)
  const [confirming, setConfirming] = useState<'pcb' | 'smt'>()
  const [acknowledged, setAcknowledged] = useState(false)
  const [placing, setPlacing] = useState<'pcb' | 'smt'>()
  const [placed, setPlaced] = useState<PlacedOrder>()
  const [copied, setCopied] = useState(false)
  const [reopening, setReopening] = useState(false)
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  useEffect(() => {
    loadOrderConfig()
      .then((value) => { if (live.current) setConfig(value) })
      .catch((error: unknown) => { if (live.current) setMessage(messageOf(error)) })
  }, [])

  // Preparing the package is local: gerbers, drill files and CSVs come from the
  // saved board. Nothing leaves the machine until the user confirms an order.
  useEffect(() => {
    if (!configured) {
      setPrepared(undefined)
      return
    }
    const controller = new AbortController()
    setPreparing(true)
    setMessage(undefined)
    setPlaced(undefined)
    prepareFabrication(boardPath, schematicPath, workspaceRoot, controller.signal, session)
      .then((value) => { if (!controller.signal.aborted) setPrepared(value) })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return
        setMessage(messageOf(error))
      })
      .finally(() => { if (!controller.signal.aborted) setPreparing(false) })
    return () => { controller.abort() }
  }, [boardPath, schematicPath, workspaceRoot, session, configured])

  const facts = prepared?.facts
  const specs = useMemo(() => (facts === undefined ? [] : specRows(facts)), [facts])

  const submit = async (kind: 'pcb' | 'smt'): Promise<void> => {
    setPlacing(kind)
    setMessage(undefined)
    try {
      const result = await placeOrder(kind, {
        path: boardPath,
        ...(schematicPath === undefined ? {} : { schematic: schematicPath }),
        ...(workspaceRoot === undefined ? {} : { cwd: workspaceRoot }),
        ...(session === undefined ? {} : { session }),
        quantity,
        confirm: true,
      }, undefined)
      setPlaced(result)
      setConfirming(undefined)
      setAcknowledged(false)
      // The order exists from here on; show it where the user is working.
      openOrderPage(result.orderUrl)
    } catch (error) {
      setMessage(messageOf(error))
    } finally {
      setPlacing(undefined)
    }
  }

  const copy = async (): Promise<void> => {
    if (placed === undefined) return
    try {
      await navigator.clipboard.writeText(placed.orderUrl)
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1600)
    } catch {
      setCopied(false)
    }
  }

  const reopen = async (): Promise<void> => {
    if (placed === undefined) return
    setReopening(true)
    setMessage(undefined)
    try {
      openOrderPage(placed.orderUrl)
      setPlaced({ ...placed, launched: true, status: 'launched' })
    } catch (error) {
      setMessage(messageOf(error))
    } finally {
      setReopening(false)
    }
  }

  const zipSize = prepared === undefined ? undefined : formatBytes(prepared.archive.zipBytes)
  const assembly = prepared?.assembly
  const tokenReady = config?.hasToken ?? false

  const header = createElement(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
    createElement(
      'div',
      { style: SPREAD },
      createElement(
        'h3',
        { style: { margin: 0, fontSize: 13, fontWeight: 600, color: C.text, display: 'flex', alignItems: 'center', gap: 6 } },
        createElement('span', { style: dotStyle(C.accent) }),
        COPY.order.title,
      ),
      preparing
        ? createElement('span', { style: pillStyle('info') }, COPY.order.packaging)
        : prepared !== undefined
          ? createElement('span', { style: pillStyle('ok') }, COPY.order.packageReady)
          : createElement('span', { style: pillStyle(configured ? 'muted' : 'warn') }, configured ? COPY.order.packagePending : COPY.viewer.kicadMissing),
    ),
    createElement('p', { style: { ...MUTED, ...MONO_TEXT, fontSize: 10.5 } }, boardTitle),
  )

  const packageCard = createElement(
    'div',
    { style: cardStyle() },
    createElement('div', { style: SPREAD },
      createElement('span', { style: SECTION_TITLE }, COPY.order.packageCard),
      prepared === undefined
        ? null
        : createElement('span', { style: pillStyle('muted') }, COPY.order.packageFiles(prepared.archive.files.length, zipSize ?? '')),
    ),
    prepared === undefined
      ? createElement('p', { style: MUTED },
        preparing ? COPY.order.packageRunning : COPY.order.packageNotPrepared)
      : createElement(
        'div',
        {
          style: {
            display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 74, overflow: 'auto',
            border: `1px solid ${C.borderSoft}`, borderRadius: R.md, padding: 6, background: C.base,
          },
        },
        ...prepared.archive.files.map(file => createElement(
          'span',
          { key: file.name, style: { ...pillStyle('muted'), fontSize: 9.5, padding: '0 5px' }, title: `${file.name} · ${formatBytes(file.bytes)}` },
          file.name,
        )),
      ),
  )

  const pcbCard = workflowCard({
    tag: 'PCB',
    tagColor: C.ok,
    title: COPY.order.pcbTitle,
    subtitle: prepared === undefined
      ? COPY.order.pcbSubtitle
      : COPY.order.pcbSummary(prepared.archive.zipName, prepared.archive.files.length, zipSize ?? ''),
    details: specs.length === 0
      ? [{ label: COPY.order.boardFile, value: boardTitle }]
      : specs,
    action: COPY.order.pcbAction,
    onAction: () => { setAcknowledged(false); setConfirming('pcb') },
    busy: placing === 'pcb',
    ...(configured && prepared !== undefined
      ? tokenReady ? {} : { blocked: COPY.order.signInToOrder }
      : { blocked: configured ? COPY.order.waitingForPackage : COPY.order.configureToPackage }),
  })

  const smtCard = workflowCard({
    tag: 'PCBA',
    tagColor: C.info,
    title: COPY.order.smtTitle,
    subtitle: assembly === undefined
      ? COPY.order.smtSubtitle
      : COPY.order.smtSummary(assembly.positions, assembly.bomLines, formatBytes(assembly.bomBytes + assembly.positionsBytes)),
    details: [
      { label: COPY.order.placements, value: assembly === undefined ? '—' : String(assembly.positions) },
      { label: COPY.order.bomLines, value: assembly === undefined ? '—' : String(assembly.bomLines) },
      { label: COPY.order.credential, value: tokenReady ? COPY.order.signedIn : COPY.order.signedOut },
    ],
    action: COPY.order.smtAction,
    onAction: () => { setAcknowledged(false); setConfirming('smt') },
    busy: placing === 'smt',
    ...(assembly === undefined
      ? { blocked: COPY.order.selectRootSchematic }
      : tokenReady
        ? {}
        : { blocked: COPY.order.signInToOrderSmt }),
  })

  const agentHint = createElement(
    'div',
    { style: { ...ROW, gap: 4, paddingTop: 2 } },
    createElement('span', { style: { fontSize: 10, color: C.text3 } }, COPY.order.agentEntryPoints),
    ...['quote_pcb', 'place_pcb_order', 'quote_smt', 'place_smt_order'].map(name => createElement(
      'span', { key: name, style: { ...pillStyle('muted'), fontSize: 9.5 } }, name,
    )),
  )

  const resultCard = placed === undefined ? null : createElement(
    'div',
    { style: cardStyle({ borderColor: 'rgba(52,211,153,0.4)' }), 'data-hardware-order-result': placed.kind },
    createElement('div', { style: SPREAD },
      createElement('span', { style: SECTION_TITLE },
        placed.kind === 'pcb' ? COPY.order.resultTitlePcb : COPY.order.resultTitleSmt),
      createElement('span', { style: pillStyle(placed.launched ? 'ok' : 'muted') },
        placed.launched ? COPY.order.resultLaunched : COPY.order.resultReady),
    ),
    // The host sends its own English sentence in `placed.message`; the visible
    // copy is derived here so the panel speaks one language. The host string is
    // kept on the object for tooling, not rendered.
    createElement('p', { style: MUTED },
      placed.launched
        ? COPY.order.resultLaunchedMessage(placed.kind === 'pcb' ? 'PCB' : '贴片')
        : COPY.order.resultReadyMessage(placed.kind === 'pcb' ? 'PCB' : '贴片')),
    createElement('a', {
      style: LINK, href: placed.orderUrl, target: '_blank', rel: 'noreferrer noopener',
      'data-hardware-order-url': true,
    }, placed.orderUrl),
    createElement('p', { style: { ...MUTED, fontSize: 10 } }, COPY.order.resultNote),
    createElement('div', { style: ROW },
      createElement('button', {
        type: 'button',
        style: { ...buttonStyle('primary'), ...disabled(reopening) },
        disabled: reopening,
        'data-hardware-order-reopen': true,
        onClick: () => { void reopen() },
      }, reopening ? COPY.order.opening : COPY.order.openInBrowser),
      createElement('button', { type: 'button', style: buttonStyle('secondary'), onClick: () => { void copy() } },
        copied ? COPY.order.copied : COPY.order.copyUrl),
      createElement('span', { style: { ...MUTED, ...MONO_TEXT, fontSize: 10 } },
        `${placed.archive.zipName} · ${formatBytes(placed.archive.zipBytes)}`),
    ),
  )

  const dialog = confirming === undefined ? null : createElement(
    'div',
    { style: DIALOG_BACKDROP, role: 'dialog', 'aria-modal': true, 'aria-label': COPY.order.confirmAria, 'data-hardware-order-confirm': confirming },
    createElement(
      'div',
      { style: DIALOG },
      createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
        createElement('h4', { style: { margin: 0, fontSize: 13, fontWeight: 600 } },
          confirming === 'pcb' ? COPY.order.confirmTitlePcb : COPY.order.confirmTitleSmt),
        createElement('p', { style: MUTED }, COPY.order.confirmBody),
      ),
      createElement(
        'ul',
        { style: { margin: 0, paddingLeft: 16, fontSize: 11, color: C.text2, lineHeight: 1.7 } },
        createElement('li', null, COPY.order.confirmZip(prepared?.archive.zipName ?? 'board.zip', zipSize ?? '—')),
        ...(confirming === 'smt'
          ? [
              createElement('li', { key: 'pos' }, COPY.order.confirmPositions(assembly === undefined ? '—' : formatBytes(assembly.positionsBytes))),
              createElement('li', { key: 'bom' }, COPY.order.confirmBom(assembly === undefined ? '—' : formatBytes(assembly.bomBytes))),
            ]
          : []),
        createElement('li', { key: 'host' }, createElement('span', { style: MONO_TEXT }, COPY.order.confirmHost(config?.baseUrl))),
      ),
      createElement(
        'label',
        { style: { ...ROW, alignItems: 'flex-start', fontSize: 11, color: C.text2, cursor: 'pointer' } },
        createElement('input', {
          type: 'checkbox', checked: acknowledged,
          style: { marginTop: 2, accentColor: C.accent },
          onChange: (event: { currentTarget: HTMLInputElement }) => { setAcknowledged(event.currentTarget.checked) },
          'data-hardware-order-ack': true,
        }),
        COPY.order.confirmAck,
      ),
      createElement(
        'div',
        { style: { ...ROW, justifyContent: 'flex-end' } },
        createElement('button', {
          type: 'button', style: buttonStyle('quiet'),
          onClick: () => { setConfirming(undefined); setAcknowledged(false) },
        }, COPY.order.cancel),
        createElement('button', {
          type: 'button',
          style: { ...buttonStyle('primary'), ...disabled(!acknowledged || placing !== undefined) },
          disabled: !acknowledged || placing !== undefined,
          'data-hardware-order-confirm-submit': true,
          onClick: () => { void submit(confirming) },
        }, placing === undefined ? COPY.order.uploadAndOpen : COPY.order.uploading),
      ),
    ),
  )

  return createElement(
    'div',
    { style: { position: 'relative', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }, 'data-hardware-order': true },
    header,
    ...(message === undefined ? [] : [createElement('p', {
      key: 'message', role: 'status', style: { ...MUTED, color: C.warn, borderLeft: `2px solid ${C.warn}`, paddingLeft: 8 },
    }, message)]),
    createElement(
      'div',
      { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 10 } },
      pcbCard,
      smtCard,
    ),
    createElement(
      'div',
      { style: { ...SPREAD, ...cardStyle({ flexDirection: 'row', alignItems: 'center' }) } },
      createElement('span', { style: { fontSize: 11, color: C.text2 } }, COPY.order.batch),
      createElement(
        'select',
        {
          style: { ...SELECT, width: 'auto' }, value: quantity,
          'data-hardware-order-quantity': true,
          onChange: (event: { currentTarget: HTMLSelectElement }) => { setQuantity(Number(event.currentTarget.value)) },
        },
        ...QUANTITIES.map(count => createElement('option', { key: count, value: count }, COPY.order.batchUnits(count))),
      ),
      createElement('span', { style: { ...MUTED, ...MONO_TEXT, fontSize: 10 } }, COPY.order.quoteBasis(quantity)),
    ),
    packageCard,
    resultCard,
    agentHint,
    dialog,
  )
}

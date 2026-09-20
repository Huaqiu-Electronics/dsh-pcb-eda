// kicad-3d-viewer — DSH 浏览器半边（client 源）。
//
// 交互形态（按用户要求）：
// - **模型推送的卡片**：pcb_preview 所在的回合末尾（turn tail，正文流里、不悬浮）
//   出现一张卡片：板子实时 2D 缩略图 + 文件名 + 参数 + 「显示 PCB / 显示 3D /
//   浏览器打开」三个按钮。
// - 数据通路：
//   1) 会话观察器（挂在 conversation.session.header.actions，渲染 null）持续扫会话
//      快照，维护 回合号 → 预览 的映射（模块级 store）。
//   2) 卡片注册在 conversation.chat.turnTail（chain 槽位，官方 deliverables 卡片同一行），
//      select 用回合号查映射表自我选举（priority -1 = 先于 deliverables；该回合没有
//      预览时让位给它）。
//   3) 大屏面板仍是 fixed 悬浮层，由卡片按钮打开；单例（模块级状态）。
//
// 本文件经 scripts/build-client.mjs 打包为 client.js（ModuleLoader 单文件 CJS）。

import React, { useEffect, useRef, useState } from 'react'
import { createViewer, type ViewMode } from '../viewer.js'

// ---------------------------------------------------------------- 宿主平台的客户端类型
// DSH 的 client 类型没有以包的形式安装；这里按实际用到的形状做最小本地声明，
// ctx / owner / slot props 一律窄化到局部接口，不做全局假设。
interface ClientContext {
  slots: {
    inject(name: string, cb: () => unknown): void
    register(spec: SlotSpec, component: React.ComponentType<never> | ((props: never) => unknown)): unknown
  }
}
interface SlotSpec {
  name: string
  id?: string
  order?: number
  priority?: number
  select?: (owner: SessionOwner) => PreviewPayload | null
  inject?: () => Record<string, unknown>
}
type SessionNode = Record<string, unknown>
interface SessionSnapshot {
  nodes?: SessionNode[]
}
/** turnTail 的 select 收到的宿主侧 owner（只用 turn.turn）。 */
interface SessionOwner {
  turn?: { turn?: number }
}
/** 会话快照的 useSession 选择器（宿主注入）。 */
type UseSession = <T>(selector: (snapshot: SessionSnapshot | undefined) => T) => T
/**
 * chat 视图快照（session 作用域的 chat 钩子，宿主以 useChat 注入）。
 * 对话节点在这里：`nodes` 是 ChatNodeStore，数组形式是 `legacy.nodes`。
 */
interface ChatSnapshot {
  legacy?: { nodes?: SessionNode[] }
}
/** chat 快照的 useChat 选择器（宿主注入）。 */
type UseChat = <T>(selector: (snapshot: ChatSnapshot | undefined) => T) => T

const inject = ['slots']

const EMPTY_NODES: SessionNode[] = []
const MAX_WALK_DEPTH = 100
const TOOL_NAME = 'pcb_preview'

// ---------------------------------------------------------------- 工具结果解析
interface PreviewStats {
  sizeKB?: number
  widthMM?: number
  heightMM?: number
  layers?: number
  comps?: number
  pads?: number
  traces?: number
  vias?: number
}
interface PreviewPayload {
  ok: boolean
  key?: string
  viewUrl?: string
  name?: string
  stats?: PreviewStats
}
/** tool-result 节点里承载 JSON 的块。 */
interface TextBlock {
  type?: string
  text?: string
}

/**
 * 从一个 tool-result 节点里取出预览载荷。
 * 先逐块 JSON.parse（host 的 render 会额外回一块 JSON）；失败则正则兜底。
 */
function pickPreview(node: SessionNode): PreviewPayload | null {
  const blocks = (Array.isArray(node.content) ? (node.content as TextBlock[]) : [])
    .filter((b) => b?.type === 'text')
  for (const b of blocks) {
    try {
      const v = JSON.parse(String(b.text)) as PreviewPayload | null
      if (v && v.ok === true && typeof v.viewUrl === 'string') return v
    } catch { /* not this block */ }
  }
  const joined = blocks.map((b) => b.text).join('\n')
  const m = joined.match(/\/pcb-viewer\/api\/file\?key=([\w.-]+)/)
  if (m) {
    const name = (joined.match(/([\w.-]+\.kicad_pcb)/) ?? [])[1] ?? 'board.kicad_pcb'
    return { ok: true, key: m[1], viewUrl: m[0], name }
  }
  return null
}

function walkAll(nodes: SessionNode[], visit: (node: SessionNode) => void): void {
  const visited = new Set<SessionNode>()
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > MAX_WALK_DEPTH || visited.has(node as SessionNode)) return
    const n = node as SessionNode
    visited.add(n)
    visit(n)
    const kids = (n.children ?? n.nodes ?? []) as SessionNode[]
    for (const k of kids) walk(k, depth + 1)
    if (Array.isArray(n.subCalls)) for (const k of n.subCalls as SessionNode[]) walk(k, depth + 1)
  }
  for (const n of nodes) walk(n, 0)
}

/** 会话快照 → { byTurn: Map<turnNumber, preview>, latest: preview|null } */
interface PreviewIndex {
  byTurn: Map<number, PreviewPayload>
  latest: PreviewPayload | null
}

function indexPreviews(nodes: SessionNode[]): PreviewIndex {
  const byCallId = new Map<string, PreviewPayload>()
  let latest: PreviewPayload | null = null
  walkAll(nodes, (n) => {
    const call = n.call as { name?: string } | undefined
    if (n.kind === 'tool-result' && call?.name === TOOL_NAME && !n.isError) {
      const p = pickPreview(n)
      if (p) {
        if (n.callId != null) byCallId.set(String(n.callId), p)
        latest = p
      }
    }
  })
  const byTurn = new Map<number, PreviewPayload>()
  walkAll(nodes, (n) => {
    if (n.kind !== 'assistant') return
    for (const b of (n.blocks ?? []) as Record<string, unknown>[]) {
      if (b?.kind === 'tool-call' && b.name === TOOL_NAME) {
        const p = (b.callId != null && byCallId.get(String(b.callId))) || null
        if (p && typeof n.turn === 'number') byTurn.set(n.turn, p)
      }
    }
  })
  return { byTurn, latest }
}

// ---------------------------------------------------------------- 板文件文本缓存（带上限，超限逐出最旧）
const textCache = new Map<string, string>()
let textCacheBytes = 0
const TEXT_CACHE_CAP = 250 * 1024 * 1024
function loadBoardText(preview: PreviewPayload | null | undefined): Promise<string> {
  const key = preview?.key ?? preview?.viewUrl
  if (!key) return Promise.reject(new Error('no preview'))
  const cached = textCache.get(key)
  if (cached !== undefined) return Promise.resolve(cached)
  return fetch(preview!.viewUrl ?? key)
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text() })
    .then((text) => {
      const sz = text.length
      while (textCacheBytes + sz > TEXT_CACHE_CAP && textCache.size) {
        const oldest = textCache.keys().next().value as string
        textCacheBytes -= (textCache.get(oldest) ?? '').length
        textCache.delete(oldest)
      }
      textCache.set(key, text)
      textCacheBytes += sz
      return text
    })
}
const THUMB_MAX_KB = 8 * 1024

// ---------------------------------------------------------------- 面板单例状态
interface PanelStore {
  open: boolean
  mode: ViewMode
  preview: PreviewPayload | null
  token: number
}
type PanelPatch = Partial<Omit<PanelStore, 'token'>>
const panelStore: PanelStore = { open: false, mode: 'split', preview: null, token: 0 }
const panelListeners = new Set<(token: number) => void>()
function setPanel(patch: PanelPatch): void {
  Object.assign(panelStore, patch)
  panelStore.token += 1
  for (const fn of panelListeners) fn(panelStore.token)
}
function usePanel(): PanelStore {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = (): void => force((v) => v + 1)
    panelListeners.add(fn)
    return () => { panelListeners.delete(fn) }
  }, [])
  return panelStore
}

// 会话预览索引（观察器写入；turnTail 的 select 是纯函数，只能读模块级状态）
const previewIndex: PreviewIndex = { byTurn: new Map<number, PreviewPayload>(), latest: null }

// ---------------------------------------------------------------- 样式
const S: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex', flexDirection: 'column', gap: 9, marginTop: 6, marginBottom: 6,
    padding: 11, borderRadius: 10, maxWidth: 320,
    background: 'var(--dsw-alias-bg-layer-3, rgba(255,255,255,.03))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))',
    width: 'fit-content',
  },
  thumbWrap: { position: 'relative', borderRadius: 7, overflow: 'hidden', background: '#0b0e13', border: '1px solid rgba(95,224,205,.18)' },
  thumbHint: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#7d8b9a', font: '10px ui-monospace, Menlo, monospace', letterSpacing: '0.14em' },
  cardTitle: { font: '600 12px ui-monospace, Menlo, monospace', color: 'var(--dsw-alias-label-primary, #e6e9ef)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 290 },
  cardMeta: { font: '10px ui-monospace, Menlo, monospace', color: 'var(--dsw-alias-label-tertiary, #93a1b0)', letterSpacing: '0.04em' },
  strip: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  btn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    font: '600 11px ui-monospace, Menlo, monospace', letterSpacing: '0.06em',
    color: 'var(--dsw-alias-label-primary, #e6e9ef)',
    background: 'var(--dsw-alias-fill-tsp-secondary, rgba(95,224,205,.08))',
    border: '1px solid rgba(95,224,205,.38)', borderRadius: 6,
    padding: '3px 9px', cursor: 'pointer', whiteSpace: 'nowrap',
  },
  btnOn: { borderColor: '#5fe0cd', color: '#5fe0cd', boxShadow: '0 0 10px rgba(95,224,205,.25)' },
  panel: {
    position: 'fixed', top: 0, right: 0, height: '100vh', zIndex: 200,
    background: '#090b0f', borderLeft: '1px solid rgba(95,224,205,.25)',
    boxShadow: '-18px 0 60px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column',
    transition: 'width .25s ease',
  },
  head: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px',
    borderBottom: '1px solid rgba(95,224,205,.14)', flex: '0 0 auto',
    font: '11px ui-monospace, Menlo, monospace', color: '#cdd8e4', userSelect: 'none',
  },
  title: { color: '#5fe0cd', letterSpacing: '0.18em', fontWeight: 700, fontSize: 11 },
  stats: { opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
  headBtn: {
    font: '600 11px ui-monospace, Menlo, monospace', color: '#5fe0cd',
    background: 'transparent', border: '1px solid rgba(95,224,205,.35)',
    borderRadius: 5, padding: '3px 9px', cursor: 'pointer', whiteSpace: 'nowrap',
  },
  body: { flex: 1, position: 'relative', minHeight: 0 },
  state: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#9fb2c4', font: '12px ui-monospace, Menlo, monospace', letterSpacing: '0.12em',
  },
}

function webUrl(preview: PreviewPayload): string {
  return `/pcb-viewer/view?key=${encodeURIComponent(preview.key ?? '')}&name=${encodeURIComponent(preview.name ?? 'board.kicad_pcb')}`
}

// ---------------------------------------------------------------- 缩略图
interface BoardThumbProps {
  preview: PreviewPayload | null
  width?: number
  height?: number
}

function BoardThumb({ preview, width = 292, height = 158 }: BoardThumbProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState('loading')
  const sizeKB = preview?.stats?.sizeKB ?? 0
  const big = sizeKB > THUMB_MAX_KB

  useEffect(() => {
    if (!preview) return undefined
    let viewer: { dispose?: () => void } | null = null
    let disposed = false
    // 预加载：卡片一出现就后台拉板文本；大文件的几秒拉取发生在用户看卡片的间隙
    loadBoardText(preview)
      .then((text) => {
        if (disposed || !hostRef.current) return
        try {
          // 板文本直接交给 viewer：createViewer 内部走 BoardParser().parse() → adaptBoard()
          // （与旧 parseKicad 完全同一条流水线，行为不变）
          viewer = createViewer(hostRef.current, {
            board: text,
            cacheKey: preview.key ?? preview.viewUrl,
            boardName: preview.name,
            brand: 'PCB',
            mode: '3d',
            hud: false,
            post: false,
            interactive: false,
            // 大文件轻渲染：只建几何、跳过全部 canvas 纹理（省掉建模的大头）
            textures: !big,
          })
          setState('ready')
        } catch { setState('error') }
      })
      .catch(() => { if (!disposed) setState('error') })
    return () => { disposed = true; viewer?.dispose?.(); viewer = null }
  }, [preview?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ ...S.thumbWrap, width, height }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {state !== 'ready' && (
        <div style={S.thumbHint}>
          {state === 'loading' ? (big ? '预加载中…' : 'RENDERING…') : '预览不可用'}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 大屏面板（单例）
interface PcbPanelProps {
  preview: PreviewPayload | null
  mode: ViewMode
  expanded: boolean
  onMode: (mode: ViewMode) => void
  onToggleExpand: () => void
  onClose: () => void
}

function PcbPanel({ preview, mode, expanded, onMode, onToggleExpand, onClose }: PcbPanelProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<ReturnType<typeof createViewer> | null>(null)
  const [phase, setPhase] = useState('loading')
  const [error, setError] = useState('')
  const s = preview?.stats ?? {}

  useEffect(() => {
    if (!preview) return undefined
    let disposed = false
    setPhase('loading')
    setError('')
    loadBoardText(preview)
      .then((text) => {
        if (disposed || !bodyRef.current) return
        viewerRef.current = createViewer(bodyRef.current, {
          board: text,
          cacheKey: preview.key ?? preview.viewUrl,
          boardName: preview.name,
          brand: 'PCB · 3D 预览',
          brandSub: '2D LAYOUT + 3D RENDER',
          mode,
        })
        setPhase('ready')
      })
      .catch((e) => { if (!disposed) { setPhase('error'); setError(String(e)) } })
    return () => {
      disposed = true
      viewerRef.current?.dispose?.()
      viewerRef.current = null
    }
  }, [preview?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    viewerRef.current?.setMode?.(mode)
  }, [mode, phase])

  const modeBtn = (m: ViewMode, label: string) => (
    <button type="button" style={{ ...S.headBtn, ...(mode === m ? S.btnOn : null) }} onClick={() => onMode(m)}>{label}</button>
  )
  const wide = mode === 'split' ? (expanded ? '100vw' : 'min(78vw, 1500px)') : (expanded ? '100vw' : 'min(86vw, 1700px)')

  return (
    <div style={{ ...S.panel, width: wide }}>
      <div style={S.head}>
        <span style={S.title}>PCB 3D 预览</span>
        <span style={S.stats}>
          {preview?.name ?? ''}
          {s.widthMM ? ` · ${s.widthMM}×${s.heightMM}mm · ${s.layers}层 · ${s.comps}器件 · ${s.traces}走线` : ''}
        </span>
        {modeBtn('2d', 'PCB')}
        {modeBtn('3d', '3D')}
        {modeBtn('split', '并排')}
        <button type="button" style={S.headBtn} onClick={onToggleExpand}>{expanded ? '⇲ 还原' : '⇱ 放大'}</button>
        <button type="button" style={S.headBtn} onClick={onClose}>✕ 关闭</button>
      </div>
      <div style={S.body}>
        <div ref={bodyRef} style={{ position: 'absolute', inset: 0 }} />
        {phase === 'loading' && <div style={S.state}>LOADING BOARD…</div>}
        {phase === 'error' && <div style={S.state}>加载失败：{error}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- 卡片（回合末尾，正文流）
interface PcbTailCardProps {
  matched?: PreviewPayload | null
  useSession?: UseSession
}

function PcbTailCard(props: PcbTailCardProps) {
  const preview = props.matched ?? null
  const [expanded, setExpanded] = useState(false)
  const st = usePanel()
  const s = preview?.stats ?? {}
  const isCurrent = st.preview?.key === preview?.key
  const shown = st.open && isCurrent
  const openWith = (mode: ViewMode) => setPanel({ preview, mode, open: true })

  if (!preview) return null
  return (
    <>
      <div style={S.card}>
        <BoardThumb preview={preview} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={S.cardTitle}>{preview.name}</span>
          <span style={S.cardMeta}>
            {s.widthMM ? `${s.widthMM}×${s.heightMM}mm · ${s.layers}层 · ${s.comps}器件 · ${s.traces}走线` : 'PCB'}
          </span>
        </div>
        <span style={S.strip}>
          <button
            type="button"
            style={{ ...S.btn, ...(shown && st.mode === '2d' ? S.btnOn : null) }}
            onClick={() => (shown && st.mode === '2d' ? setPanel({ open: false }) : openWith('2d'))}
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <rect x="1" y="1" width="12" height="12" rx="2" /><path d="M2 9l3-3 2.5 2.5L10 6l2 2" />
            </svg>
            显示 PCB
          </button>
          <button
            type="button"
            style={{ ...S.btn, ...(shown && st.mode === '3d' ? S.btnOn : null) }}
            onClick={() => (shown && st.mode === '3d' ? setPanel({ open: false }) : openWith('3d'))}
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
              <path d="M7 1.5l5 2.8v5.4L7 12.5 2 9.7V4.3z" /><path d="M2 4.3l5 2.8 5-2.8M7 7.1v5.4" />
            </svg>
            显示 3D
          </button>
          <button
            type="button"
            style={S.btn}
            title="在新标签页打开整页（左板子 + 右 3D）"
            onClick={() => window.open(webUrl(preview), '_blank', 'noopener')}
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v6A1.5 1.5 0 0 0 3.5 12h6A1.5 1.5 0 0 0 11 10.5V8" />
              <path d="M8.5 2H12v3.5M12 2L6.5 7.5" />
            </svg>
            浏览器打开
          </button>
        </span>
      </div>
      {shown && (
        <PcbPanel
          preview={preview}
          mode={st.mode}
          expanded={expanded}
          onMode={(m) => setPanel({ mode: m })}
          onToggleExpand={() => setExpanded((v) => !v)}
          onClose={() => { setExpanded(false); setPanel({ open: false }) }}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------- 会话观察器（渲染 null）
interface PreviewWatcherProps {
  useChat?: UseChat
  useSession?: UseSession
}

function PreviewWatcher({ useChat, useSession }: PreviewWatcherProps) {
  // 对话节点现在由 chat 视图提供（ChatSnapshot.legacy.nodes）；旧契约的 session.nodes 保留为回退。
  // 两个 hook 都无条件调用，保证 hook 顺序稳定。
  const chatNodes = useChat ? useChat((s) => (s && s.legacy && s.legacy.nodes) || EMPTY_NODES) : EMPTY_NODES
  const sessionNodes = useSession ? useSession((s) => (s && s.nodes) || EMPTY_NODES) : EMPTY_NODES
  const nodes = chatNodes.length > 0 ? chatNodes : sessionNodes
  useEffect(() => {
    const idx = indexPreviews(nodes)
    previewIndex.byTurn = idx.byTurn
    previewIndex.latest = idx.latest
  }, [nodes])
  return null
}

export function apply(ctx: ClientContext): void {
  // 观察器：常驻、无渲染，只维护 回合号→预览 映射
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'kicad-3d-viewer-watcher',
    order: 999,
    inject: () => ({}),
  }, PreviewWatcher))

  // 卡片：官方 deliverables 同一行（turn tail chain，正文流里，不悬浮）。
  // select 按回合号自我选举；priority -1 = 先于官方 deliverables（该回合有预览时优先出卡片），
  // 没有预览的回合 select 返回 null → 让位给官方行。
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    priority: -1,
    select: (owner: SessionOwner) => {
      const turn = owner?.turn?.turn
      return typeof turn === 'number' ? previewIndex.byTurn.get(turn) ?? null : null
    },
    inject: () => ({}),
  }, PcbTailCard))
}

// 渲染发生在浏览器半边（本文件即入口）；host 半边只负责取板子路径与统计。
export { inject }
export const internals = Object.freeze({ pickPreview, indexPreviews })

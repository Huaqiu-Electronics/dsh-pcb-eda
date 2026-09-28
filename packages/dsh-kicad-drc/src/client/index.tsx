/**
 * dsh-kicad-drc 浏览器半边：在对话轮次尾部渲染 DRC 报告分页卡片。
 *
 * 机制（与 @huaqiu/dsh-tool-pcb-viewer 相同）：
 * - host 端工具结果里带 {ok, viewUrl} JSON 块；
 * - PreviewWatcher 遍历会话树，把每轮 kicad_drc_run 的预览载荷索引到 turn 上；
 * - DrcTailCard 注册在 conversation.chat.turnTail 插槽，select() 按轮次取载荷，
 *   组件经 props.matched 收到载荷后 fetch(viewUrl) 拉取报告 JSON 并分页渲染。
 *
 * 两种视图：
 * - 紧凑卡片（轮次尾部）：加宽版小表格，每页 10 行；
 * - 大屏面板（点"放大查看"或按 Esc 关闭）：右侧全高面板，大字号表格，每页 25 行。
 *
 * 本文件由 tsdown 打包成 CJS factory（window.__ModuleLoader__.load 包装），
 * react / react/jsx-runtime 从 DSH 模块表 require（shell 提供单例）。
 */
import react from 'react'
import { pickPreview, indexPreviews, normalizeDrcReport, type DrcPreview, type DrcReportData } from './parse.ts'

/** 紧凑卡片每页行数。 */
const PAGE_SMALL = 10
/** 大屏面板每页行数。 */
const PAGE_LARGE = 25

type SeverityFilter = 'all' | 'error' | 'warning'

/* ---------- 报告缓存（同一 viewUrl 不重复拉取） ---------- */
const reportCache = new Map<string, Promise<DrcReportData>>()
const CACHE_CAP = 8
function loadReport(preview: DrcPreview): Promise<DrcReportData> {
  const cached = reportCache.get(preview.viewUrl)
  if (cached) return cached
  const p = fetch(preview.viewUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.text()
    })
    .then(normalizeDrcReport)
  reportCache.set(preview.viewUrl, p)
  if (reportCache.size > CACHE_CAP) {
    const oldest = reportCache.keys().next().value
    if (oldest !== undefined) reportCache.delete(oldest)
  }
  return p
}

/* ---------- 样式 ---------- */
const MONO = 'ui-monospace, Menlo, Consolas, monospace'
const S: Record<string, react.CSSProperties> = {
  /* 紧凑卡片 */
  card: {
    display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6, marginBottom: 6,
    padding: 12, borderRadius: 10, maxWidth: 640, width: 'fit-content',
    background: 'var(--dsw-alias-bg-layer-3, rgba(255,255,255,.03))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))',
  },
  head: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  title: {
    font: `600 13px ${MONO}`, color: 'var(--dsw-alias-label-primary, #e6e9ef)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280,
  },
  meta: { font: `11px ${MONO}`, color: 'var(--dsw-alias-label-tertiary, #93a1b0)', letterSpacing: '0.04em' },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    font: `600 11px ${MONO}`, color: 'var(--dsw-alias-label-primary, #e6e9ef)',
    background: 'rgba(95,224,205,.08)', border: '1px solid rgba(95,224,205,.35)',
    borderRadius: 5, padding: '3px 10px', cursor: 'pointer', whiteSpace: 'nowrap',
  },
  chipOn: { borderColor: '#5fe0cd', color: '#5fe0cd', boxShadow: '0 0 8px rgba(95,224,205,.2)' },
  btn: {
    font: `600 11px ${MONO}`, color: '#e6e9ef',
    background: 'rgba(95,224,205,.08)', border: '1px solid rgba(95,224,205,.35)',
    borderRadius: 5, padding: '3px 10px', cursor: 'pointer', whiteSpace: 'nowrap',
  },
  btnDisabled: { opacity: 0.35, cursor: 'default' },
  state: { font: `12px ${MONO}`, color: '#7d8b9a', padding: '6px 2px' },
  /* 紧凑表格 */
  table: { width: '100%', borderCollapse: 'collapse', font: `11px ${MONO}` },
  th: {
    textAlign: 'left', padding: '4px 8px', color: 'var(--dsw-alias-label-tertiary, #93a1b0)',
    borderBottom: '1px solid rgba(255,255,255,.1)', whiteSpace: 'nowrap', fontWeight: 600,
  },
  td: {
    padding: '5px 8px', color: 'var(--dsw-alias-label-primary, #e6e9ef)',
    borderBottom: '1px solid rgba(255,255,255,.05)', verticalAlign: 'top', lineHeight: 1.45,
  },
  pager: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' },
  /* 大屏面板 */
  panel: {
    position: 'fixed', top: 0, right: 0, height: '100vh', zIndex: 250,
    width: 'min(980px, 94vw)',
    background: '#0b0e13', borderLeft: '1px solid rgba(95,224,205,.25)',
    boxShadow: '-18px 0 60px rgba(0,0,0,.55)',
    display: 'flex', flexDirection: 'column', transition: 'width .25s ease',
  },
  panelHead: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px',
    borderBottom: '1px solid rgba(95,224,205,.14)', flex: '0 0 auto',
    font: `13px ${MONO}`, color: '#cdd8e4', userSelect: 'none',
  },
  panelTitle: { font: `600 14px ${MONO}`, color: '#5fe0cd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  closeBtn: {
    marginLeft: 'auto', font: `600 13px ${MONO}`, color: '#93a1b0',
    background: 'transparent', border: '1px solid rgba(255,255,255,.15)',
    borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
  },
  panelBody: { flex: 1, overflow: 'auto', padding: '14px 18px' },
  /* 大屏表格 */
  bigTable: { width: '100%', borderCollapse: 'collapse', font: `13px ${MONO}` },
  bigTh: {
    textAlign: 'left', padding: '8px 12px', color: '#93a1b0',
    borderBottom: '1px solid rgba(255,255,255,.12)', whiteSpace: 'nowrap', fontWeight: 600, position: 'sticky', top: 0, background: '#0b0e13',
  },
  bigTd: {
    padding: '9px 12px', color: '#e6e9ef',
    borderBottom: '1px solid rgba(255,255,255,.06)', verticalAlign: 'top', lineHeight: 1.5,
  },
}

const SEV_COLOR: Record<string, string> = { error: '#ff6b6b', warning: '#ffc94d', exclusion: '#7d8b9a' }

function sevBadge(sev: string): react.CSSProperties {
  return {
    display: 'inline-block', padding: '1px 7px', borderRadius: 4, whiteSpace: 'nowrap',
    font: `600 10px ${MONO}`, color: SEV_COLOR[sev] ?? '#7d8b9a',
    border: `1px solid ${SEV_COLOR[sev] ?? 'rgba(255,255,255,.2)'}`,
  }
}

/* ---------- 共享子组件 ---------- */
function Chips(props: { data: DrcReportData, filter: SeverityFilter, setFilter: (f: SeverityFilter) => void }) {
  const items: Array<[SeverityFilter, string]> = [
    ['all', `全部 ${props.data.totalIssues}`],
    ['error', `错误 ${props.data.totalErrors}`],
    ['warning', `警告 ${props.data.totalWarnings}`],
  ]
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {items.map(([f, label]) => (
        <button
          key={f}
          type="button"
          style={{ ...S.chip, ...(props.filter === f ? S.chipOn : null) }}
          onClick={() => props.setFilter(f)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function Pager(props: { rows: number, page: number, pageCount: number, size: number, setPage: (p: number) => void }) {
  const { rows, page, pageCount, size, setPage } = props
  return (
    <div style={S.pager}>
      <span style={S.meta}>{page * size + 1}–{Math.min(rows, (page + 1) * size)} / {rows}</span>
      <button type="button" style={{ ...S.btn, ...(page === 0 ? S.btnDisabled : null) }} onClick={() => page > 0 && setPage(page - 1)}>‹ 上一页</button>
      <span style={S.meta}>{page + 1} / {pageCount}</span>
      <button type="button" style={{ ...S.btn, ...(page >= pageCount - 1 ? S.btnDisabled : null) }} onClick={() => page < pageCount - 1 && setPage(page + 1)}>下一页 ›</button>
    </div>
  )
}

function ViolationTable(props: { rows: Array<{ severity: string, type: string, description: string, x?: number, y?: number }>, startIdx: number, big?: boolean }) {
  const th = props.big ? S.bigTh : S.th
  const td = props.big ? S.bigTd : S.td
  return (
    <table style={props.big ? S.bigTable : S.table}>
      <thead>
        <tr>
          <th style={th}>#</th>
          <th style={th}>级别</th>
          <th style={th}>类型</th>
          <th style={th}>描述</th>
          <th style={th}>位置</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((v, i) => (
          <tr key={props.startIdx + i}>
            <td style={{ ...td, whiteSpace: 'nowrap' }}>{props.startIdx + i + 1}</td>
            <td style={td}><span style={sevBadge(v.severity)}>{v.severity || '?'}</span></td>
            <td style={{ ...td, whiteSpace: 'nowrap' }}>{v.type}</td>
            <td style={td} title={v.description}>
              {props.big ? v.description : (v.description.length > 80 ? v.description.slice(0, 80) + '…' : v.description)}
            </td>
            <td style={{ ...td, whiteSpace: 'nowrap' }}>{v.x != null && v.y != null ? `(${v.x}, ${v.y})` : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Counts(props: { data: DrcReportData }) {
  const d = props.data
  return (
    <span style={S.meta}>
      {d.totalErrors > 0 ? `⛔ ${d.totalErrors} error` : ''}
      {d.totalErrors > 0 && d.totalWarnings > 0 ? ' · ' : ''}
      {d.totalWarnings > 0 ? `⚠ ${d.totalWarnings} warning` : ''}
      {d.totalIssues === 0 ? '无违规' : ''}
    </span>
  )
}

/* ---------- 轮次尾部报告卡片（紧凑）+ 大屏面板 ---------- */
function DrcTailCard(props: { matched?: DrcPreview | null }) {
  const preview = props.matched ?? null
  const [data, setData] = react.useState<DrcReportData | null>(null)
  const [error, setError] = react.useState<string | null>(null)
  const [filter, setFilter] = react.useState<SeverityFilter>('all')
  const [page, setPage] = react.useState(0)
  const [expanded, setExpanded] = react.useState(false)

  react.useEffect(() => {
    if (!preview) return
    let cancelled = false
    setData(null)
    setError(null)
    setPage(0)
    loadReport(preview)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [preview])

  // Esc 关闭大屏
  react.useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  if (!preview) return null

  // 紧凑 / 大屏共用同一份筛选与页码状态（页大小不同，切换时钳制）
  const size = expanded ? PAGE_LARGE : PAGE_SMALL
  const rows = data
    ? data.violations.filter((v) => filter === 'all' || v.severity === filter)
    : []
  const pageCount = Math.max(1, Math.ceil(rows.length / size))
  const clampedPage = Math.min(page, pageCount - 1)
  const pageRows = rows.slice(clampedPage * size, (clampedPage + 1) * size)

  return (
    <>
      <div style={S.card}>
        <div style={S.head}>
          <span style={S.title}>{preview.name || 'DRC 报告'}</span>
          {data && <Counts data={data} />}
          <button type="button" style={{ ...S.btn, marginLeft: 'auto' }} onClick={() => setExpanded(true)}>
            放大查看
          </button>
        </div>

        {!data && !error && <div style={S.state}>加载报告中…</div>}
        {error && <div style={S.state}>加载失败：{error}</div>}

        {data && (
          <>
            <Chips data={data} filter={filter} setFilter={(f) => { setFilter(f); setPage(0) }} />
            {rows.length === 0 ? (
              <div style={S.state}>该筛选条件下无违规项</div>
            ) : (
              <>
                <ViolationTable rows={pageRows} startIdx={clampedPage * size} />
                <Pager rows={rows.length} page={clampedPage} pageCount={pageCount} size={size} setPage={setPage} />
              </>
            )}
          </>
        )}
      </div>

      {expanded && (
        <div style={S.panel}>
          <div style={S.panelHead}>
            <span style={S.panelTitle}>{preview.name || 'DRC 报告'}</span>
            {data && <Counts data={data} />}
            <button type="button" style={S.closeBtn} onClick={() => setExpanded(false)}>关闭 Esc</button>
          </div>
          <div style={S.panelBody}>
            {!data && !error && <div style={S.state}>加载报告中…</div>}
            {error && <div style={S.state}>加载失败：{error}</div>}
            {data && (
              <>
                <Chips data={data} filter={filter} setFilter={(f) => { setFilter(f); setPage(0) }} />
                {rows.length === 0 ? (
                  <div style={{ ...S.state, marginTop: 12 }}>该筛选条件下无违规项</div>
                ) : (
                  <>
                    <div style={{ height: 14 }} />
                    <ViolationTable rows={pageRows} startIdx={clampedPage * size} big />
                    <Pager rows={rows.length} page={clampedPage} pageCount={pageCount} size={size} setPage={setPage} />
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/* ---------- Watcher：会话树变化时重建 turn → 预览索引 ---------- */
const EMPTY_NODES: unknown[] = []
const previewIndex: { byTurn: Map<number, DrcPreview>, latest: DrcPreview | null } = { byTurn: new Map(), latest: null }

function PreviewWatcher(props: {
  useChat?: (sel: (s: unknown) => unknown) => unknown
  useSession?: (sel: (s: unknown) => unknown) => unknown
}) {
  const chatNodes: unknown[] = props.useChat
    ? (props.useChat((s) => ((s as { legacy?: { nodes?: unknown[] } })?.legacy?.nodes) ?? EMPTY_NODES) as unknown[])
    : EMPTY_NODES
  const sessionNodes: unknown[] = props.useSession
    ? (props.useSession((s) => ((s as { nodes?: unknown[] })?.nodes) ?? EMPTY_NODES) as unknown[])
    : EMPTY_NODES
  const nodes = chatNodes.length > 0 ? chatNodes : sessionNodes

  react.useEffect(() => {
    const idx = indexPreviews(nodes)
    previewIndex.byTurn = idx.byTurn
    previewIndex.latest = idx.latest
  }, [nodes])

  return null
}

/* ---------- Cordis client 入口 ---------- */
interface SlotRegistration {
  name: string
  id?: string
  order?: number
  priority?: number
  select?: (owner: unknown) => unknown
  inject?: () => Record<string, unknown>
}
interface SlotsService {
  inject(slotName: string, register: () => void): void
  register(reg: SlotRegistration, component: unknown): unknown
}
interface ClientCtx {
  slots: SlotsService
}

export function apply(ctx: ClientCtx): void {
  // Watcher：挂在会话头部动作区（渲染 null，只负责维护索引）
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'dsh-kicad-drc-watcher',
    order: 999,
    inject: () => ({}),
  }, PreviewWatcher))

  // 轮次尾部卡片：select() 按轮次返回该轮的 DRC 预览载荷（无则 null，不渲染）
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    priority: -1,
    select: (owner) => {
      const turn = (owner as { turn?: { turn?: number } } | null)?.turn?.turn
      return typeof turn === 'number' ? previewIndex.byTurn.get(turn) ?? null : null
    },
    inject: () => ({}),
  }, DrcTailCard))
}

/** Cordis 服务注入声明（client 半边）。 */
export const inject = ['slots']

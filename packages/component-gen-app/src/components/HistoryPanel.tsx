/**
 * `@huaqiu/component-gen-app` — history panel.
 *
 * Reads `ports.history()` with cursor pagination; renders entries with
 * reopen / download / delete. Stays DSH-agnostic — actions resolve through
 * the ports, and artifact text comes from `ports.artifactContent`.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { ComponentGenPorts, HistoryEntry } from '../ports.js'
import type { Translate } from '../copy/index.js'
import { triggerDownload } from '../utils/ecad.js'

export interface HistoryPanelProps {
  ports: ComponentGenPorts
  t: Translate
  activeKind?: 'symbol' | 'footprint' | null
  onReopen: (entry: HistoryEntry) => void
}

const PAGE = 12

export function HistoryPanel({ ports, t, activeKind = null, onReopen }: HistoryPanelProps): ReactElement {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (nextCursor: string | null): Promise<void> => {
    setLoading(true)
    try {
      const page = await ports.history({ limit: PAGE, cursor: nextCursor })
      if (!nextCursor) setEntries(page.entries)
      else setEntries((prev) => [...prev, ...page.entries])
      setCursor(page.nextCursor ?? null)
      if (!page.nextCursor) setDone(true)
    } catch (e) {
      console.warn('[hq-component-gen] history load failed', e)
      setDone(true)
    } finally {
      setLoading(false)
    }
  }, [ports])

  useEffect(() => { void load(null) }, [load])

  const doDelete = useCallback(async (entry: HistoryEntry): Promise<void> => {
    setBusy(entry.id)
    try {
      await ports.deleteHistory(entry.id)
      setEntries((prev) => prev.filter((e) => e.id !== entry.id))
    } finally {
      setBusy(null)
    }
  }, [ports])

  const doDownload = useCallback(async (entry: HistoryEntry): Promise<void> => {
    if (!entry.result?.artifactId) return
    setBusy(entry.id)
    try {
      const content = await ports.artifactContent(entry.result.artifactId)
      const filename = entry.result.filename || `${entry.result.artifactId}.${entry.kind === 'symbol' ? 'kicad_sym' : 'kicad_mod'}`
      triggerDownload(filename, content)
    } catch (e) {
      console.warn('[hq-component-gen] history download failed', e)
    } finally {
      setBusy(null)
    }
  }, [ports])

  const visible = activeKind ? entries.filter((e) => e.kind === activeKind) : entries

  return (
    <div className="cga-history">
      {visible.length === 0 && !loading
        ? <div className="cga-upload__text">{t('history.empty')}</div>
        : null}
      {visible.map((entry) => (
        <div className="cga-history__item" key={entry.id}>
          <div className="cga-history__meta">
            <span className="cga-history__title">
              {entry.kind === 'symbol' ? t('history.symbol') : t('history.footprint')}
              {' — '}
              {entry.result?.filename ?? entry.id.slice(0, 8)}
            </span>
            <span className="cga-history__sub">
              {new Date(entry.createdAt).toLocaleString()} · {t(`history.${entry.status}`)}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {entry.status === 'generated' && entry.result?.artifactId
              ? (
                <>
                  <button type="button" className="cga-history__act" disabled={busy === entry.id} onClick={() => onReopen(entry)}>
                    {t('history.reopen')}
                  </button>
                  <button type="button" className="cga-history__act" disabled={busy === entry.id} onClick={() => void doDownload(entry)}>
                    {t('history.download')}
                  </button>
                </>
              )
              : null}
            <button type="button" className="cga-history__act" disabled={busy === entry.id} onClick={() => void doDelete(entry)}>
              {t('history.delete')}
            </button>
          </div>
        </div>
      ))}
      {!done && visible.length > 0
        ? (
          <button type="button" className="cga-btn" disabled={loading} onClick={() => void load(cursor)}>
            {loading ? t('app.loading') : t('history.loadMore')}
          </button>
        )
        : null}
    </div>
  )
}

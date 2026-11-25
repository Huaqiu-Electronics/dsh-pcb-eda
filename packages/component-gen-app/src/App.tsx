/**
 * `@huaqiu/component-gen-app` — the app shell.
 *
 * Renders one of the two generation pages (the host opens the page directly).
 * History lives in a modal dialog opened from the header's "View history"
 * action (mirroring dsh's settings-dialog header action beside the close
 * button); reopening an entry closes the dialog and loads the artifact back
 * into the page. Completely DSH-agnostic — everything the app needs comes
 * through `ComponentGenPorts`.
 */
import { useMemo, useState, type ReactElement } from 'react'
import type { ComponentGenPage, ComponentGenPorts, ReopenRequest } from './ports.js'
import { translateFor, type Translate } from './copy/index.js'
import { SymbolGenPage } from './pages/SymbolGenPage.js'
import { FootprintGenPage } from './pages/FootprintGenPage.js'
import { HistoryPanel } from './components/HistoryPanel.js'

export interface ComponentGenAppProps {
  ports: ComponentGenPorts
  page: ComponentGenPage
  /** host UI language: 'zh' | 'en' (default zh). */
  lang?: string
  onClose?: () => void
}

/** Modal history dialog — chrome follows dsh's Modal primitive. */
function HistoryDialog({
  ports, page, t, onReopen, onClose,
}: {
  ports: ComponentGenPorts
  page: ComponentGenPage
  t: Translate
  onReopen: (entry: ReopenRequest['entry']) => void
  onClose: () => void
}): ReactElement {
  return (
    <div className="cga-history-dialog" role="presentation">
      <div className="cga-history-dialog__mask" aria-hidden="true" onClick={onClose} />
      <div className="cga-history-dialog__panel" role="dialog" aria-modal="true" aria-label={t('history.title')}>
        <div className="cga-history-dialog__head">
          <span className="cga-history-dialog__title">{t('history.title')}</span>
          <button type="button" className="cga-app__head-close" aria-label={t('app.close')} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="cga-history-dialog__body">
          <HistoryPanel ports={ports} t={t} activeKind={page} onReopen={onReopen} />
        </div>
      </div>
    </div>
  )
}

export function ComponentGenApp(props: ComponentGenAppProps): ReactElement {
  const { ports, page, lang, onClose } = props
  const t: Translate = useMemo(() => translateFor(lang), [lang])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [reopenReq, setReopenReq] = useState<ReopenRequest | null>(null)
  // Only forward a reopen request whose kind matches the active page (history
  // is already filtered by activeKind, but the request must not leak across a
  // tab switch).
  const pageReopen = reopenReq && reopenReq.entry.kind === page ? reopenReq : null

  const openHistory = (entry: ReopenRequest['entry']): void => {
    // Reopening lands back in the workspace, so drop the dialog too.
    setHistoryOpen(false)
    setReopenReq((prev) => ({ n: (prev?.n ?? 0) + 1, entry }))
  }

  return (
    <div className="cga-app">
      <div className="cga-app__head">
        <span className="cga-app__head-title">
          {page === 'symbol' ? t('app.symbolTitle') : t('app.footprintTitle')}
        </span>
        <div className="cga-app__head-actions">
          <button type="button" className="cga-btn cga-btn--outline" onClick={() => setHistoryOpen(true)}>
            {t('history.view')}
          </button>
          {onClose ? (
            <button type="button" className="cga-app__head-close" aria-label={t('app.close')} onClick={onClose}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      <div className="cga-app__body">
        {page === 'symbol'
          ? <SymbolGenPage ports={ports} t={t} reopen={pageReopen} />
          : <FootprintGenPage ports={ports} t={t} reopen={pageReopen} />}
      </div>

      {historyOpen
        ? <HistoryDialog ports={ports} page={page} t={t} onReopen={openHistory} onClose={() => setHistoryOpen(false)} />
        : null}
    </div>
  )
}

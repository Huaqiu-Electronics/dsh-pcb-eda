/**
 * About row content, following the reference prototype:
 *
 *   [HuaQiu brand mark]
 *   {slogan}
 *   [DSH 运行时 0.1.0]              (runtime label + this plugin's version)
 *   ┌───────────────────────────┐
 *   │ 发行版本        0.1.5-rc.2 │  (Distribution label + bundled DSH version)
 *   │ 内置插件版本    0.1.0      │  (Builtin plugin version = plugin version)
 *   │ 复制元数据  deepseek-harness ↗       │
 *   └───────────────────────────┘
 *   © 2026 深圳华秋智联股份有限公司
 *   由 DSH 提供支持
 *
 * The two versions are fetched from the node half's same-origin route
 * (`GET /api/v1/huaqiu/about` → `{ version, dshVersion }`): the DSH Runtime
 * badge and the Builtin plugin version row both show this plugin's declared
 * version, the Distribution version is the DSH version bundled with the
 * running harness. The block is vertically compact like the prototype — it
 * centers as one dense unit instead of stretching across the panel. All text
 * lines are localised.
 */
import { createElement, useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { HuaqiuBrandMark } from './HuaqiuBrand'

const ROOT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  boxSizing: 'border-box',
  gap: 14,
  padding: '16px 24px',
  textAlign: 'center',
}

const TOP: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
}

const TITLE: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 20,
  fontWeight: 700,
  letterSpacing: '0.01em',
}

const BADGE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 12px',
  borderRadius: 999,
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: 'var(--dsw-alias-label-secondary)',
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent)',
  border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)',
}

const BADGE_VALUE: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontWeight: 600,
}

const META_BOX: CSSProperties = {
  width: '100%',
  maxWidth: 360,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 14px',
  borderRadius: 12,
  fontSize: 12,
  textAlign: 'left',
  color: 'var(--dsw-alias-label-primary)',
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent)',
  border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent)',
  boxSizing: 'border-box',
}

const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
}

const ROW_LABEL: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
}

const VERSION_PILL: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontWeight: 500,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  padding: '1px 8px',
  borderRadius: 6,
  background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)',
  border: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent)',
}

const ROW_BOTTOM: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  paddingTop: 8,
  borderTop: '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)',
  fontSize: 11,
}

const ACTION: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: 'none',
  background: 'none',
  padding: 0,
  cursor: 'pointer',
  font: 'inherit',
  color: 'var(--dsw-alias-label-tertiary)',
}

const ACTION_COPIED: CSSProperties = {
  ...ACTION,
  color: 'var(--dsw-alias-state-success, #34c759)',
  fontWeight: 500,
}

const LINK: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  textDecoration: 'none',
  color: 'var(--dsw-alias-label-tertiary)',
}

const FOOTER: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const COPYRIGHT: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-secondary)',
  margin: 0,
}

const POWERED: CSSProperties = {
  fontSize: 11,
  color: 'var(--dsw-alias-label-tertiary)',
  margin: 0,
}

/** Same-origin route mounted by the node half (see `src/index.ts`). */
const ABOUT_ROUTE = '/api/v1/huaqiu/about'

const GITHUB_URL = 'https://github.com/deepseek-ai/deepseek-harness'

interface AboutPayload {
  version?: unknown
  dshVersion?: unknown
}

export interface AboutSectionProps {
  /** Bound locale dictionary (injected by the client entry). */
  t: (key: string) => string
}

export function AboutSection({ t }: AboutSectionProps): ReactElement {
  const [version, setVersion] = useState<string | null>(null)
  const [dshVersion, setDshVersion] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    void fetch(ABOUT_ROUTE)
      .then((res) => (res.ok ? res.json() as Promise<AboutPayload> : null))
      .then((body) => {
        if (!alive) return
        setVersion(body && typeof body.version === 'string' ? body.version : null)
        setDshVersion(
          body && typeof body.dshVersion === 'string' ? body.dshVersion : null,
        )
      })
      .catch(() => { if (alive) { setVersion(null); setDshVersion(null) } })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copyMeta = (): void => {
    const runtime = version ?? '-'
    const dist = dshVersion ?? '-'
    const text = [
      `App: ${t('slogan')}`,
      `DSH Runtime: ${runtime}`,
      `Release: ${dist}`,
      `Copyright: ${t('copyright')}`,
    ].join('\n')
    void navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
  }

  return createElement(
    'div',
    { style: ROOT },
    createElement(
      'div',
      { style: TOP },
      createElement(HuaqiuBrandMark, { size: 64 }),
      createElement('div', { style: TITLE }, t('slogan')),
      createElement(
        'div',
        { style: BADGE },
        createElement('span', null, t('runtimeLabel')),
        createElement('span', { style: BADGE_VALUE }, version ?? ''),
      ),
    ),
    createElement(
      'div',
      { style: META_BOX },
      createElement(
        'div',
        { style: ROW },
        createElement('span', { style: ROW_LABEL }, t('distributionLabel')),
        createElement('span', { style: VERSION_PILL }, dshVersion ?? ''),
      ),
      createElement(
        'div',
        { style: ROW },
        createElement('span', { style: ROW_LABEL }, t('builtinPluginLabel')),
        createElement('span', { style: VERSION_PILL }, version ?? ''),
      ),
      createElement(
        'div',
        { style: ROW_BOTTOM },
        createElement(
          'button',
          { style: copied ? ACTION_COPIED : ACTION, onClick: copyMeta, type: 'button' },
          createElement('span', null, copied ? t('copied') : t('copyMetadata')),
        ),
        createElement(
          'a',
          { style: LINK, href: GITHUB_URL, target: '_blank', rel: 'noreferrer' },
          createElement('span', null, 'deepseek-harness'),
          createElement('span', { style: { fontSize: 9, opacity: 0.7 } }, '↗'),
        ),
      ),
    ),
    createElement(
      'div',
      { style: FOOTER },
      createElement('p', { style: COPYRIGHT }, t('copyright')),
      createElement('p', { style: POWERED }, t('poweredBy')),
    ),
  )
}

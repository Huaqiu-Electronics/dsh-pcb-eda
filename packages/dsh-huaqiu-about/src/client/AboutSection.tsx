/**
 * About row content: the original DSH fish mark, the DSH version bundled with
 * the running harness, and the "Powered by DSH" claim.
 *
 * The version is fetched from the node half's same-origin route
 * (`GET /api/v1/huaqiu/about`); when it is unreachable or carries no version,
 * the version line is omitted and the mark plus claim still render.
 */
import { createElement, useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'

const ROOT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  minHeight: 360,
  boxSizing: 'border-box',
  gap: 16,
  padding: '24px',
  textAlign: 'center',
}

const CLAIM: CSSProperties = {
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 18,
  fontWeight: 600,
  letterSpacing: '0.02em',
}

const VERSION: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
}

/** Same-origin route mounted by the node half (see `src/index.ts`). */
const ABOUT_ROUTE = '/api/v1/huaqiu/about'

export function AboutSection(): ReactElement {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void fetch(ABOUT_ROUTE)
      .then((res) => (res.ok ? res.json() as Promise<{ version?: unknown }> : null))
      .then((body) => {
        const value = body && typeof body.version === 'string' ? body.version : null
        if (alive) setVersion(value)
      })
      .catch(() => { if (alive) setVersion(null) })
    return () => { alive = false }
  }, [])

  return createElement(
    'div',
    { style: ROOT },
    createElement(FishLogo, { size: 48 }),
    createElement('div', { style: CLAIM }, 'Powered by DSH'),
    version === null
      ? null
      : createElement('div', { style: VERSION }, `DSH ${version}`),
  )
}

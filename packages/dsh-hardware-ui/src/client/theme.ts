/**
 * Design tokens for the Hardware Engineering surfaces.
 *
 * Structure and geometry follow the product prototype (layered dark panels,
 * 12px cards, 11px type, mono numerals, a red primary action); the colours are
 * DSH alias tokens with the prototype values as fallbacks, so the panel stays
 * legible in the light theme instead of hard-coding a dark palette.
 */
import type { CSSProperties } from 'react'

export const MONO = 'ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace'

export const C = {
  base: 'var(--dsw-alias-bg-base, #161618)',
  panel: 'var(--dsw-alias-bg-layer-1, #1d1d20)',
  card: 'var(--dsw-alias-bg-layer-2, #202024)',
  raised: 'var(--dsw-alias-bg-layer-3, #2a2a2e)',
  /**
   * Nested surface inside a panel (cards, bars, chips).
   *
   * The theme's layer stack collapses to one white in the light theme, so layer-2
   * there is indistinguishable from the panel behind it, while in the dark theme
   * it is the visibly raised step. Deriving the surface from the theme's own ink
   * instead — 5% of `label-primary` over `layer-1` — gives rgb(243 244 244) on
   * white and rgb(46 46 47) on near-black: a step in both themes, from one
   * expression. The fallbacks keep a token-less host on the old dark surface.
   */
  inset: 'color-mix(in srgb, var(--dsw-alias-label-primary, #ececee) 5%, var(--dsw-alias-bg-layer-1, #1d1d20))',
  /** Theme-independent neutral wash for chips and tracks (alpha of mid grey). */
  neutral: 'rgba(127,127,127,0.16)',
  /** The 6px progress track, a touch stronger than a chip. */
  track: 'rgba(127,127,127,0.28)',
  /** Modal scrim: the theme decides how far a mask dims what is behind it. */
  scrim: 'var(--dsw-alias-bg-mask-3, rgba(0,0,0,0.48))',
  /** Lighter veil for a dialog stacked on an already dimmed page. */
  veil: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.4))',
  /** Shadow colour for raised surfaces (softer in the light theme). */
  shadow: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.4))',
  border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.24))',
  borderSoft: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.14))',
  text: 'var(--dsw-alias-label-primary, #ececee)',
  text2: 'var(--dsw-alias-label-secondary, #a1a1aa)',
  text3: 'var(--dsw-alias-label-tertiary, #71717a)',
  /** Link/accent ink that stays legible on white and on near-black. */
  link: 'var(--dsw-alias-link, #4176e6)',
  /** Amber ink for the optional tool, readable on both themes. */
  warnLabel: 'var(--dsw-alias-state-warn-label, #dd8629)',
  accent: '#e1251b',
  accentHover: '#c41e15',
  accentSoft: 'rgba(225, 37, 27, 0.15)',
  ok: '#34d399',
  okSoft: 'rgba(52, 211, 153, 0.14)',
  warn: '#fbbf24',
  warnSoft: 'rgba(251, 191, 36, 0.14)',
  info: '#38bdf8',
  infoSoft: 'rgba(56, 189, 248, 0.14)',
  violet: '#a78bfa',
  pink: '#f472b6',
} as const

export const R = { sm: 6, md: 8, lg: 12, pill: 999 } as const

export const DOT_COLORS = {
  schematic: C.info,
  pcb: C.ok,
  bom: C.pink,
  '3d': C.warn,
  order: C.accent,
} as const

export function cardStyle(extra?: CSSProperties): CSSProperties {
  return {
    border: `1px solid ${C.border}`,
    borderRadius: R.lg,
    background: C.inset,
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minWidth: 0,
    ...extra,
  }
}

export const SECTION_TITLE: CSSProperties = {
  margin: 0,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.2,
  color: C.text2,
  textTransform: 'uppercase',
}

export const MUTED: CSSProperties = { margin: 0, fontSize: 11, lineHeight: 1.55, color: C.text3 }

export const MONO_TEXT: CSSProperties = { fontFamily: MONO, fontVariantNumeric: 'tabular-nums' }

export function dotStyle(color: string, size = 7): CSSProperties {
  return { width: size, height: size, borderRadius: R.pill, background: color, flex: '0 0 auto' }
}

export function pillStyle(tone: 'ok' | 'warn' | 'info' | 'muted' | 'accent' = 'muted', extra?: CSSProperties): CSSProperties {
  const tones = {
    ok: { color: C.ok, background: C.okSoft, border: 'rgba(52, 211, 153, 0.28)' },
    warn: { color: C.warn, background: C.warnSoft, border: 'rgba(251, 191, 36, 0.28)' },
    info: { color: C.info, background: C.infoSoft, border: 'rgba(56, 189, 248, 0.28)' },
    accent: { color: C.accent, background: C.accentSoft, border: 'rgba(225, 37, 27, 0.32)' },
    muted: { color: C.text3, background: 'transparent', border: C.border },
  } as const
  const tone_ = tones[tone]
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '1px 7px',
    borderRadius: R.pill,
    border: `1px solid ${tone_.border}`,
    background: tone_.background,
    color: tone_.color,
    fontSize: 10,
    lineHeight: 1.6,
    whiteSpace: 'nowrap',
    fontFamily: MONO,
    ...extra,
  }
}

export function buttonStyle(kind: 'primary' | 'secondary' | 'quiet' = 'secondary', extra?: CSSProperties): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '5px 10px',
    borderRadius: R.md,
    font: 'inherit',
    fontSize: 11,
    fontWeight: 500,
    lineHeight: 1.4,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'background 120ms ease, border-color 120ms ease, opacity 120ms ease',
  }
  if (kind === 'primary') {
    return {
      ...base,
      border: '1px solid transparent',
      background: C.accent,
      color: '#fff',
      boxShadow: '0 6px 16px rgba(225, 37, 27, 0.22)',
      ...extra,
    }
  }
  if (kind === 'quiet') {
    return { ...base, border: '1px solid transparent', background: 'transparent', color: C.text2, ...extra }
  }
  return {
    ...base,
    border: `1px solid ${C.border}`,
    background: C.raised,
    color: C.text,
    ...extra,
  }
}

export const INPUT: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '5px 8px',
  borderRadius: R.md,
  border: `1px solid ${C.border}`,
  background: C.base,
  color: C.text,
  font: 'inherit',
  fontSize: 11,
  fontFamily: MONO,
}

export const SELECT: CSSProperties = { ...INPUT, cursor: 'pointer' }

export function disabled(active: boolean): CSSProperties {
  return active ? { opacity: 0.45, cursor: 'not-allowed', boxShadow: 'none' } : {}
}

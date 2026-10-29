/**
 * `@huaqiu/dsh-tool-plugin-update` — browser half.
 *
 * Mounts one sidebar toolbutton in the Huaqiu family block ("插件更新") with a
 * numeric badge equal to the number of updates still on offer:
 *
 *   - the actionable plugin items (spec §6.3/§7.1 — compatible `update` +
 *     `install` after host/HQ-Edge filtering, minus the ignored offer and any
 *     muted item), PLUS
 *   - one for the HQ Edge runtime update when hq-edge reports one (a separate
 *     deliverable with its own card, still a pending update — see `badge.ts`).
 *
 * The durable job history never contributes (a settled job is not an update);
 * a job that is still running is the only non-offer allowed to show a count.
 * Click opens the review/confirm/ignore modal.
 *
 * The authoritative state is the hq-edge report fetched through the plugin's
 * same-origin forwarding routes. A tiny in-memory store owns the latest report
 * + installing flag; the sidebar badge and the modal subscribe to it. No
 * timers beyond the install-poll and an idle 60 s refresh.
 *
 * @module
 */
import {
  HUAQIU_SIDEBAR_ENTRY_FAMILY,
  detectHostLocale,
  mountSidebarEntry,
  observeHostLocale,
  type HostLocale,
} from '@huaqiu/dsh-sidebar-entry'
import {
  checkUpdates,
  fetchActivity,
  fetchJobStatus,
  fetchReport,
  TERMINAL_PHASES,
  type PluginUpdateReport,
  type UpdateActivity,
  type UpdateJob,
  type UpdateJobStatus,
} from './api.js'
import { COPY } from './copy.js'
import { PLUGIN_ICON } from './icons.js'
import { openUpdateView, type UpdateStoreLike } from './update-view.js'
import { badgeCountFor } from './badge.js'

/** Stable data attributes identifying the injected entry row. */
export const UPDATE_ENTRY_SELECTOR = '[data-hq-plugin-update-entry]'
export const UPDATE_ENTRY_ATTRIBUTE = 'data-hq-plugin-update-entry'

/** L2 semantic plugin id: rows carry data-dsh-plugin + data-dsh-part. */
const PLUGIN_ID = 'huaqiu-plugin-update'

/** Row class names (defined by {@link ENTRY_CSS_TEXT}). */
const ENTRY_CSS: Record<string, string> = {
  entry: 'hqpu-sidebar-entry',
  entryIcon: 'hqpu-sidebar-entry__icon',
  entryLabel: 'hqpu-sidebar-entry__label',
  entryBadge: 'hqpu-sidebar-entry__badge',
}

/** Localized row copy: zh is the fallback, matching the family convention. */
function entryCopy(lang: HostLocale | undefined): { label: string; tooltip: string } {
  return lang === 'en'
    ? { label: COPY.en.entryLabel, tooltip: COPY.en.entryTooltip }
    : { label: COPY.zh.entryLabel, tooltip: COPY.zh.entryTooltip }
}

/** The sidebar glyph — the same pinwheel the shell's own Plugins entry draws
 *  (`IconPluginPinwheelOutlineRegular`), so both rows read as one feature. */
export const UPDATE_ICON = PLUGIN_ICON(16)

/** Sidebar entry styles — matched to the family rows (same inset/padding/gap
 *  as the shell's own Plugins entry, `SidebarRoot.module.css` `.panelRow`).
 *  Every colour rides a `--dsw-alias-*` token so the row follows the shell's
 *  light/dark theme; the badge foreground uses the toast label, the shell's
 *  "always light ink on a saturated surface" token. */
const ENTRY_CSS_TEXT = `
.hqpu-sidebar-entry {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin: 0 2px;
  min-height: 36px;
  padding: 7px 8px;
  background: transparent;
  border: none;
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font: inherit;
  line-height: 22px;
  text-align: left;
  white-space: nowrap;
}
.hqpu-sidebar-entry:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.hqpu-sidebar-entry[data-active] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.hqpu-sidebar-entry:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.hqpu-sidebar-entry__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.hqpu-sidebar-entry__icon svg {
  display: block;
  width: 16px;
  height: 16px;
}
.hqpu-sidebar-entry__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.hqpu-sidebar-entry__badge {
  flex: none;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-toast-label);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
/* Collapsed rail: icon-only, centered — same 36px square the shell uses.
   The update-count badge moves to the button's bottom-right corner. The
   sidebar-entry helper only renders the badge element while count > 0, so a
   zero count shows a bare icon with no dot. */
[data-sidebar-collapsed] .hqpu-sidebar-entry {
  position: relative;
  justify-content: center;
  width: 36px;
  height: 36px;
  margin: 0;
  padding: 0;
}
[data-sidebar-collapsed] .hqpu-sidebar-entry__icon svg {
  width: 18px;
  height: 18px;
}
[data-sidebar-collapsed] .hqpu-sidebar-entry__label {
  display: none;
}
[data-sidebar-collapsed] .hqpu-sidebar-entry__badge {
  /* Corner count badge: overlaps the icon's bottom-right like a notification
     dot. The ring uses the rail's own fill (HuaQiu override when the theme is
     mounted, shell layer-1 otherwise) so it reads on any sidebar surface. */
  position: absolute;
  right: 0;
  bottom: 0;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  font-size: 9px;
  line-height: 14px;
  box-shadow: 0 0 0 1.5px var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1));
  transform: translate(12%, 12%);
}
`

/**
 * View styles (hqpu-*). Plain overlay + panel, drawn with the SAME design
 * tokens and geometry the shell's own plugin manager uses
 * (`ui-plugin-manager/src/client/PluginManagerPage.module.css` +
 * `ui-primitives/src/{Modal,Toast,Tag,StateDot}.module.css`), so this page
 * reads as part of the product rather than a bolt-on.
 *
 * Two rules keep it honest across themes:
 *   1. every colour is a `--dsw-alias-*` token — no literal hex/rgb, so light
 *      and dark both come out right (the old sheet invented
 *      `--dsw-alias-bg-surface` / `--dsw-alias-line-border` / `--dsw-alias-bg-badge`,
 *      none of which exist, and so always fell back to a white panel);
 *   2. `color-mix()` tints come from the state token itself, so a palette
 *      change moves fill and ink together.
 *
 * The chrome (panel, scrim, header, footer) follows `ui-primitives/Modal`,
 * because this view IS a dialog; the body follows `PluginManagerPage`, because
 * that is the content it heads. The one token the bundled shell does not
 * publish is backfilled by {@link ensureDesignTokens} — see the note there.
 */
const VIEW_CSS_TEXT = `
/* ── Overlay + panel ─────────────────────────────────────────────────────
 * A 360 px card, the width the prototype fixes: the panel is a decision
 * surface inside the EDA workbench, not a page, and 360 is the width at which
 * a card's title, version row and two actions still fit on one line each. */
.hqpu-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  /* The frame's own top inset keeps a tall card clear of the window chrome. */
  padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px;
}
.hqpu-scrim {
  position: absolute;
  /* Only paint excludes the native caption; the root still blocks clicks. */
  inset: var(--dsh-frame-chrome-top, 0px) 0 0;
  background: var(--dsw-alias-bg-mask-3, var(--dsw-alias-bg-mask-1));
  animation: hqpu-fade var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease);
}
.hqpu-panel {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: min(360px, calc(100vw - 24px));
  max-height: min(86vh, 720px);
  overflow: hidden;
  border: 0.5px solid var(--hq-border);
  border-radius: 12px;
  background: var(--hq-bg);
  color: var(--hq-text);
  box-shadow: var(--dsw-elevation-prominent, 0 16px 48px rgba(0, 0, 0, 0.24));
  animation: hqpu-panel-in var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease);
}
.hqpu-panel:focus {
  outline: none;
}
.hqpu-panel *,
.hqpu-panel *::before,
.hqpu-panel *::after {
  box-sizing: border-box;
}
/* 'hidden' is the one display switch this sheet uses for drawers, so it has to
 * beat the layout rules below it. */
.hqpu-panel [hidden] {
  display: none !important;
}

/* The palette, expressed once. Every rule below reads these aliases, so a
 * theme switch (or the HuaQiu brand override) needs no rule to change. */
.hqpu-panel,
.hqpu-panel * {
  --hq-bg: var(--dsw-alias-bg-layer-1);
  --hq-card: var(--dsw-alias-bg-layer-2);
  --hq-card-soft: var(--dsw-alias-bg-overlay);
  --hq-border: var(--dsw-alias-border-l2);
  --hq-border-strong: var(--dsw-alias-border-l3);
  --hq-hover: var(--dsw-alias-interactive-bg-hover);
  --hq-text: var(--dsw-alias-label-primary);
  --hq-muted: var(--dsw-alias-label-secondary);
  --hq-faint: var(--dsw-alias-label-tertiary);
  --hq-brand: var(--dsw-alias-brand-primary);
  --hq-brand-soft: var(--dsw-alias-button-primary-hover);
  --hq-brand-dim: var(--dsw-alias-button-primary-dimmed);
  --hq-emerald: var(--dsw-alias-state-success-primary);
  --hq-amber: var(--dsw-alias-state-warn-primary);
  --hq-amber-ink: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
  /* Ink on an amber fill. Fixed rather than themed: warn-primary is a bright
   * amber in both themes, so the readable ink is the same warm near-black. */
  --hq-on-amber: #2b1a00;
  --hq-rose: var(--dsw-alias-state-error-primary);
  /* Ink on a saturated fill. 'toast-label' is white in both themes and is
   * backfilled by ensureDesignTokens when the shell omits it. */
  --hq-on-accent: var(--dsw-alias-brand-primary-invert, var(--dsw-alias-toast-label, #fff));
  --hq-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  /* One type scale: 9.5 / 10.5 / 11.5 / 12 / 13. Nothing inline, nothing
   * inherited from the shell's 20 px body default. */
  --hq-fs-micro: 9.5px;
  --hq-fs-meta: 10.5px;
  --hq-fs-body: 11.5px;
  --hq-fs-title: 13px;
}

@keyframes hqpu-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes hqpu-panel-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

/* ── Header ──────────────────────────────────────────────────────────────
 * Title + the set version / check time, then four icon actions in the order
 * the prototype fixes: refresh · sources · job log · close. */
.hqpu-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 0.5px solid var(--hq-border);
  background: var(--hq-bg);
}
.hqpu-head-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.hqpu-brand-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--hq-brand) 12%, transparent);
  color: var(--hq-brand-soft);
}
.hqpu-brand-icon svg {
  display: block;
}
.hqpu-title-block {
  min-width: 0;
}
.hqpu-title {
  margin: 0;
  font-size: var(--hq-fs-title);
  font-weight: 600;
  line-height: 17px;
  color: var(--hq-text);
}
.hqpu-sub {
  margin: 1px 0 0;
  font-size: var(--hq-fs-meta);
  line-height: 14px;
  color: var(--hq-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hqpu-toolbar {
  display: flex;
  align-items: center;
  flex: none;
  gap: 1px;
}
.hqpu-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--hq-muted);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.hqpu-icon-btn svg {
  display: block;
}
.hqpu-icon-btn:hover:not(:disabled) {
  background: var(--hq-hover);
  color: var(--hq-text);
}
.hqpu-icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
/* A toggled toolbar button (sources, job log) reads as "on", not just hovered —
 * the pressed state is the only hint that a drawer is open behind the body. */
.hqpu-icon-btn[aria-pressed='true'] {
  background: var(--hq-hover);
  color: var(--hq-text);
}
.hqpu-icon-btn--close {
  margin-left: 4px;
  color: var(--hq-faint);
}
.hqpu-icon-btn--sm {
  width: 24px;
  height: 24px;
  border-radius: 6px;
}

/* ── Settings strip (gear) ───────────────────────────────────────────────
 * Above the body, never inside it: opening the source editor must not reflow
 * the list the person was reading. */
.hqpu-settings {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 0.5px solid var(--hq-border);
  background: var(--hq-card-soft);
}
.hqpu-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.hqpu-settings-title {
  font-size: var(--hq-fs-meta);
  font-weight: 600;
  color: var(--hq-muted);
}
.hqpu-origin-badge {
  flex: none;
  padding: 1px 6px;
  border: 0.5px solid;
  border-radius: 4px;
  font-size: var(--hq-fs-micro);
}
.hqpu-origin-badge[data-origin='config'] {
  color: var(--hq-emerald);
  border-color: color-mix(in srgb, var(--hq-emerald) 40%, transparent);
  background: color-mix(in srgb, var(--hq-emerald) 10%, transparent);
}
.hqpu-origin-badge[data-origin='override'] {
  color: var(--hq-amber-ink);
  border-color: color-mix(in srgb, var(--hq-amber) 40%, transparent);
  background: color-mix(in srgb, var(--hq-amber) 10%, transparent);
}
.hqpu-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.hqpu-field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.hqpu-field label {
  font-size: var(--hq-fs-micro);
  color: var(--hq-muted);
}
.hqpu-source-input {
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border: 0.5px solid var(--hq-border-strong);
  border-radius: 6px;
  background: var(--hq-bg);
  color: var(--hq-muted);
  font-family: var(--hq-mono);
  font-size: var(--hq-fs-micro);
}
.hqpu-source-input:disabled {
  opacity: 0.6;
}
.hqpu-settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  padding-top: 2px;
}

/* ── Body: scroll + sticky footer + the log drawer over both ─────────────
 * '.hqpu-main' is the positioning box; the drawer covers the body AND the
 * footer, so an open log cannot be clicked through. */
.hqpu-main {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
/* While the job-log drawer is open it covers this whole box; on a short body
 * the box would collapse to nothing, so give it a floor. Set/cleared from
 * update-view.ts (the drawer is absolutely positioned and cannot size it). */
.hqpu-main[data-log-open='1'] {
  min-height: 340px;
}
.hqpu-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  background: var(--hq-bg);
  /* Anything that scrolls inside the panel draws the l2 thumb. */
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.hqpu-column {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* A stack of groups (or the single toast host) inside the column. */
.hqpu-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hqpu-stack:empty {
  display: none;
}

/* ── Decision band ───────────────────────────────────────────────────────
 * The one row that answers "is there anything for me to do", before any list. */
.hqpu-decision {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--hq-card-soft);
  font-size: var(--hq-fs-meta);
}
.hqpu-decision-main {
  font-weight: 600;
  color: var(--hq-text);
}
.hqpu-decision-dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--hq-faint);
}
.hqpu-decision-sub {
  color: var(--hq-muted);
}

/* ── Section head ────────────────────────────────────────────────────────── */
.hqpu-sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 2px 2px;
}
.hqpu-sec-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--hq-fs-body);
  font-weight: 600;
  color: var(--hq-text);
}
.hqpu-count-pill {
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--hq-brand) 14%, transparent);
  color: var(--hq-brand-soft);
  font-family: var(--hq-mono);
  font-size: var(--hq-fs-micro);
  font-weight: 700;
}

/* ── Text links ──────────────────────────────────────────────────────────── */
.hqpu-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--hq-muted);
  font: inherit;
  font-size: var(--hq-fs-meta);
  cursor: pointer;
  transition: color 0.15s ease;
}
.hqpu-link:hover {
  color: var(--hq-text);
}
.hqpu-link--tiny {
  font-size: var(--hq-fs-micro);
}
.hqpu-link--icon {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.hqpu-link--icon svg {
  display: block;
}

/* ── Plugin cards ────────────────────────────────────────────────────────── */
.hqpu-cards {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.hqpu-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 0.5px solid var(--hq-border);
  border-radius: 8px;
  background: var(--hq-card);
  transition: border-color 0.15s ease, background 0.15s ease;
}
.hqpu-card:hover {
  border-color: var(--hq-border-strong);
}
.hqpu-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.hqpu-card-id {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.hqpu-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 7px;
  background: var(--hq-card-soft);
  color: var(--hq-muted);
  font-size: var(--hq-fs-micro);
  font-weight: 700;
}
.hqpu-card-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 1px;
}
.hqpu-card-title {
  font-size: var(--hq-fs-body);
  font-weight: 600;
  line-height: 15px;
  color: var(--hq-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hqpu-card-sub {
  font-family: var(--hq-mono);
  font-size: var(--hq-fs-micro);
  line-height: 12px;
  color: var(--hq-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hqpu-card-end {
  display: flex;
  align-items: center;
  flex: none;
  gap: 2px;
}
/* The card's own action: tinted, not filled — the filled brand fill belongs to
 * the one set-level CTA in the footer. */
.hqpu-card-action {
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: color-mix(in srgb, var(--hq-brand) 12%, transparent);
  color: var(--hq-brand-soft);
  font: inherit;
  font-size: var(--hq-fs-meta);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.hqpu-card-action:hover:not(:disabled) {
  background: var(--hq-brand);
  color: var(--hq-on-accent);
}
.hqpu-card-action:disabled {
  opacity: 0.5;
  cursor: default;
}
.hqpu-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.hqpu-version-row {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  font-family: var(--hq-mono);
  font-size: var(--hq-fs-meta);
  color: var(--hq-muted);
}
.hqpu-ver-old {
  color: var(--hq-muted);
}
.hqpu-ver-arrow {
  color: var(--hq-border-strong);
}
.hqpu-ver-new {
  color: var(--hq-emerald);
  font-weight: 600;
}
.hqpu-ver-new--lg {
  font-size: var(--hq-fs-body);
}
.hqpu-ver-size {
  font-size: var(--hq-fs-micro);
  color: var(--hq-faint);
}
.hqpu-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--hq-faint);
  font: inherit;
  font-size: var(--hq-fs-micro);
  white-space: nowrap;
  cursor: pointer;
}
.hqpu-toggle:hover {
  color: var(--hq-text);
}
.hqpu-toggle-chevron {
  display: inline-flex;
  transition: transform 0.15s ease;
}
.hqpu-toggle[data-open='true'] .hqpu-toggle-chevron {
  transform: rotate(90deg);
}
.hqpu-changes {
  padding-top: 8px;
  border-top: 0.5px solid var(--hq-border);
  font-size: var(--hq-fs-meta);
  color: var(--hq-muted);
}
.hqpu-changes-title {
  margin: 0 0 4px;
  font-size: var(--hq-fs-micro);
  font-weight: 600;
  color: var(--hq-muted);
}
.hqpu-changes ul {
  margin: 0;
  padding-left: 16px;
  font-size: var(--hq-fs-micro);
  line-height: 16px;
}

/* ── Collapsed groups (已忽略 / 已是最新 / 版本说明) ─────────────────────── */
.hqpu-disc {
  padding-top: 6px;
  border-top: 0.5px solid var(--hq-border);
}
.hqpu-disc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 2px 0;
  border: 0;
  background: none;
  color: var(--hq-muted);
  font: inherit;
  cursor: pointer;
}
.hqpu-disc-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.hqpu-disc-chevron {
  display: inline-flex;
  flex: none;
  color: var(--hq-faint);
  transition: transform 0.15s ease;
}
.hqpu-disc-head[aria-expanded='true'] .hqpu-disc-chevron {
  transform: rotate(90deg);
}
.hqpu-disc-title {
  font-size: var(--hq-fs-body);
  font-weight: 600;
  color: var(--hq-text);
}
.hqpu-disc-count {
  font-family: var(--hq-mono);
  font-size: var(--hq-fs-meta);
  color: var(--hq-faint);
}
.hqpu-disc-note {
  font-size: var(--hq-fs-micro);
  color: var(--hq-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hqpu-disc-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
}
.hqpu-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.hqpu-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--hq-card-soft);
  font-size: var(--hq-fs-meta);
}
.hqpu-row-name {
  font-weight: 500;
  color: var(--hq-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hqpu-row-end {
  display: flex;
  align-items: center;
  flex: none;
  gap: 8px;
}
.hqpu-row-meta {
  font-family: var(--hq-mono);
  font-size: var(--hq-fs-micro);
  color: var(--hq-faint);
}

/* ── Runtime card (amber: a swap is not a plugin install) ───────────────── */
.hqpu-engine {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  border: 0.5px solid color-mix(in srgb, var(--hq-amber) 32%, transparent);
  border-radius: 10px;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--hq-amber) 10%, var(--hq-card)) 0%,
    var(--hq-card) 60%,
    var(--hq-card-soft) 100%
  );
}
.hqpu-engine-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.hqpu-engine-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--hq-fs-body);
  font-weight: 600;
  color: var(--hq-text);
}
.hqpu-engine-bolt {
  display: inline-flex;
  color: var(--hq-amber);
}
.hqpu-chip {
  flex: none;
  padding: 1px 6px;
  border: 0.5px solid var(--hq-border-strong);
  border-radius: 4px;
  background: var(--hq-card);
  color: var(--hq-muted);
  font-family: var(--hq-mono);
  font-size: var(--hq-fs-micro);
}
.hqpu-engine-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.hqpu-engine-info {
  min-width: 0;
}
.hqpu-engine-new {
  display: flex;
  align-items: center;
  gap: 6px;
}
.hqpu-engine-size {
  margin: 2px 0 0;
  font-size: var(--hq-fs-micro);
  line-height: 14px;
  color: var(--hq-muted);
}
.hqpu-engine-state {
  flex: none;
  max-width: 45%;
  font-size: var(--hq-fs-micro);
  line-height: 14px;
  color: var(--hq-muted);
  text-align: right;
}
.hqpu-engine-error {
  margin: 0;
  font-size: var(--hq-fs-micro);
  color: var(--hq-rose);
}
.hqpu-tag--brand {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--hq-amber) 14%, transparent);
  color: var(--hq-amber-ink);
  font-size: var(--hq-fs-micro);
  font-weight: 500;
}
.hqpu-btn--engine {
  flex: none;
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: var(--hq-amber);
  color: var(--hq-on-amber);
  font: inherit;
  font-size: var(--hq-fs-meta);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s ease;
}
.hqpu-btn--engine:hover:not(:disabled) {
  background: color-mix(in srgb, var(--hq-amber) 85%, #000);
}
.hqpu-btn--engine:disabled {
  opacity: 0.5;
  cursor: default;
}
.hqpu-engine-confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 0.5px solid color-mix(in srgb, var(--hq-amber) 24%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--hq-amber) 10%, transparent);
}
.hqpu-engine-confirm-text {
  margin: 0;
  font-size: var(--hq-fs-meta);
  line-height: 16px;
  color: var(--hq-amber-ink);
}
.hqpu-engine-confirm-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
.hqpu-engine-note {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  font-size: var(--hq-fs-micro);
  color: var(--hq-faint);
}
.hqpu-engine-note svg {
  flex: none;
  color: var(--hq-amber);
}

/* ── Error / result banners ──────────────────────────────────────────────── */
.hqpu-error {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 0.5px solid;
  border-radius: 8px;
}
.hqpu-error[data-tone='danger'] {
  border-color: color-mix(in srgb, var(--hq-rose) 35%, transparent);
  background: color-mix(in srgb, var(--hq-rose) 8%, transparent);
}
.hqpu-error[data-tone='warning'] {
  border-color: color-mix(in srgb, var(--hq-amber) 35%, transparent);
  background: color-mix(in srgb, var(--hq-amber) 8%, transparent);
}
.hqpu-error-head {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.hqpu-error-icon {
  display: inline-flex;
  flex: none;
  margin-top: 1px;
  color: var(--hq-rose);
}
.hqpu-error[data-tone='warning'] .hqpu-error-icon {
  color: var(--hq-amber);
}
.hqpu-error-text {
  min-width: 0;
}
.hqpu-error-title {
  margin: 0;
  font-size: var(--hq-fs-body);
  font-weight: 600;
  line-height: 15px;
  color: var(--hq-rose);
}
.hqpu-error[data-tone='warning'] .hqpu-error-title {
  color: var(--hq-amber-ink);
}
.hqpu-error-body {
  margin: 2px 0 0;
  font-size: var(--hq-fs-micro);
  line-height: 14px;
  color: var(--hq-muted);
  overflow-wrap: anywhere;
}
.hqpu-error-code {
  display: inline-block;
  margin-top: 3px;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--hq-rose) 12%, transparent);
  color: var(--hq-rose);
  font-family: var(--hq-mono);
  font-size: var(--hq-fs-micro);
}
.hqpu-error[data-tone='warning'] .hqpu-error-code {
  background: color-mix(in srgb, var(--hq-amber) 14%, transparent);
  color: var(--hq-amber-ink);
}
.hqpu-error-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 6px;
  border-top: 0.5px solid color-mix(in srgb, currentColor 12%, transparent);
  font-size: var(--hq-fs-micro);
  color: var(--hq-muted);
}
.hqpu-error-actions {
  display: flex;
  flex: none;
  gap: 10px;
}

.hqpu-alert {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px;
  border-radius: 8px;
}
.hqpu-alert--amber {
  border: 0.5px solid color-mix(in srgb, var(--hq-amber) 32%, transparent);
  background: color-mix(in srgb, var(--hq-amber) 10%, transparent);
}
.hqpu-alert-icon {
  display: inline-flex;
  flex: none;
  color: var(--hq-amber);
}
.hqpu-alert-main {
  min-width: 0;
}
.hqpu-alert-title {
  font-size: var(--hq-fs-meta);
  font-weight: 600;
  color: var(--hq-amber-ink);
}
.hqpu-alert-body {
  margin: 2px 0 0;
  font-size: var(--hq-fs-micro);
  line-height: 14px;
  color: var(--hq-muted);
}
.hqpu-alert-body code {
  padding: 0 3px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--hq-amber) 16%, transparent);
  font-family: var(--hq-mono);
}
.hqpu-alert-actions {
  margin-top: 4px;
}
.hqpu-alert-dismiss {
  padding: 0;
  border: 0;
  background: none;
  color: var(--hq-amber-ink);
  font: inherit;
  font-size: var(--hq-fs-micro);
  text-decoration: underline;
  cursor: pointer;
}
.hqpu-alert-green {
  margin: 0;
  padding: 6px 10px;
  border: 0.5px solid color-mix(in srgb, var(--hq-emerald) 30%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--hq-emerald) 8%, transparent);
  color: var(--hq-emerald);
  font-size: var(--hq-fs-micro);
}

/* ── Active job ──────────────────────────────────────────────────────────── */
.hqpu-active {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 0.5px solid color-mix(in srgb, var(--hq-brand) 40%, transparent);
  border-radius: 8px;
  background: var(--hq-card);
}
.hqpu-active-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.hqpu-active-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--hq-fs-body);
  font-weight: 600;
  color: var(--hq-text);
}
.hqpu-active-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hqpu-pulse-dot {
  position: relative;
  flex: none;
  width: 8px;
  height: 8px;
}
.hqpu-pulse-dot::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--hq-brand);
}
.hqpu-pulse-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--hq-brand);
  opacity: 0.6;
  animation: hqpu-ping 1.4s cubic-bezier(0, 0, 0.2, 1) infinite;
}
@keyframes hqpu-ping {
  75%, 100% { transform: scale(2.4); opacity: 0; }
}
.hqpu-active-percent {
  flex: none;
  font-family: var(--hq-mono);
  font-size: var(--hq-fs-body);
  font-weight: 700;
  color: var(--hq-brand-soft);
}
.hqpu-progress {
  height: 6px;
  border-radius: 999px;
  background: var(--hq-border);
  overflow: hidden;
}
.hqpu-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--hq-brand), var(--hq-brand-soft));
  transition: width 0.3s ease;
}
.hqpu-active-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--hq-fs-micro);
  line-height: 14px;
  color: var(--hq-muted);
}
.hqpu-num {
  font-family: var(--hq-mono);
  font-size: var(--hq-fs-micro);
}
.hqpu-active-versions {
  font-family: var(--hq-mono);
  font-size: var(--hq-fs-micro);
  color: var(--hq-muted);
}
.hqpu-active-note {
  margin: 0;
  font-size: var(--hq-fs-micro);
  line-height: 14px;
  color: var(--hq-faint);
}
/* A stalled job: the card keeps its shape but stops claiming progress. The
 * pulse stops, the bar dims, and the note line carries the retry. */
.hqpu-active[data-stalled='1'] .hqpu-pulse-ring {
  animation: none;
  opacity: 0;
}
.hqpu-active[data-stalled='1'] .hqpu-pulse-dot::before {
  background: var(--hq-amber);
}
.hqpu-active[data-stalled='1'] .hqpu-active-percent {
  color: var(--hq-amber-ink);
}
.hqpu-active[data-stalled='1'] .hqpu-progress-fill {
  background: color-mix(in srgb, var(--hq-amber) 55%, var(--hq-border));
  transition: none;
}
/* The active step stops blinking too: nothing is advancing. */
.hqpu-active[data-stalled='1'] .hqpu-job-step--active {
  color: var(--hq-amber-ink);
  animation: none;
}
.hqpu-active-stalled {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--hq-amber) 10%, transparent);
  font-size: var(--hq-fs-micro);
  line-height: 14px;
  color: var(--hq-amber-ink);
}
.hqpu-active-stalled .hqpu-link {
  flex: none;
  font-size: var(--hq-fs-micro);
  color: var(--hq-amber-ink);
  text-decoration: underline;
}
.hqpu-job-steps4 {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 2px;
  padding-top: 8px;
  border-top: 0.5px solid var(--hq-border);
  text-align: center;
  font-size: var(--hq-fs-micro);
  font-weight: 500;
}
.hqpu-job-step--done {
  color: var(--hq-emerald);
}
.hqpu-job-step--active {
  color: var(--hq-brand-soft);
  animation: hqpu-step-pulse 1.2s ease-in-out infinite;
}
.hqpu-job-step--todo {
  color: var(--hq-faint);
}
@keyframes hqpu-step-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

/* ── Footer ──────────────────────────────────────────────────────────────── */
.hqpu-footer {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px 12px;
  border-top: 0.5px solid var(--hq-border);
  background: var(--hq-bg);
}
.hqpu-btn--block {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 0 12px;
  border: 0;
  border-radius: 10px;
  background: var(--hq-brand);
  color: var(--hq-on-accent);
  font: inherit;
  font-size: var(--hq-fs-body);
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--hq-brand) 35%, transparent);
  transition: background 0.15s ease, box-shadow 0.15s ease;
}
.hqpu-btn--block:hover:not(:disabled) {
  background: var(--hq-brand-soft);
}
/* The disabled CTA states the reason in its own label, so it must stay legible
 * (a 40 %-opacity red button reads as "broken", not as "nothing to do"). */
.hqpu-btn--block:disabled {
  background: var(--hq-card-soft);
  color: var(--hq-faint);
  box-shadow: none;
  cursor: not-allowed;
}
.hqpu-cta-spinner {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, currentColor 30%, transparent);
  border-top-color: currentColor;
  animation: hqpu-spin 0.9s linear infinite;
}
@keyframes hqpu-spin {
  to { transform: rotate(360deg); }
}
.hqpu-foot-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 14px;
  font-size: var(--hq-fs-micro);
  color: var(--hq-faint);
}
.hqpu-footnote {
  margin: 0;
  font-size: var(--hq-fs-micro);
  line-height: 13px;
  text-align: center;
  color: var(--hq-faint);
}

/* ── Job log drawer ──────────────────────────────────────────────────────
 * Covers the body and the footer, never the header: the log button and the
 * close button stay in place while it is open. */
.hqpu-log {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--hq-bg);
}
.hqpu-log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 0.5px solid var(--hq-border);
}
.hqpu-log-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.hqpu-log-name {
  font-size: var(--hq-fs-body);
  font-weight: 600;
  color: var(--hq-text);
  white-space: nowrap;
}
.hqpu-log-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
}
.hqpu-log-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: 8px;
  background: var(--hq-card-soft);
  font-family: var(--hq-mono);
  font-size: var(--hq-fs-micro);
}
.hqpu-log-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 4px;
  border-bottom: 0.5px solid var(--hq-border);
  color: var(--hq-faint);
  overflow-wrap: anywhere;
}
.hqpu-log-line {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--hq-muted);
  line-height: 15px;
}
.hqpu-log-line--empty {
  color: var(--hq-faint);
}
.hqpu-log-line-text {
  min-width: 0;
  overflow-wrap: anywhere;
}
.hqpu-log-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--hq-border-strong);
}
.hqpu-log-dot[data-state='done'] { background: var(--hq-emerald); }
.hqpu-log-dot[data-state='error'] { background: var(--hq-rose); }
.hqpu-log-dot[data-state='warning'] { background: var(--hq-amber); }
.hqpu-log-dot[data-state='idle'] { background: var(--hq-border-strong); }
.hqpu-log-detail {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px;
  border: 0.5px solid var(--hq-border);
  border-radius: 8px;
  font-size: var(--hq-fs-micro);
  color: var(--hq-muted);
}
.hqpu-log-detail p {
  margin: 0;
  overflow-wrap: anywhere;
}
.hqpu-log-recent {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.hqpu-log-recent-title {
  margin: 0 0 2px;
  font-size: var(--hq-fs-micro);
  font-weight: 600;
  color: var(--hq-muted);
}
.hqpu-log-recent-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 5px;
  background: var(--hq-card-soft);
  font-size: var(--hq-fs-micro);
  color: var(--hq-muted);
}
.hqpu-log-recent-meta {
  flex: none;
  font-family: var(--hq-mono);
  color: var(--hq-faint);
}
.hqpu-log-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 8px;
  border-top: 0.5px solid var(--hq-border);
}

/* ── Toast ──────────────────────────────────────────────────────────────── */
.hqpu-toast-host {
  position: absolute;
  top: 8px;
  left: 12px;
  right: 12px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
}
.hqpu-toast-host:empty {
  display: none;
}
.hqpu-toast {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-toast-bg, var(--hq-card));
  color: var(--dsw-alias-toast-label, var(--hq-text));
  font-size: var(--hq-fs-meta);
  box-shadow: var(--dsw-shadow-lv3, 0 8px 24px rgba(0, 0, 0, 0.2));
  pointer-events: auto;
  animation: hqpu-toast-in 160ms ease-out;
}
.hqpu-toast-icon {
  display: inline-flex;
  flex: none;
  color: var(--hq-amber);
}
.hqpu-toast-icon[data-tone='success'] {
  color: var(--hq-emerald);
}
.hqpu-toast-icon[data-tone='error'] {
  color: var(--hq-rose);
}
.hqpu-toast-text {
  min-width: 0;
  flex: 1;
  overflow-wrap: anywhere;
}
.hqpu-toast-close {
  display: inline-flex;
  flex: none;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  opacity: 0.55;
  cursor: pointer;
}
.hqpu-toast-close:hover {
  opacity: 1;
}
@keyframes hqpu-toast-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}

/* ── Badges, banners, misc shared bits ──────────────────────────────────── */
.hqpu-tag {
  display: inline-flex;
  align-items: center;
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  font-size: var(--hq-fs-micro);
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
}
.hqpu-tag[data-tone='success'] {
  background: color-mix(in srgb, var(--hq-emerald) 12%, transparent);
  color: var(--hq-emerald);
}
.hqpu-tag[data-tone='warning'] {
  background: color-mix(in srgb, var(--hq-amber) 14%, transparent);
  color: var(--hq-amber-ink);
}
.hqpu-tag[data-tone='danger'] {
  background: color-mix(in srgb, var(--hq-rose) 12%, transparent);
  color: var(--hq-rose);
}
.hqpu-tag[data-tone='info'] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--hq-brand)) 12%, transparent);
  color: var(--dsw-alias-state-business-primary, var(--hq-brand));
}
.hqpu-tag[data-tone='neutral'] {
  background: var(--hq-card-soft);
  color: var(--hq-muted);
}
.hqpu-banner {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: var(--hq-fs-micro);
  line-height: 15px;
  color: var(--hq-muted);
}
.hqpu-banner[data-tone='danger'] {
  background: color-mix(in srgb, var(--hq-rose) 8%, transparent);
}
.hqpu-banner[data-tone='danger'] span {
  color: var(--hq-rose);
}
.hqpu-release-summary {
  margin: 0;
  font-size: var(--hq-fs-meta);
  line-height: 16px;
  color: var(--hq-muted);
}
.hqpu-release-notes {
  margin: 0;
  padding-left: 16px;
  font-size: var(--hq-fs-micro);
  line-height: 16px;
  color: var(--hq-muted);
}
.hqpu-release-meta {
  margin: 0;
  font-size: var(--hq-fs-micro);
  color: var(--hq-faint);
}
.hqpu-release-link {
  font-size: var(--hq-fs-micro);
  color: var(--hq-brand-soft);
  text-decoration: none;
}
.hqpu-release-link:hover {
  text-decoration: underline;
}
.hqpu-status {
  margin: 0;
  font-size: var(--hq-fs-meta);
  line-height: 15px;
  color: var(--hq-muted);
}
.hqpu-empty {
  padding: 24px 0;
  text-align: center;
  font-size: var(--hq-fs-meta);
  color: var(--hq-faint);
}

/* ── Buttons (settings / log drawer) ─────────────────────────────────────── */
.hqpu-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  background: var(--hq-card-soft);
  color: var(--hq-text);
  font: inherit;
  font-size: var(--hq-fs-meta);
  cursor: pointer;
}
.hqpu-btn svg {
  display: block;
}
.hqpu-btn:hover:not(:disabled) {
  background: var(--hq-hover);
}
.hqpu-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.hqpu-btn--sm {
  height: 26px;
  padding: 0 8px;
  font-size: var(--hq-fs-micro);
}
.hqpu-btn--ghost {
  background: transparent;
  color: var(--hq-muted);
}
.hqpu-btn--brand {
  background: var(--hq-brand);
  color: var(--hq-on-accent);
}
.hqpu-btn--brand:hover:not(:disabled) {
  background: var(--hq-brand-soft);
}
/* The runtime confirm is the same amber as the card it lives in (the
 * prototype's treatment): red is the plugin-set path, amber the runtime path.
 * Ink is a warm near-black because amber stays bright in both themes — white
 * on amber-500 sits near 2:1 and reads as a disabled button. */
.hqpu-btn--engine-solid {
  height: 28px;
  padding: 0 12px;
  background: var(--hq-amber);
  color: var(--hq-on-amber);
  font-size: var(--hq-fs-meta);
  font-weight: 600;
}
.hqpu-btn--engine-solid:hover:not(:disabled) {
  background: color-mix(in srgb, var(--hq-amber) 85%, #000);
}

/* ── Skeleton ────────────────────────────────────────────────────────────── */
.hqpu-skeleton-fill {
  background: var(--hq-border);
  animation: hqpu-skeleton 2s cubic-bezier(0.36, 0, 0.64, 1) infinite;
}
.hqpu-skeleton-title {
  width: 60%;
  height: 10px;
  border-radius: 3px;
}
.hqpu-skeleton-sub {
  width: 40%;
  height: 8px;
  border-radius: 3px;
}
.hqpu-card .hqpu-avatar.hqpu-skeleton-fill {
  background: var(--hq-border);
}
@keyframes hqpu-skeleton {
  0% { opacity: 1; }
  40% { opacity: 0.55; }
  80%, 100% { opacity: 1; }
}

/* ── Focus + reduced motion ──────────────────────────────────────────────── */
.hqpu-panel button:focus-visible,
.hqpu-panel a:focus-visible,
.hqpu-panel input:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.hqpu-panel input:focus-visible {
  outline: none;
  border-color: var(--hq-brand-soft);
}

@media (prefers-reduced-motion: reduce) {
  .hqpu-scrim,
  .hqpu-panel,
  .hqpu-skeleton-fill,
  .hqpu-cta-spinner,
  .hqpu-toast,
  .hqpu-pulse-ring,
  .hqpu-job-step--active {
    animation: none;
  }
}

`

const STYLE_TAG_ID = 'data-plugin-css="huaqiu-plugin-update"'

/**
 * Design tokens the bundled DSH shell may not publish.
 *
 * hq-edge ships an older `ui-theme` build. A live probe of the running shell
 * (both themes) shows 13 of the tokens this stylesheet reads are absent:
 * `--dsw-radius-{xs,sm,md,lg,xl,panel}`, `--dsw-focus-ring-width`,
 * `--dsw-focus-ring-color`, `--dsw-alias-toast-label`,
 * `--dsw-alias-state-idle-primary`, `--dsw-font-mono`,
 * `--dsh-frame-overlay-top` and `--dsh-frame-chrome-top`.
 *
 * An unresolved `var()` is not an error — it silently degrades the property to
 * its initial value. That is how this panel once rendered with
 * `border-radius: 0px` and a 3px `auto` focus ring while every colour was
 * already correct.
 *
 * The last three (`--dsw-font-mono`, `--dsh-frame-*`) are deliberately NOT
 * backfilled: the shell's own primitives rely on the inline `var(…, fallback)`
 * form for those (`Modal.module.css`, `PluginManagerPage.module.css`), so this
 * sheet does too. Everything else is backfilled below with the canonical value
 * from `ui-theme/src/styles/{base,focus,design-platform}.css`.
 *
 * Values are feature-detected at runtime and scoped to this plugin's own roots
 * rather than `:root`, so a newer shell always wins and filling a gap can never
 * restyle the host.
 */

/** The two roots this plugin styles: the view overlay (built in
 *  update-view.ts) and the sidebar row ({@link ENTRY_CSS}.entry). */
const STYLE_ROOTS = '.hqpu-overlay, .hqpu-sidebar-entry'

/** The shell's dark-theme carrier — audited live as `body[data-ds-dark-theme]`. */
const DARK_THEME_SELECTOR = 'body[data-ds-dark-theme]'

/** Same roots, one rule per theme, for tokens whose official value flips. */
const DARK_STYLE_ROOTS = STYLE_ROOTS.split(',')
  .map((root) => `${DARK_THEME_SELECTOR} ${root.trim()}`)
  .join(',')

type DesignTokenFallback =
  | { token: string; value: string }
  | { token: string; value: { light: string; dark: string } }

const DESIGN_TOKEN_FALLBACKS: DesignTokenFallback[] = [
  // base.css — geometry; theme-invariant.
  { token: '--dsw-radius-xs', value: '4px' },
  { token: '--dsw-radius-sm', value: '8px' },
  { token: '--dsw-radius-md', value: '12px' },
  { token: '--dsw-radius-lg', value: '16px' },
  { token: '--dsw-radius-xl', value: '20px' },
  { token: '--dsw-radius-panel', value: '28px' },
  // focus.css — the standard ring geometry. The colour already falls back
  // inline in the sheet; publishing it too keeps the ring intact if that
  // fallback is ever edited away.
  { token: '--dsw-focus-ring-width', value: '2px' },
  { token: '--dsw-focus-ring-color', value: 'var(--dsw-alias-state-business-primary, #C7000B)' },
  // design-platform.css — `--dsw-static-neutral-bluish-00` is white in both
  // themes, which is exactly what the official alias resolves to.
  { token: '--dsw-alias-toast-label', value: 'var(--dsw-static-neutral-bluish-00, #fff)' },
  // The one token whose official value flips with the theme. `--dsw-static-*`
  // are theme-invariant, so one rule per carrier reproduces neutral-300
  // (light) / neutral-600 (dark) without knowing the current theme.
  {
    token: '--dsw-alias-state-idle-primary',
    value: {
      light: 'var(--dsw-static-neutral-300, #d4d4d4)',
      dark: 'var(--dsw-static-neutral-600, #545557)',
    },
  },
]

const TOKEN_STYLE_TAG_ID = 'data-plugin-css="huaqiu-plugin-update-tokens"'

/**
 * Publish canonical values for the design tokens the shell is missing.
 *
 * Idempotent and cheap: safe to call on every open, so a shell that publishes
 * its tokens late still wins (the stale fallbacks are removed in that case).
 */
export function ensureDesignTokens(): void {
  if (typeof document === 'undefined' || document.body === null) return
  const probe = getComputedStyle(document.body)
  const missing = DESIGN_TOKEN_FALLBACKS.filter(
    (entry) => probe.getPropertyValue(entry.token).trim() === '',
  )

  const existing = document.querySelector<HTMLStyleElement>(`style[${TOKEN_STYLE_TAG_ID}]`)
  if (missing.length === 0) {
    existing?.remove()
    return
  }

  const flat = missing.filter(
    (entry): entry is { token: string; value: string } => typeof entry.value === 'string',
  )
  const themed = missing.filter(
    (entry): entry is { token: string; value: { light: string; dark: string } } =>
      typeof entry.value !== 'string',
  )

  const rules: string[] = []
  const lightDecls = [
    ...flat.map((entry) => `  ${entry.token}: ${entry.value};`),
    ...themed.map((entry) => `  ${entry.token}: ${entry.value.light};`),
  ]
  rules.push(`${STYLE_ROOTS} {\n${lightDecls.join('\n')}\n}`)
  if (themed.length > 0) {
    const darkDecls = themed.map((entry) => `  ${entry.token}: ${entry.value.dark};`)
    rules.push(`${DARK_STYLE_ROOTS} {\n${darkDecls.join('\n')}\n}`)
  }

  const tag = existing ?? document.createElement('style')
  tag.dataset.pluginCss = 'huaqiu-plugin-update-tokens'
  tag.textContent = rules.join('\n')
  if (tag.parentNode === null) document.head.appendChild(tag)
}

/** Inject styles once (idempotent). */
export function injectUpdateStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[${STYLE_TAG_ID}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = 'huaqiu-plugin-update'
  tag.textContent = `${ENTRY_CSS_TEXT}\n${VIEW_CSS_TEXT}`
  document.head.appendChild(tag)
}

/** Minimal structural client context (dsh-client-runtime provides these). */
export interface ClientContext {
  get<T = unknown>(name: string): T | undefined
  effect?(fn: () => (() => void) | void, label?: string): void
}

/**
 * In-memory update-report store shared by the badge and the modal.
 *
 * Exported for tests: the re-attach logic (watch a job by id, notice that the
 * server was replaced, stop claiming progress) is the part that cannot be
 * exercised through the view alone.
 */
export class UpdateStore implements UpdateStoreLike {
  private current: PluginUpdateReport | null = null
  private installingFlag = false
  /** The durable job the server currently reports as active (resumed across
   *  panel close and DSH restart); null when idle. */
  private active: UpdateJob | null = null
  private recent: UpdateJob[] = []
  private readonly listeners = new Set<() => void>()
  private refreshTimer: number | null = null
  private pollTimer: number | null = null
  private pollBackoffMs = 1_000
  private pollInFlight = false
  /** The job this panel started (or adopted) and is following by id. */
  private watchedJobId: string | null = null
  /** hq-edge process identity from the last `/activity` read. */
  private activityBootId: string | null = null
  private stalledFlag = false
  private phaseAgeMsValue = 0

  report(): PluginUpdateReport | null {
    return this.current
  }

  installing(): boolean {
    return this.installingFlag
  }

  activeJob(): UpdateJob | null {
    return this.active
  }

  recentJobs(): UpdateJob[] {
    return [...this.recent]
  }

  /** True when the server says the active job stopped advancing. */
  stalled(): boolean {
    return this.stalledFlag
  }

  /** Milliseconds since the active job last advanced (server clock). */
  phaseAgeMs(): number {
    return this.phaseAgeMsValue
  }

  /**
   * Follow a job by id. The panel calls this with the `jobId` an accept
   * response handed back, so every later read asks about THAT job — the only
   * way to learn its outcome when the install replaced this very plugin (the
   * page comes back to a server that has no "active job" left to report).
   */
  watchJob(id: string | null): void {
    this.watchedJobId = id
    if (id !== null) this.schedulePoll()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Sidebar badge: how many updates are still on offer — actionable plugin
   * items plus (once) the HQ Edge runtime update.
   *
   * The whole rule lives in {@link badgeCountFor}; in particular the job
   * history never contributes, which is what used to pin this at 1 forever.
   */
  badgeCount(): number {
    return badgeCountFor(this.current, this.active)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        /* one bad listener must not strand the rest */
      }
    }
  }

  /** Adopt a fresh `/status` snapshot and (re)arm the poll loop. */
  private applyStatus(status: UpdateJobStatus): void {
    const wasActive = this.active !== null
    this.active = status.activeJob
    this.recent = status.recentJobs
    if (this.active !== null) this.watchedJobId = this.active.id
    if (wasActive && this.active === null) this.observeSettled()
    this.emit()
    this.schedulePoll()
  }

  /**
   * Adopt a `/activity` snapshot.
   *
   * Two things only this read can tell us:
   *
   *   - `bootId` changed → hq-edge was recreated underneath the page. That is
   *     what an install of this plugin's own package looks like from here: the
   *     DSH process serving this route was replaced. Nothing in memory can be
   *     trusted, so the installing flag is cleared and the report re-read.
   *   - `stalled` → the active job has stopped advancing. The progress bar must
   *     stop pretending; the panel shows a "confirming" note with a retry.
   */
  private applyActivity(activity: UpdateActivity): void {
    const rebooted = this.activityBootId !== null && this.activityBootId !== activity.bootId
    this.activityBootId = activity.bootId
    this.stalledFlag = activity.stalled
    this.phaseAgeMsValue = activity.phaseAgeMs

    const wasActive = this.active !== null
    this.active = activity.activeJob
    if (activity.job !== null) this.upsertRecent(activity.job)

    if (rebooted) {
      this.installingFlag = false
      this.stalledFlag = false
      this.phaseAgeMsValue = 0
      void this.refresh()
    }
    if (wasActive && this.active === null) this.observeSettled()
    this.emit()
    this.schedulePoll()
  }

  /**
   * The job we were following reached a terminal phase (or vanished from the
   * active slot). Clear the transient flags and re-read the report — it still
   * names the versions that job installed.
   */
  private observeSettled(): void {
    this.installingFlag = false
    this.stalledFlag = false
    this.phaseAgeMsValue = 0
    this.watchedJobId = null
    void this.refresh()
  }

  /** Keep one job fresh in the local history without duplicating it. */
  private upsertRecent(job: UpdateJob): void {
    const rest = this.recent.filter((entry) => entry.id !== job.id)
    this.recent = [job, ...rest].slice(0, 20)
  }

  /**
   * Fetch the durable job state. Called on mount, on panel open (BEFORE
   * discovery) and by the poll loop. A failure (older hq-edge with no
   * `/status`, or a transient HTTP error) is swallowed: the last known job is
   * kept and the poller backs off and retries.
   */
  async fetchStatus(): Promise<void> {
    try {
      await this.pollOnce()
      this.pollBackoffMs = 1_000
    } catch {
      this.schedulePoll()
    }
  }

  /**
   * One read. While a job is being followed, ask `/activity` about THAT job
   * (survives the restart an update of this plugin causes); otherwise fall back
   * to the plain `/status` list. An older hq-edge without `/activity` 404s and
   * the status read still answers.
   */
  private async pollOnce(): Promise<void> {
    const watched = this.watchedJobId ?? this.active?.id ?? null
    if (watched !== null) {
      try {
        this.applyActivity(await fetchActivity(watched))
        return
      } catch {
        /* fall through to /status: an older hq-edge has no /activity */
      }
    }
    this.applyStatus(await fetchJobStatus())
  }

  /** ~1 s poll while a job is active; stop on terminal; back off on error
   *  without discarding the last known job; never overlap requests. */
  private schedulePoll(): void {
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    const job = this.active
    if (job === null || TERMINAL_PHASES.has(job.phase)) {
      this.pollBackoffMs = 1_000
      return
    }
    this.pollTimer = window.setTimeout(() => {
      void this.pollTick()
    }, this.pollBackoffMs)
  }

  private async pollTick(): Promise<void> {
    if (this.pollInFlight) {
      this.schedulePoll()
      return
    }
    this.pollInFlight = true
    try {
      await this.pollOnce()
      this.pollBackoffMs = 1_000
    } catch {
      this.pollBackoffMs = Math.min(5_000, Math.max(1_000, this.pollBackoffMs * 2))
      this.schedulePoll()
    } finally {
      this.pollInFlight = false
    }
  }

  async refresh(): Promise<PluginUpdateReport | null> {
    try {
      const report = await fetchReport()
      this.current = report
      this.emit()
      return report
    } catch {
      return this.current
    }
  }

  async check(): Promise<PluginUpdateReport | null> {
    try {
      const report = await checkUpdates()
      this.current = report
      this.emit()
      return report
    } catch {
      return this.current
    }
  }

  /** Mark the set as installing (set by the modal before the restart). */
  setInstalling(flag: boolean): void {
    this.installingFlag = flag
    this.emit()
  }

  /** Idle refresh while mounted (60 s) — no overlapping poll loop. */
  startIdleRefresh(): void {
    if (this.refreshTimer !== null) return
    this.refreshTimer = window.setInterval(() => {
      void this.refresh()
    }, 60_000) as unknown as number
  }

  stop(): void {
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    this.listeners.clear()
  }
}

/**
 * Client cordis inject: no service dependencies — the plugin reads the
 * hq-edge report purely through same-origin fetch (forwarded by its own node
 * half). `inject` stays empty so the loader never waits on another service.
 */
export const inject: string[] = []

/**
 * Client plugin body — mount the sidebar toolbutton + review modal.
 * @param ctx - real cordis client context.
 * @returns disposer removing the row and all subscriptions.
 */
export function apply(ctx: ClientContext): () => void {
  if (typeof document === 'undefined') return () => {}
  injectUpdateStyles()
  ensureDesignTokens()

  const store = new UpdateStore()
  const copy = { zh: COPY.zh, en: COPY.en }
  const copyFor = (): typeof COPY.zh => (locale === 'en' ? copy.en : copy.zh)

  // Locale: re-render the row copy when <html lang> changes. The sidebar
  // helper subscribes via `refresh.subscribe`; we fan out to its listener.
  let locale: HostLocale | undefined = detectHostLocale()
  const localeSubscribers = new Set<() => void>()
  const refreshSubscribe = (listener: () => void): (() => void) => {
    localeSubscribers.add(listener)
    return () => {
      localeSubscribers.delete(listener)
    }
  }
  const unsubscribeLocale = observeHostLocale((next) => {
    locale = next
    for (const fn of [...localeSubscribers]) {
      try {
        fn()
      } catch {
        /* one bad subscriber must not strand the rest */
      }
    }
  })

  const openView = (): void => {
    // Re-detect the shell's design tokens on every open: a shell that
    // publishes them after this plugin mounted must win, and one that never
    // does must keep the canonical fallbacks.
    ensureDesignTokens()
    // Resume-before-discovery: read the durable job status FIRST so an in-flight
    // install/runtime update is resumed (and its view rendered) even while the
    // update check round trip is still running. The panel itself opens from
    // whatever the store already holds; check() refreshes the list behind it.
    void store.fetchStatus()
    openUpdateView(store, copyFor())
    void store.check()
  }

  // While a job runs the row label shows its progress ("更新中 42%"), and the
  // tooltip names the phase. Store changes re-apply the label (the badge
  // subscription already re-renders the count pill).
  const statusLabel = (): { label: string; tooltip: string } => {
    const base = entryCopy(locale)
    const job = store.activeJob()
    if (job !== null) {
      const cc = copyFor()
      const pct = job.progress.percent
      const phase = cc.job.phase[job.phase] ?? job.phase
      return {
        label: pct !== null ? `${base.label} · ${Math.round(pct)}%` : `${base.label} · ${phase}`,
        tooltip: `${base.tooltip} · ${phase}`,
      }
    }
    return base
  }

  const disposeEntry = mountSidebarEntry({
    rowAttribute: UPDATE_ENTRY_ATTRIBUTE,
    rowSelector: UPDATE_ENTRY_SELECTOR,
    plugin: PLUGIN_ID,
    icon: UPDATE_ICON,
    css: ENTRY_CSS,
    // Read the live locale on every refresh (the locale observer fires
    // `refresh.subscribe`'s listener, which re-applies these) so the row
    // re-localizes when the host UI language changes — matching the sibling
    // family rows, which read a live `currentLang` variable the same way.
    label: () => statusLabel().label,
    tooltip: () => statusLabel().tooltip,
    refresh: { subscribe: refreshSubscribe },
    badge: {
      subscribe: (listener) => store.subscribe(listener),
      count: () => store.badgeCount(),
    },
    onToggle: openView,
    position: 'after',
    familySelectors: HUAQIU_SIDEBAR_ENTRY_FAMILY,
  })

  // Store changes (active-job percentage, result dot) also re-apply the row
  // label, not just the badge count.
  store.subscribe(() => {
    for (const fn of [...localeSubscribers]) {
      try {
        fn()
      } catch {
        /* one bad subscriber must not strand the rest */
      }
    }
  })

  store.startIdleRefresh()
  void store.refresh()
  void store.fetchStatus()

  const dispose = (): void => {
    try {
      disposeEntry()
    } catch {
      /* already disposed */
    }
    unsubscribeLocale()
    store.stop()
  }
  if (typeof ctx.effect === 'function') {
    // `ctx.effect` takes a SETUP function and calls it immediately, keeping
    // whatever it returns as the teardown. Passing `dispose` itself would run
    // the teardown synchronously — disconnecting the sidebar-entry observers
    // and stopping the store before the shell ever renders the sidebar, so the
    // row could never be placed. Hand it a factory that returns the teardown
    // instead (the same shape the sibling tool plugins use).
    ctx.effect(() => dispose, 'plugin-update')
  }
  return dispose
}

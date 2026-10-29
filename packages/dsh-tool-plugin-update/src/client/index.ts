/**
 * `@huaqiu/dsh-tool-plugin-update` — browser half.
 *
 * Mounts one sidebar toolbutton in the Huaqiu family block ("插件更新") with a
 * numeric badge equal to the actionable plugin-update count (spec §6.3/§7.1:
 * only compatible `update` + `install` items after host/HQ-Edge filtering and
 * after excluding the ignored offer; runtime updates are NOT counted). Click
 * opens the review/confirm/ignore modal.
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
  fetchJobStatus,
  fetchReport,
  TERMINAL_PHASES,
  type PluginUpdateReport,
  type UpdateJob,
  type UpdateJobStatus,
} from './api.js'
import { COPY } from './copy.js'
import { PLUGIN_ICON } from './icons.js'
import { openUpdateView, type UpdateStoreLike } from './update-view.js'

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
/* ── Overlay + panel (ui-primitives Modal.module.css) ─────────────────── */
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
  background: var(--dsw-alias-bg-mask-1);
  animation: hqpu-fade var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease);
}
.hqpu-panel {
  position: relative;
  z-index: 1;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: min(920px, 100%);
  max-height: 100%;
  overflow: hidden;
  border: 0;
  border-radius: var(--dsw-radius-panel);
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
  animation: hqpu-panel-in var(--ds-transition-duration, 0.2s) var(--ds-ease-in-out, ease);
}
.hqpu-panel:focus {
  outline: none;
}
@keyframes hqpu-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes hqpu-panel-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ── Head row (ui-primitives Modal .header) ─────────────────────────────── */
.hqpu-head {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  box-sizing: border-box;
  /* The official Title row: 22/14/12/24 — the toolbar sits 10px further right
   * than the body content on purpose, matching the shell's own close button. */
  padding: 22px 14px 12px 24px;
}
.hqpu-head-main {
  min-width: 0;
  max-width: 100%;
}
.hqpu-title {
  margin: 0;
  font-size: 20px;
  font-weight: 500;
  line-height: 28px;
  color: var(--dsw-alias-label-primary);
}
.hqpu-intro {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.hqpu-info {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-caption);
  cursor: pointer;
}
.hqpu-info:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.hqpu-info:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.hqpu-toolbar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 16px;
}

/* ── Scrolling body: the page's centred column ────────────────────────── */
.hqpu-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  box-sizing: border-box;
  /* The panel's 20px gap already separates this from the head and footer. */
  padding: 0 clamp(16px, 3vw, 32px) 4px;
  /* Anything that scrolls inside the panel draws the l2 thumb. */
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.hqpu-column {
  display: flex;
  flex-direction: column;
  gap: 24px;
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
}
/* A stack of groups (or the single toast host) inside the column. */
.hqpu-stack {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.hqpu-toast-host:empty {
  display: none;
}

/* ── Groups (PluginManagerPage .group) ────────────────────────────────── */
.hqpu-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hqpu-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hqpu-group-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.hqpu-group-count {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}

/* ── Cards (PluginManagerPage .card) ──────────────────────────────────── */
.hqpu-cards {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.hqpu-card {
  min-width: 0;
  /* The hover surface reaches 8px past the content on both sides. */
  margin: 0 -8px;
  border-radius: var(--dsw-radius-xl);
}
.hqpu-card:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.hqpu-card-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px;
}
.hqpu-card-icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg);
  color: var(--dsw-alias-label-secondary);
}
.hqpu-card-icon svg {
  display: block;
  width: 24px;
  height: 24px;
}
.hqpu-card-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hqpu-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.hqpu-card-title {
  min-width: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hqpu-card-desc {
  font-size: 13px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.hqpu-card-end {
  position: relative;
  z-index: 1;
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 8px;
}
.hqpu-card-reason {
  margin: 0;
  padding: 0 8px 8px 70px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
  overflow-wrap: anywhere;
}

/* ── Tags (ui-primitives Tag.module.css) ──────────────────────────────── */
.hqpu-tag {
  display: inline-flex;
  align-items: center;
  flex: none;
  border-radius: 999px;
  corner-shape: round;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 17px;
  white-space: nowrap;
}
.hqpu-tag[data-tone='success'] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
  color: var(--dsw-alias-state-success-primary);
}
.hqpu-tag[data-tone='info'] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
  color: var(--dsw-alias-state-business-primary);
}
.hqpu-tag[data-tone='warning'] {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  color: var(--dsw-alias-state-warn-primary);
}
.hqpu-tag[data-tone='danger'] {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
  color: var(--dsw-alias-state-error-primary);
}
.hqpu-tag[data-tone='neutral'] {
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}

/* ── Fact rows (PluginManagerPage .facts / .rows) ─────────────────────── */
.hqpu-facts {
  margin: 0;
  display: flex;
  flex-direction: column;
}
.hqpu-facts > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 44px;
  padding: 8px 2px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.hqpu-facts > div:last-child {
  border-bottom: 0;
}
.hqpu-facts dt {
  flex: none;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.hqpu-facts dd {
  min-width: 0;
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  text-align: end;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
}
.hqpu-facts code {
  padding: 2px 6px;
  border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-bg-module-platform);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
}

/* ── Banner (PluginManagerPage .installSafety) ────────────────────────── */
.hqpu-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-state-warn-tertiary);
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.hqpu-banner > svg {
  flex: none;
  margin-top: 2px;
  color: var(--dsw-alias-state-warn-primary);
}

/* ── Status, empty, failure (PluginManagerPage .status / .empty / .failure) */
.hqpu-status {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}
.hqpu-status--dot {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.hqpu-failure {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--dsw-alias-state-error-primary);
}
.hqpu-empty {
  padding: 32px 0;
  text-align: center;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}

/* ── State dot + spinner (ui-primitives StateDot.module.css) ──────────── */
.hqpu-dot {
  position: relative;
  display: inline-block;
  flex: none;
  width: 10px;
  height: 10px;
}
.hqpu-dot::after {
  content: '';
  position: absolute;
  inset: 20%;
  border-radius: 50%;
  corner-shape: round;
  background: currentColor;
}
.hqpu-dot[data-state='done'] { color: var(--dsw-alias-state-success-primary); }
.hqpu-dot[data-state='warning'] { color: var(--dsw-alias-state-warn-primary); }
.hqpu-dot[data-state='error'] { color: var(--dsw-alias-state-error-primary); }
.hqpu-dot[data-state='idle'] { color: var(--dsw-alias-state-idle-primary); }
.hqpu-spinner {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, currentColor 25%, transparent);
  border-top-color: currentColor;
  animation: hqpu-spin 1.5s linear infinite;
}
@keyframes hqpu-spin {
  to { transform: rotate(360deg); }
}

/* ── Skeleton (PluginManagerPage .skeleton*) ──────────────────────────── */
.hqpu-skeleton-fill {
  background: var(--dsw-alias-bg-skeleton);
  animation: hqpu-skeleton 2s cubic-bezier(0.36, 0, 0.64, 1) infinite;
}
.hqpu-skeleton-text {
  display: flex;
  align-items: center;
  height: 1lh;
}
.hqpu-skeleton-bar {
  width: 100%;
  height: 12px;
  border-radius: var(--dsw-radius-xs);
}
.hqpu-skeleton-heading { width: 96px; }
.hqpu-skeleton-title { width: min(144px, 60%); }
.hqpu-skeleton-desc { width: min(280px, 85%); }
.hqpu-skeleton-icon { border-color: transparent; }
@keyframes hqpu-skeleton {
  0% { opacity: 1; }
  40% { opacity: 0.6; }
  80%, 100% { opacity: 1; }
}

/* ── Toast (ui-primitives Toast.module.css, held inside the panel) ────── */
.hqpu-toast {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-toast-bg);
  color: var(--dsw-alias-toast-label);
  font-size: 14px;
  line-height: 22px;
  box-shadow: var(--dsw-shadow-lv3);
  animation: hqpu-toast-in 160ms ease-out;
}
.hqpu-toast-icon {
  display: grid;
  place-items: center;
  flex: none;
  color: var(--dsw-alias-state-warn-label);
}
.hqpu-toast-icon[data-tone='success'] { color: var(--dsw-alias-state-success-primary); }
.hqpu-toast-text { min-width: 0; }
@keyframes hqpu-toast-in {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: none; }
}

/* ── Buttons (PluginManagerPage .addButton / .iconButton) ─────────────── */
.hqpu-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-caption);
  cursor: pointer;
}
.hqpu-icon-btn svg { display: block; }
.hqpu-icon-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.hqpu-icon-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.hqpu-icon-btn:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.hqpu-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.hqpu-btn svg { display: block; }
.hqpu-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
.hqpu-btn:disabled { opacity: 0.5; cursor: default; }
.hqpu-btn:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
.hqpu-btn--primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.hqpu-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.hqpu-btn--outline {
  background: transparent;
  border: 0.5px solid var(--dsw-alias-border-l4);
  color: var(--dsw-alias-label-secondary);
}
.hqpu-btn--outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.hqpu-btn--ghost { background: transparent; color: var(--dsw-alias-label-secondary); }
.hqpu-btn--ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.hqpu-btn--danger { color: var(--dsw-alias-state-error-primary); }
.hqpu-btn--sm { height: 28px; padding: 0 10px; font-size: 12.5px; }
.hqpu-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

/* ── Runtime update action row (arm → confirm step) ───────────────────── */
.hqpu-runtime-actions {
  margin-top: 12px;
}
.hqpu-runtime-confirm {
  flex: 1 1 100%;
  margin: 0;
}

/* ── Runtime update source (fact row + editable URL field) ────────────── */
.hqpu-source-line {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
}
.hqpu-source-url {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hqpu-source-editor {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
/* The plugin-source editor sits inside its own group right under the fact
 * row, so it needs less air than the runtime one under the facts block. */
.hqpu-source-editor--plugin {
  margin-top: 4px;
}
.hqpu-source-hint {
  flex: 1 1 100%;
  margin: 0;
}
.hqpu-source-controls {
  flex: 1 1 100%;
}
.hqpu-source-input {
  flex: 1 1 240px;
  min-width: 0;
  height: 28px;
  box-sizing: border-box;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12.5px;
}
.hqpu-source-input:disabled {
  opacity: 0.5;
}
.hqpu-source-input:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}

/* ── Footer action row (ui-primitives Modal .footer) ───────────────────── */
.hqpu-footer {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 24px 20px;
}

/* ── Durable job (active / result) ────────────────────────────────────── */
.hqpu-job {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-3);
}
.hqpu-job-meta {
  font-variant-numeric: tabular-nums;
}
.hqpu-progress {
  height: 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  overflow: hidden;
}
.hqpu-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary);
  transition: width var(--ds-transition-duration, 0.2s) ease;
}
.hqpu-job-steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hqpu-steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hqpu-step {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.hqpu-step--skipped,
.hqpu-step--pending { opacity: 0.6; }

/* ── Per-plugin change list + release notes ────────────────────────────── */
.hqpu-changes {
  padding: 0 8px 8px 70px;
}
.hqpu-changes-list,
.hqpu-release-notes {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 19px;
  color: var(--dsw-alias-label-secondary);
}
.hqpu-release-link {
  align-self: flex-start;
}

/* ── Advanced disclosure (source editors) ───────────────────────────────── */
.hqpu-advanced > summary {
  cursor: pointer;
  font-size: 12.5px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
  list-style: none;
  padding: 2px 0;
}
.hqpu-advanced > summary::-webkit-details-marker { display: none; }
.hqpu-advanced > summary::before {
  content: '▸ ';
}
.hqpu-advanced[open] > summary::before {
  content: '▾ ';
}

/* Danger-toned banner (check failure, breaking changes) */
.hqpu-banner[data-tone='danger'] {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  color: var(--dsw-alias-label-secondary);
}
.hqpu-banner[data-tone='danger'] > svg {
  color: var(--dsw-alias-state-error-primary);
}

.hqpu-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* ── Reduced motion: drop every decorative animation ──────────────────── */
@media (prefers-reduced-motion: reduce) {
  .hqpu-scrim,
  .hqpu-panel,
  .hqpu-skeleton-fill,
  .hqpu-spinner,
  .hqpu-toast,
  .hqpu-pulse-ring,
  .hqpu-job-step--active {
    animation: none;
  }
}

/* ════════════════════════════════════════════════════════════════════════
 * Refactored dock (interactive_refactored_ui_mockup.html) — a fluid
 * update-center column. These rules cascade over the shell-token base: the
 * panel takes the available width (up to 720px), every colour is a
 * --dsw-alias-* token so light/dark follow the shell's
 * body[data-ds-dark-theme] and the brand follows the HuaQiu theme overrides,
 * with a sticky header / scroll body / sticky footer. No Tailwind, no
 * dependencies.
 * ════════════════════════════════════════════════════════════════════════ */
.hqpu-panel,
.hqpu-panel * {
  /* Every colour rides a shell theme token, so light/dark follow
   * body[data-ds-dark-theme] automatically. The brand tokens are exactly the
   * ones @huaqiu/dsh-ui-theme-huaqiu overrides (light #C7000B / dark #FF6B74),
   * so the dock honours the HuaQiu brand scheme in both themes without knowing
   * which theme is active. */
  --hq-bg: var(--dsw-alias-bg-layer-1);
  --hq-card: var(--dsw-alias-bg-layer-2);
  --hq-card-soft: var(--dsw-alias-bg-overlay);
  --hq-border: var(--dsw-alias-border-l2);
  --hq-border-strong: var(--dsw-alias-border-l3);
  --hq-hover: var(--dsw-alias-interactive-bg-hover);
  --hq-text: var(--dsw-alias-label-primary);
  --hq-text-strong: var(--dsw-alias-label-primary);
  --hq-text-code: var(--dsw-alias-label-secondary);
  --hq-muted: var(--dsw-alias-label-secondary);
  --hq-faint: var(--dsw-alias-label-tertiary);
  --hq-brand: var(--dsw-alias-brand-primary);
  --hq-brand-soft: var(--dsw-alias-button-primary-hover);
  --hq-brand-dim: var(--dsw-alias-button-primary-dimmed);
  --hq-brand-fg: var(--dsw-alias-brand-primary-invert);
  --hq-emerald: var(--dsw-alias-state-success-primary);
  --hq-amber: var(--dsw-alias-state-warn-primary);
  --hq-rose: var(--dsw-alias-state-error-primary);
}
.hqpu-panel {
  width: min(360px, calc(100vw - 32px));
  max-height: min(86vh, 720px);
  background: var(--hq-bg);
  color: var(--hq-text);
  border: 0.5px solid var(--hq-border);
  border-radius: 12px;
  gap: 0;
  overflow: hidden;
}
.hqpu-scrim {
  background: var(--dsw-alias-bg-mask-3);
}

/* Sticky header */
.hqpu-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 0.5px solid var(--hq-border);
  background: color-mix(in srgb, var(--hq-bg) 95%, transparent);
  position: sticky;
  top: 0;
  z-index: 2;
}
.hqpu-head-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 0;
}
.hqpu-brand-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--hq-brand) 20%, transparent);
  color: var(--hq-brand-soft);
}
.hqpu-brand-icon svg { width: 14px; height: 14px; display: block; }
.hqpu-title-block { min-width: 0; }
.hqpu-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 16px;
  color: var(--hq-text);
}
.hqpu-sub {
  margin: 2px 0 0;
  font-size: 10px;
  line-height: 14px;
  color: var(--hq-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hqpu-toolbar { gap: 2px; }
.hqpu-icon-btn {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  color: var(--hq-muted);
}
.hqpu-icon-btn:hover:not(:disabled) {
  background: var(--hq-hover);
  color: var(--hq-text);
}
.hqpu-icon-btn svg { width: 14px; height: 14px; }

/* Collapsible settings panel */
.hqpu-settings {
  flex: none;
  padding: 10px 12px;
  border-bottom: 0.5px solid var(--hq-border);
  background: var(--hq-card-soft);
}
.hqpu-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.hqpu-settings-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--hq-text-code);
}
.hqpu-origin-badge {
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 0.5px solid;
}
.hqpu-origin-badge[data-origin='config'] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-tertiary) 55%, transparent);
  color: var(--hq-emerald);
  border-color: color-mix(in srgb, var(--hq-emerald) 40%, transparent);
}
.hqpu-origin-badge[data-origin='override'] {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-tertiary) 55%, transparent);
  color: var(--hq-amber);
  border-color: color-mix(in srgb, var(--hq-amber) 40%, transparent);
}
.hqpu-settings label {
  display: block;
  font-size: 10px;
  color: var(--hq-muted);
  margin: 6px 0 3px;
}
.hqpu-source-input {
  width: 100%;
  height: 26px;
  font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--hq-bg);
  border: 0.5px solid var(--hq-border);
  border-radius: 5px;
  color: var(--hq-text-code);
  padding: 0 8px;
  box-sizing: border-box;
}
.hqpu-source-input:focus-visible {
  outline: none;
  border-color: var(--hq-brand-soft);
}
.hqpu-settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 8px;
}

/* Scroll body */
.hqpu-scroll {
  flex: 1;
  padding: 12px;
  background: var(--hq-bg);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.hqpu-column {
  max-width: none;
  margin: 0;
  gap: 10px;
}
.hqpu-stack { gap: 10px; }

/* ── Active-job banner ─────────────────────────────────────────────────── */
.hqpu-active {
  position: relative;
  padding: 12px;
  border-radius: 8px;
  border: 0.5px solid color-mix(in srgb, var(--hq-brand-soft) 30%, transparent);
  background: var(--hq-bg);
  box-shadow: var(--dsw-elevation-prominent);
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
  font-size: 11px;
  font-weight: 600;
  color: var(--hq-text-strong);
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
  background: var(--hq-brand-soft);
}
.hqpu-pulse-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--hq-brand-soft);
  opacity: 0.6;
  animation: hqpu-ping 1.4s cubic-bezier(0, 0, 0.2, 1) infinite;
}
@keyframes hqpu-ping {
  75%, 100% { transform: scale(2.2); opacity: 0; }
}
.hqpu-active-percent {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-weight: 500;
  color: var(--hq-brand-soft);
}
.hqpu-progress {
  height: 6px;
  margin-top: 10px;
  border-radius: 999px;
  background: var(--hq-card);
  overflow: hidden;
}
.hqpu-progress-fill {
  background: linear-gradient(to right, var(--hq-brand), var(--hq-brand-soft));
  transition: width 0.3s ease;
}
.hqpu-active-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  color: var(--hq-muted);
}
/* 4-step indicator row */
.hqpu-job-steps4 {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 0.5px solid var(--hq-border);
  text-align: center;
  font-size: 9px;
  font-weight: 500;
}
.hqpu-job-step--done { color: var(--hq-emerald); }
.hqpu-job-step--active {
  color: var(--hq-brand-soft);
  animation: hqpu-step-pulse 1.2s ease-in-out infinite;
}
.hqpu-job-step--todo { color: var(--hq-muted); }
@keyframes hqpu-step-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

/* ── Result / rollback alert (amber) vs green success ──────────────────── */
.hqpu-alert {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px;
  border-radius: 8px;
}
.hqpu-alert--amber {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-tertiary) 60%, transparent);
  border: 0.5px solid color-mix(in srgb, var(--hq-amber) 35%, transparent);
}
.hqpu-alert--amber svg { color: var(--hq-amber); flex: none; margin-top: 1px; }
.hqpu-alert-green {
  background: color-mix(in srgb, var(--dsw-alias-state-success-tertiary) 55%, transparent);
  border: 0.5px solid color-mix(in srgb, var(--hq-emerald) 35%, transparent);
  color: var(--hq-emerald);
  font-size: 11px;
}
.hqpu-alert-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--dsw-alias-state-warn-label);
}
.hqpu-alert-body {
  margin: 2px 0 0;
  font-size: 10px;
  line-height: 15px;
  color: color-mix(in srgb, var(--dsw-alias-state-warn-label) 85%, transparent);
}
.hqpu-alert-body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: color-mix(in srgb, var(--hq-amber) 18%, transparent);
  padding: 1px 4px;
  border-radius: 3px;
}
.hqpu-alert-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.hqpu-alert-dismiss {
  background: none;
  border: 0;
  padding: 0;
  font-size: 10px;
  color: var(--dsw-alias-state-warn-label);
  cursor: pointer;
  text-decoration: underline;
}

/* ── Runtime engine card ────────────────────────────────────────────────── */
.hqpu-engine {
  padding: 12px;
  border-radius: 8px;
  border: 0.5px solid var(--hq-border);
  background: var(--hq-card);
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
  font-size: 12px;
  font-weight: 600;
  color: var(--hq-text-strong);
}
.hqpu-engine-title svg { width: 14px; height: 14px; color: var(--hq-muted); }
.hqpu-chip {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--hq-card);
  border: 0.5px solid var(--hq-border-strong);
  color: var(--hq-text-code);
}
.hqpu-engine-update-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding: 8px;
  border-radius: 6px;
  border: 0.5px solid color-mix(in srgb, var(--hq-border) 70%, transparent);
  background: color-mix(in srgb, var(--hq-card) 60%, transparent);
}
.hqpu-engine-new-line {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  color: var(--hq-text-code);
}
.hqpu-tag--brand {
  font-size: 9px;
  padding: 1px 4px;
  border-radius: 3px;
  color: var(--hq-brand-soft);
  background: color-mix(in srgb, var(--hq-brand-dim) 60%, transparent);
  border: 0.5px solid color-mix(in srgb, var(--hq-brand) 45%, transparent);
}
.hqpu-engine-size {
  margin: 3px 0 0;
  font-size: 10px;
  color: var(--hq-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hqpu-btn--engine {
  flex: none;
  height: auto;
  padding: 6px 10px;
  font-size: 10px;
  background: var(--hq-card);
  border: 0.5px solid var(--hq-border-strong);
  color: var(--hq-text-strong);
  border-radius: 5px;
}
.hqpu-btn--engine:hover:not(:disabled) { background: var(--hq-border); }
.hqpu-engine-note {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 8px 0 0;
  font-size: 9px;
  color: var(--hq-muted);
}
.hqpu-engine-note svg { width: 10px; height: 10px; color: var(--hq-amber); flex: none; }

/* ── Plugin cards ───────────────────────────────────────────────────────── */
.hqpu-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 2px;
}
.hqpu-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--hq-text-strong);
}
.hqpu-count-pill {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--hq-brand) 20%, transparent);
  color: var(--hq-brand-soft);
}
.hqpu-all-changelog {
  background: none;
  border: 0;
  padding: 0;
  font-size: 10px;
  color: var(--hq-muted);
  cursor: pointer;
}
.hqpu-all-changelog:hover { color: var(--hq-text); }

.hqpu-cards {
  gap: 8px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  align-items: start;
}
.hqpu-card {
  margin: 0;
  padding: 10px;
  border-radius: 8px;
  border: 0.5px solid var(--hq-border);
  background: var(--hq-card);
  transition: border-color 0.15s ease;
}
.hqpu-card:hover { border-color: var(--hq-border-strong); }
.hqpu-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 0;
}
.hqpu-card-head > * { display: flex; align-items: center; gap: 8px; min-width: 0; }
.hqpu-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 0.5px solid var(--hq-border-strong);
  background: var(--hq-card);
  color: var(--hq-text-code);
  font-size: 10px;
  font-weight: 700;
}
.hqpu-card-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--hq-text-strong);
}
.hqpu-card-sub {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  color: var(--hq-faint);
}
.hqpu-version-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
}
.hqpu-ver-old { color: var(--hq-muted); }
.hqpu-ver-arrow { color: var(--hq-border-strong); }
.hqpu-ver-new { color: var(--hq-emerald); font-weight: 700; }
.hqpu-log-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: none;
  border: 0;
  padding: 4px;
  font-size: 10px;
  color: var(--hq-muted);
  cursor: pointer;
}
.hqpu-log-toggle:hover { color: var(--hq-text); }
.hqpu-log-toggle svg { width: 12px; height: 12px; transition: transform 0.15s ease; }
.hqpu-log-toggle[data-open='true'] svg { transform: rotate(180deg); }
.hqpu-changelog-drawer {
  margin-top: 8px;
  padding: 8px;
  border-radius: 6px;
  border: 0.5px solid var(--hq-border);
  background: color-mix(in srgb, var(--hq-card) 80%, transparent);
  font-size: 10px;
}
.hqpu-changelog-drawer-title {
  font-size: 9px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--hq-muted);
}
.hqpu-changelog-drawer ul {
  margin: 4px 0 0;
  padding-left: 16px;
  color: var(--hq-text-code);
  line-height: 16px;
}

/* Sticky footer */
.hqpu-footer {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  padding: 10px 12px 12px;
  border-top: 0.5px solid var(--hq-border);
  background: color-mix(in srgb, var(--hq-bg) 95%, transparent);
}
.hqpu-foot-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 10px;
  color: var(--hq-muted);
}
.hqpu-foot-set {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.hqpu-foot-actions {
  display: flex;
  gap: 8px;
}
.hqpu-btn--block {
  flex: 1;
  height: 32px;
  background: var(--hq-brand);
  color: var(--hq-brand-fg);
  font-size: 11px;
  font-weight: 500;
  border-radius: 6px;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--hq-brand) 40%, transparent);
}
.hqpu-btn--block:hover:not(:disabled) { background: var(--hq-brand-soft); }
.hqpu-btn--block:disabled { opacity: 0.5; box-shadow: none; }
.hqpu-btn--ignore {
  height: 32px;
  padding: 0 10px;
  background: var(--hq-card);
  border: 0.5px solid var(--hq-border);
  color: var(--hq-muted);
  font-size: 10px;
  border-radius: 6px;
}
.hqpu-btn--ignore:hover:not(:disabled) { background: var(--hq-hover); color: var(--hq-text); }
.hqpu-footnote {
  margin: 0;
  font-size: 9px;
  text-align: center;
  color: var(--hq-muted);
}

/* Shared bits on the new palette */
.hqpu-status { color: var(--hq-muted); font-size: 11px; }
.hqpu-empty { color: var(--hq-muted); font-size: 11px; padding: 16px 0; }
.hqpu-toast { background: var(--hq-card); border: 0.5px solid var(--hq-border); color: var(--hq-text); font-size: 12px; }
.hqpu-skeleton-fill { background: var(--hq-border); }
.hqpu-job { background: var(--hq-card); border-color: var(--hq-border); }
.hqpu-job-meta { color: var(--hq-muted); }
.hqpu-release-notes { color: var(--hq-muted); font-size: 11px; }
.hqpu-advanced > summary { color: var(--hq-muted); }
.hqpu-recent-jobs li { color: var(--hq-muted); font-size: 10px; }
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

/** In-memory update-report store shared by the badge and the modal. */
class UpdateStore implements UpdateStoreLike {
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

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Badge: counts actionable plugin updates AND an available runtime update AND
   * (while a job runs) an attention pill. A recent failed/rolled-back job with
   * nothing actionable left also keeps a dot, so the outcome is never silently
   * forgotten after the panel closes.
   */
  badgeCount(): number {
    const job = this.active
    if (job !== null && !TERMINAL_PHASES.has(job.phase)) return 1
    const report = this.current
    if (report === null) return 0
    let count = report.items.filter(
      (item) => item.state === 'update' || item.state === 'install',
    ).length
    if (report.runtime?.updateAvailable) count += 1
    if (count === 0) {
      const latest = this.recent[0]
      if (latest !== undefined && (latest.phase === 'failed' || latest.phase === 'rolled-back')) {
        count = 1
      }
    }
    return count
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
    if (wasActive && this.active === null) {
      // The active job settled (moved to recent/terminal) — the installing
      // footer state must clear on its own, without the panel's closure.
      this.installingFlag = false
    }
    this.emit()
    this.schedulePoll()
  }

  /**
   * Fetch the durable job status. Called on mount, on panel open (BEFORE
   * discovery) and by the poll loop. A failure (older hq-edge with no
   * `/status`, or a transient HTTP error) is swallowed: the last known job is
   * kept and the poller backs off and retries.
   */
  async fetchStatus(): Promise<void> {
    try {
      const status = await fetchJobStatus()
      this.pollBackoffMs = 1_000
      this.applyStatus(status)
    } catch {
      this.schedulePoll()
    }
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
      const status = await fetchJobStatus()
      this.pollBackoffMs = 1_000
      this.applyStatus(status)
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

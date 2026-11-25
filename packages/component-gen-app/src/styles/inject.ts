/**
 * `@huaqiu/component-gen-app` — scoped stylesheet.
 *
 * Injected as a `<style>` tag (never a CSS import) so both build surfaces work:
 * the standalone vite bundle AND the DSH client-module bundle (tsdown has no
 * CSS pipeline). Reuses the `hq-genhit__*` class vocabulary (shared with
 * `dsh-tool-symbol-footprint`) plus an `cga-*` app-shell layer. Uses the same
 * DSW design tokens so the app follows the host palette in DSH.
 */
export const APP_STYLE_ID = 'hq-cga-styles'
export const APP_PLUGIN_ID = '@huaqiu/component-gen-app'

const CSS = `
/* ── shared with dsh-tool-symbol-footprint (editor + preview) ─────────────── */
.hq-genhit__stage { position: relative; display: flex; align-items: center; justify-content: center; width: 100%; box-sizing: border-box; background: var(--dsw-alias-markdown-code-block, #0a1929); overflow: hidden; }
.hq-genhit__stage--symbol, .hq-genhit__stage--footprint { height: 300px; }
.hq-genhit__canvas { display: block; width: 100%; height: 100%; background: var(--dsw-alias-markdown-code-block, #0a1929); }
.hq-genhit__stage-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 10px 14px; box-sizing: border-box; font: var(--dsw-font-xxs-12, 12px/1.4 system-ui, sans-serif); color: var(--dsw-alias-label-secondary, currentColor); text-align: center; }
.hq-genhit__editor { padding: 0 12px 4px; }
.hq-genhit__geom { display: block; width: 100%; height: auto; touch-action: none; }
.hq-genhit__body { fill: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)); stroke: var(--dsw-alias-label-primary, currentColor); stroke-width: 1.5; }
.hq-genhit__pad { fill: var(--dsw-alias-accent-primary, currentColor); opacity: 0.85; }
.hq-genhit__ball { fill: var(--dsw-alias-accent-primary, currentColor); opacity: 0.85; }
.hq-genhit__epad { fill: var(--dsw-alias-accent-primary, currentColor); opacity: 0.25; stroke: var(--dsw-alias-accent-primary, currentColor); stroke-width: 1; stroke-dasharray: 2 2; }
.hq-genhit__pkg { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding: 0 0 8px; }
.hq-genhit__badge--pkg { border-color: var(--dsw-alias-accent-primary, currentColor); color: var(--dsw-alias-accent-primary, currentColor); }
.hq-genhit__pkg-meta { font: var(--dsw-font-xxs-12, 12px/1.4 system-ui, sans-serif); color: var(--dsw-alias-label-secondary, currentColor); }
.hq-genhit__pkg-meta--sep { opacity: 0.85; }
.hq-genhit__dimline { stroke: var(--dsw-alias-label-secondary, currentColor); stroke-width: 1; }
.hq-genhit__dimlabel { fill: var(--dsw-alias-label-secondary, currentColor); font: 11px/1 system-ui, sans-serif; }
.hq-genhit__dimlabel--clickable { cursor: pointer; }
.hq-genhit__dimlabel--clickable:hover { fill: var(--dsw-alias-accent-primary, currentColor); text-decoration: underline; }
.hq-genhit__tol { fill: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor)); font: 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
.hq-genhit__arrow { fill: var(--dsw-alias-label-secondary, currentColor); }
.hq-genhit__handle { fill: var(--dsw-alias-accent-primary, currentColor); stroke: var(--dsw-alias-bg-layer-1, #fff); stroke-width: 1.5; cursor: ew-resize; }
.hq-genhit__handle--h { cursor: ns-resize; }
.hq-genhit__handle--wh { cursor: nwse-resize; }
.hq-genhit__drag-hint { padding: 0 2px 6px; font: var(--dsw-font-xxs-12, 12px/1.4 system-ui, sans-serif); color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor)); }
.hq-genhit__fields { display: flex; flex-wrap: wrap; gap: 8px 12px; padding: 0 0 10px; }
.hq-genhit__field { display: inline-flex; align-items: center; gap: 6px; }
.hq-genhit__field-label { font: var(--dsw-font-xxs-12, 12px/1.4 system-ui, sans-serif); color: var(--dsw-alias-label-secondary, currentColor); }
.hq-genhit__field-label--edited { color: var(--dsw-alias-accent-primary, currentColor); }
.hq-genhit__field-tag { font: 10px/1.2 system-ui, sans-serif; padding: 1px 4px; border-radius: 4px; }
.hq-genhit__field-tag--ai { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor)); border: 1px solid var(--dsw-alias-border-l1, currentColor); }
.hq-genhit__field-tag--edited { color: var(--dsw-alias-accent-primary, currentColor); border: 1px solid var(--dsw-alias-accent-primary, currentColor); }
.hq-genhit__field-input { width: 72px; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, currentColor); background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary, currentColor); font: var(--dsw-font-xxs-12, 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace); }
.hq-genhit__field--invalid .hq-genhit__field-input { border-color: var(--dsw-alias-state-error-primary, currentColor); }
.hq-genhit__field-unit { font: var(--dsw-font-xxs-12, 12px/1.4 system-ui, sans-serif); color: var(--dsw-alias-label-secondary, currentColor); }
.hq-genhit__adv { padding: 0 0 8px; }
.hq-genhit__adv-toggle { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--dsw-alias-border-l1, currentColor); border-radius: 6px; padding: 3px 8px; background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-secondary, currentColor); font: var(--dsw-font-xxs-12, 12px/1.4 system-ui, sans-serif); cursor: pointer; }
.hq-genhit__fields--adv { padding-top: 8px; }
.hq-genhit__validation { display: flex; align-items: baseline; gap: 6px; padding: 6px 10px; margin: 0 0 10px; border-radius: 6px; font: var(--dsw-font-xxs-12, 12px/1.4 system-ui, sans-serif); color: var(--dsw-alias-label-secondary, currentColor); background: var(--dsw-alias-interactive-bg-hover, transparent); }
.hq-genhit__validation--warn { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-error-primary, currentColor)); background: var(--dsw-alias-state-warning-bg, transparent); }
.hq-genhit__validation-detail { opacity: 0.85; }

/* ── app shell (cga-*) — tokens/geometry follow dsh's Modal + settings dialog
   (mask-1/mask-blur, layer-2 + elevation, r24 dialog, 28x28 r8 close, 13px/500
   labels, r8 inputs on bg-layer-3 with border-l4, capsule sm buttons) ─────── */
.cga-app { display: flex; flex-direction: column; gap: 12px; width: 100%; box-sizing: border-box; padding: 0 16px 16px; font: var(--dsw-font-s-14, 14px/1.5 system-ui, sans-serif); color: var(--dsw-alias-label-primary, currentColor); }
.cga-app__body { display: flex; flex-direction: column; gap: 12px; }
.cga-app__head { position: sticky; top: 0; z-index: 8; display: flex; align-items: center; gap: 8px; padding: 16px 0 12px; background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, transparent)); border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2));}
.cga-app__head-title { font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary, currentColor); }
.cga-app__head-close { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; margin-left: auto; padding: 0; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, currentColor); cursor: pointer; }
.cga-app__head-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)); }
.cga-panel { border-radius: 8px; background: var(--dsw-alias-bg-layer-1, transparent); overflow: hidden; }
.cga-panel__body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.cga-upload { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 12px; box-sizing: border-box; overflow: hidden; min-height: 0; border: 1px dashed var(--dsw-alias-border-l3, currentColor); border-radius: 12px; background: var(--dsw-alias-bg-layer-3, transparent); cursor: pointer; transition: background 120ms ease, border-color 120ms ease; }
.cga-upload:hover { border-color: var(--dsw-alias-brand-primary, var(--dsw-alias-accent-primary, currentColor)); background: var(--dsw-alias-interactive-bg-hover, transparent); }
.cga-upload--dragging { border-color: var(--dsw-alias-brand-primary, var(--dsw-alias-accent-primary, currentColor)); background: var(--dsw-alias-interactive-bg-hover, transparent); }
.cga-upload__thumb { max-width: 100%; max-height: 100px; flex: 0 1 auto; min-height: 0; border-radius: 8px; object-fit: contain; background: var(--dsw-alias-bg-layer-1, transparent); }
.cga-upload__filename { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cga-upload__text { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor)); text-align: center; }
.cga-upload__browse { margin-top: 2px; height: 28px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l3, currentColor); border-radius: 14px; background: transparent; color: var(--dsw-alias-label-primary, currentColor); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }
.cga-upload__browse:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)); }
.cga-field { display: flex; flex-direction: column; gap: 6px; }
.cga-field__label { font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--dsw-alias-label-primary, currentColor); }
.cga-field__input, .cga-field__select { height: 34px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4, currentColor); border-radius: 8px; background: var(--dsw-alias-bg-layer-3, transparent); color: var(--dsw-alias-label-primary, currentColor); font: inherit; font-size: 13px; line-height: 1.5;width: 140px; }
.cga-field__input:focus-visible, .cga-field__select:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary, var(--dsw-alias-accent-primary, currentColor)); }
.cga-field__input:disabled, .cga-field__select:disabled { opacity: 0.55; cursor: default; }
.cga-field__input::placeholder { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary, currentColor)); }
.cga-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.cga-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 30px; padding: 0 12px; border: 0.5px solid transparent; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary, currentColor); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; transition: background 120ms ease, opacity 120ms ease; }
.cga-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)); }
.cga-btn:disabled { opacity: 0.45; cursor: default; }
.cga-btn--primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-accent-primary, currentColor)); border-color: transparent; color: var(--dsw-alias-label-primary-foreground, #fff); }
.cga-btn--primary:hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-accent-primary, currentColor)); }
.cga-btn--primary:disabled { opacity: 0.6; }
.cga-btn--outline { border: 0.5px solid var(--dsw-alias-border-l3, currentColor); }
.cga-btn--outline:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)); }

/* ── SVG dimension editor (NextChat editFootprint port) ───────────────────── */
.cga-eip { display: flex; flex-direction: column; gap: 12px; }
.cga-eip__hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, currentColor); }
.cga-eip__notfound { margin: 0; font-size: 14px; line-height: 1.6; color: var(--dsw-alias-label-primary, currentColor); }
.cga-eip__body { display: flex; gap: 16px; align-items: flex-start; }
.cga-eip__stage { flex: 0 0 auto; border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); border-radius: 12px; background: #fff; padding: 18px; }
.cga-eip__canvas { position: relative; width: 330px; margin: 0 auto; }
.cga-eip__sidepanel { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.cga-eip__bg { display: block; width: 100%; height: auto; user-select: none; }
.cga-eip__side { margin-top: 24px; }
.cga-eip__point { position: absolute; z-index: 5; padding: 1px 5px; border-radius: 6px; border: 1px solid transparent; font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; color: #1f2329; background: transparent; white-space: nowrap; }
.cga-eip__point--editable { cursor: pointer; border-color: #c9cdd4; background: #f7f8fa; }
.cga-eip__point--editable:hover { border-color: var(--dsw-alias-brand-primary, #1664ff); color: var(--dsw-alias-brand-primary, #1664ff); background: #eef4ff; }
.cga-eip__editor { position: absolute; z-index: 10; }
.cga-eip__input, .cga-eip__select { height: 26px; width: 72px; padding: 0 6px; box-sizing: border-box; border: 1px solid var(--dsw-alias-brand-primary, var(--dsw-alias-accent-primary, currentColor)); border-radius: 6px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, currentColor); font: inherit; font-size: 12px; }
.cga-eip__select { width: 84px; padding: 0 4px; }
.cga-eip__divider-h { position: absolute; box-sizing: border-box; height: 2px; width: 8px; border-top: 1px solid var(--dsw-alias-label-secondary, currentColor); }
.cga-eip__divider-v { position: absolute; box-sizing: border-box; height: 8px; width: 2px; border-left: 1px solid var(--dsw-alias-label-secondary, currentColor); }
.cga-eip__fields { display: flex; flex-direction: column; gap: 10px; }
.cga-eip__field { display: flex; align-items: center; gap: 10px; height: 30px; }
.cga-eip__field-label { min-width: 72px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary, currentColor); }
.cga-eip__field-input, .cga-eip__field-select { height: 28px; padding: 0 8px; box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l4, currentColor); border-radius: 6px; background: var(--dsw-alias-bg-layer-3, transparent); color: var(--dsw-alias-label-primary, currentColor); font: inherit; font-size: 12px; }
.cga-eip__field-input { width: 88px; }
.cga-eip__field-select { width: 96px; }
.cga-eip__field-value { font-size: 12px; color: var(--dsw-alias-label-primary, currentColor); }
.cga-eip__extract { height: 26px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l3, currentColor); border-radius: 6px; background: transparent; color: var(--dsw-alias-brand-primary, var(--dsw-alias-accent-primary, currentColor)); font: inherit; font-size: 12px; cursor: pointer; }
.cga-eip__extract:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08)); }
.cga-eip__actions { display: flex; gap: 8px; padding-top: 12px; border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); }
.cga-app__head-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.cga-banner { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.5; }
.cga-banner--info { color: var(--dsw-alias-label-secondary, currentColor); background: var(--dsw-alias-interactive-bg-hover, transparent); }
.cga-banner--warn { color: var(--dsw-alias-state-warning-primary, currentColor); background: var(--dsw-alias-state-warning-bg, transparent); }
.cga-banner--error { color: var(--dsw-alias-state-error-primary, currentColor); background: var(--dsw-alias-state-error-bg, transparent); }
.cga-progress { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary, currentColor); }
.cga-toast { position: fixed; left: 50%; top: 24px; transform: translateX(-50%); z-index: 1200; display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #fff); box-shadow: var(--dsw-elevation-prominent, 0 4px 16px rgba(0,0,0,0.16)); font-size: 13px; line-height: 1.4; color: var(--dsw-alias-label-primary, currentColor); pointer-events: none; }
.cga-spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l3, currentColor); border-top-color: var(--dsw-alias-brand-primary, var(--dsw-alias-accent-primary, currentColor)); animation: cga-spin 0.8s linear infinite; flex: none; }
@keyframes cga-spin { to { transform: rotate(360deg); } }
.cga-history { display: flex; flex-direction: column; gap: 6px; }
.cga-history__item { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2)); border-radius: 8px; }
.cga-history__meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.cga-history__title { font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary, currentColor); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cga-history__sub { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor)); }
.cga-history__act { border: 0; background: none; color: var(--dsw-alias-brand-primary, var(--dsw-alias-accent-primary, currentColor)); font: inherit; font-size: 12px; line-height: 1.5; cursor: pointer; padding: 2px 4px; }
.cga-history__act:hover { color: var(--dsw-alias-label-primary, currentColor); }
.cga-auth { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover, transparent); font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary, currentColor); }

/* ── extract phase — left/right layout ─────────────────────────────────── */
.cga-extract { display: flex; align-items: flex-start; gap: 16px; }
.cga-extract__upload { flex: 0 0 200px; min-width: 0; }
.cga-extract__side { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; padding: 2px 0; }
.cga-extract__side .cga-field { flex-direction: row; align-items: center; gap: 10px; }
.cga-extract__side .cga-field__label { white-space: nowrap; }
.cga-extract__tip { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor)); }
.cga-actions--block { flex-direction: column; }
.cga-btn--block { width: 100%; }
.cga-extract__side .cga-btn--block { max-width: 80px; }

/* History modal — same chrome as dsh's Modal/settings dialog. */
.cga-history-dialog { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
.cga-history-dialog__mask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur); }
.cga-history-dialog__panel { position: relative; z-index: 1; display: flex; flex-direction: column; width: min(480px, 100%); max-height: min(560px, calc(100vh - 48px)); overflow: hidden; border-radius: 24px; background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); }
.cga-history-dialog__head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 20px 14px 8px 24px; }
.cga-history-dialog__title { font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary, currentColor); }
.cga-history-dialog__body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 24px 24px; }

/* Workspace popup panel (host shell.overlay) — size lives here so the
   portrait breakpoint below can take it full-screen. */
.cga-ws-panel { width: min(760px, 100%); height: min(510px, 100%); border-radius: 24px; }

/* ── mobile / portrait ────────────────────────────────────────────────────
   Narrow viewports stack the two-column layouts vertically and keep the
   dimension canvas aligned by scaling it as a whole (zoom also scales the
   absolutely-positioned data points, so they stay on the artwork). */
@media (max-width: 720px) {
  .cga-ws-panel { width: 100%; height: auto; max-height: 100%; border-radius: 16px; }
  .cga-app { padding: 0 12px 12px; }
  .cga-app__head { padding: 12px 0 10px; }
  .cga-app__head-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cga-extract { flex-direction: column; align-items: stretch; gap: 12px; }
  .cga-extract__upload { flex: 0 0 auto; width: 100%; }
  .cga-extract__side .cga-field { flex-wrap: wrap; }
  .cga-eip__body { flex-direction: column; align-items: stretch; }
  .cga-eip__stage { align-self: center; max-width: 100%; box-sizing: border-box; overflow-x: auto; padding: 0; }
  .cga-eip__canvas { zoom: 0.85; }
  .cga-eip__sidepanel { width: 100%; }
  .cga-eip__actions { flex-wrap: wrap; }
  .cga-toast { max-width: calc(100vw - 24px); box-sizing: border-box; }
  .cga-history-dialog { padding: 12px; }
  .cga-history-dialog__panel { max-height: calc(100vh - 24px); border-radius: 16px; }
}
`

export function injectAppStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(APP_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = APP_STYLE_ID
  style.setAttribute('data-plugin', APP_PLUGIN_ID)
  style.textContent = CSS
  document.head.appendChild(style)
}

export function removeAppStyles(): void {
  if (typeof document === 'undefined') return
  document.getElementById(APP_STYLE_ID)?.remove()
}

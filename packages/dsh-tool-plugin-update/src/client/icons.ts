/**
 * Official DSH icon artwork, inlined as SVG strings.
 *
 * The paths are copied verbatim from `@deepseek-ai/dsh-client-ui-primitives`
 * (deepseek-harness `packages/client/ui-primitives/src/icons/index.tsx`) so the
 * Huaqiu plugin-update view draws the same glyphs as the shell's own plugin
 * manager. Only `currentColor` is used, so every glyph inherits the label ink
 * of whatever surface it sits on — the same contract the primitives rely on.
 *
 * The plugin renders plain DOM (never a React tree), so the artwork is exposed
 * as markup strings rather than components.
 *
 * @module
 */

/** Stroke width of the primitives' "Regular" weight. */
const REGULAR = 1

/** Stroke width of the primitives' "Medium" weight. */
const MEDIUM = 1.3

/** Wrap paths in a 16×16 stroked glyph. */
function glyph(size: number, strokeWidth: number, paths: readonly string[], viewBox = '0 0 16 16'): string {
  const body = paths.map((d) => `<path d="${d}" stroke="currentColor" />`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" fill="none" aria-hidden="true" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

/** Wrap fill-only paths (the check glyph) in their own viewBox. */
function fillGlyph(size: number, paths: readonly string[], viewBox: string): string {
  const body = paths.map((d) => `<path d="${d}" fill="currentColor" />`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" fill="none" aria-hidden="true">${body}</svg>`
}

/**
 * The plugin pinwheel — the glyph the shell's own Plugins sidebar entry uses
 * (`IconPluginPinwheelOutlineRegular`). Shared by the sidebar row and the
 * package cards so both read as the same feature.
 */
export const PLUGIN_ICON = (size = 16): string =>
  glyph(size, REGULAR, [
    'M7.84457 5.06199C11.6605 4.93876 14.7962 6.14848 14.8484 7.76397C14.8875 8.97461 13.1838 10.0696 10.7215 10.5942',
    'M5.12742 8.07731C5.00419 4.26138 6.21391 1.12568 7.8294 1.07351C9.04004 1.03441 10.135 2.73808 10.6596 5.20037',
    'M8.02457 10.6802C4.20865 10.8034 1.07294 9.5937 1.02077 7.97821C0.981678 6.76758 2.68535 5.67262 5.14763 5.14798',
    'M10.7476 7.89535C10.8708 11.7113 9.66109 14.847 8.0456 14.8991C6.83496 14.9382 5.74 13.2346 5.21536 10.7723',
  ])

/** The toolbar's refresh action (`IconRefreshOutlineRegular`). */
export const REFRESH_ICON = (size = 16): string =>
  glyph(size, REGULAR, [
    'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1',
    'M14.4999 1.5V5.1H10.8999',
  ])

/**
 * The toolbar's log toggle: a page with ruled lines — "the update log".
 *
 * Not a shell primitive (the shell has no equivalent glyph), so it is drawn to
 * the same 16×16 / 1px-stroke contract as the rest of this module.
 */
export const LOG_ICON = (size = 16): string =>
  glyph(size, REGULAR, [
    'M9.5 1.5H4.5C3.94772 1.5 3.5 1.94772 3.5 2.5V13.5C3.5 14.0523 3.94772 14.5 4.5 14.5H11.5C12.0523 14.5 12.5 14.0523 12.5 13.5V4.5L9.5 1.5Z',
    'M9.5 1.5V4.5H12.5',
    'M6 8.25H10',
    'M6 10.75H10',
  ])

/** The panel's close action (`IconCloseOutlineMedium`). */
export const CLOSE_ICON = (size = 16): string =>
  glyph(size, MEDIUM, ['M2.5 2.5L13.5 13.5', 'M13.5 2.5L2.5 13.5'])

/** The notice glyph (`IconWarningOutlineRegular`). */
export const WARNING_ICON = (size = 16): string =>
  glyph(size, REGULAR, [
    'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z',
    'M8 4.29199V9.79199',
    'M8 10.708V11.708',
  ])

/** The settled-state glyph (`IconCheckCircleFillRegular`). */
export const CHECK_CIRCLE_ICON = (size = 16): string =>
  fillGlyph(size, [
    'M28.1936 14.6936L19.8066 23.0806C19.2373 23.65 18.7159 24.1742 18.24 24.5571C17.7389 24.9602 17.1365 25.3359 16.3657 25.458C15.9581 25.5225 15.5428 25.5225 15.1353 25.458C14.3645 25.3359 13.7621 24.9602 13.261 24.5571C12.7851 24.1742 12.2637 23.65 11.6943 23.0806L7.80737 19.1936L10.1936 16.8074L14.0806 20.6943C14.7033 21.317 15.0763 21.6873 15.377 21.9292C15.6523 22.1507 15.7109 22.1325 15.6626 22.1248C15.7208 22.1339 15.7802 22.1339 15.8384 22.1248C15.7901 22.1325 15.8486 22.1507 16.124 21.9292C16.4247 21.6873 16.7977 21.317 17.4204 20.6943L25.8074 12.3074L28.1936 14.6936Z',
    'M32.8496 18.0005C32.8496 9.79906 26.2019 3.15137 18.0005 3.15137C9.79906 3.15137 3.15137 9.79906 3.15137 18.0005C3.15137 26.2019 9.79906 32.8496 18.0005 32.8496C26.2019 32.8496 32.8496 26.2019 32.8496 18.0005ZM35.7764 18.0005C35.7764 27.8173 27.8173 35.7764 18.0005 35.7764C8.18363 35.7764 0.224609 27.8173 0.224609 18.0005C0.224609 8.18363 8.18363 0.224609 18.0005 0.224609C27.8173 0.224609 35.7764 8.18363 35.7764 18.0005Z',
  ], '0 0 36 36')

/** The install action (`IconDownloadOutlineRegular`). */
export const DOWNLOAD_ICON = (size = 16): string =>
  glyph(size, REGULAR, [
    'M8 1.95317V10.0469',
    'M4.25 6.29688L8 10.0469L11.75 6.29688',
    'M1.5 10.0469V13.158C1.5 13.3937 1.60536 13.6198 1.79289 13.7865C1.98043 13.9532 2.23478 14.0469 2.5 14.0469H13.5C13.7652 14.0469 14.0196 13.9532 14.2071 13.7865C14.3946 13.6198 14.5 13.3937 14.5 13.158V10.0469',
  ])

/** The head's info affordance (`IconInfoOutlineRegular`, fill-only artwork). */
export const INFO_ICON = (size = 11): string =>
  fillGlyph(size, [
    'M12.5757 7.00012C12.5757 3.92085 10.0794 1.42463 7.00012 1.42456C3.9208 1.42456 1.42456 3.9208 1.42456 7.00012C1.42463 10.0794 3.92085 12.5757 7.00012 12.5757C10.0793 12.5756 12.5756 10.0793 12.5757 7.00012ZM13.8002 7.00012C13.8001 10.7559 10.7559 13.8001 7.00012 13.8002C3.2443 13.8002 0.199291 10.7559 0.199219 7.00012C0.199219 3.24426 3.24426 0.199219 7.00012 0.199219C10.7559 0.199291 13.8002 3.2443 13.8002 7.00012Z',
    'M7.6127 3.18921V4.55986H6.38735V3.18921H7.6127Z',
    'M7.6127 5.68921V10.8109H6.38735V5.68921H7.6127Z',
  ], '0 0 14 14')

/** A folded section's chevron (`IconChevronDownOutlineRegular`). */
export const CHEVRON_DOWN_ICON = (size = 14): string =>
  glyph(size, REGULAR, ['M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6'])

/** A right-pointing chevron — a collapsed row, rotated by CSS when it opens. */
export const CHEVRON_RIGHT_ICON = (size = 14): string =>
  glyph(size, REGULAR, ['M6 4L9.29289 7.29289C9.68342 7.68342 9.68342 8.31658 9.29289 8.70711L6 12'])

/**
 * The per-card mute action: an eye with a slash (忽略此插件).
 *
 * Drawn here rather than borrowed: the shell's icon set has no
 * "stop offering this" glyph, and a bare 忽略 text button competed with the
 * card's primary action for the same 40 px.
 */
export const EYE_OFF_ICON = (size = 14): string =>
  glyph(size, REGULAR, [
    'M1.5 8C3 4.6 5.4 3 8 3C10.6 3 13 4.6 14.5 8C13 11.4 10.6 13 8 13C5.4 13 3 11.4 1.5 8Z',
    'M10 8C10 9.10457 9.10457 10 8 10C6.89543 10 6 9.10457 6 8C6 6.89543 6.89543 6 8 6C9.10457 6 10 6.89543 10 8Z',
    'M2.5 2.5L13.5 13.5',
  ])

/**
 * Copy-to-clipboard (the log drawer's 复制日志 ID): two offset rounded frames.
 */
export const COPY_ICON = (size = 14): string =>
  glyph(size, REGULAR, [
    'M5.5 5.5V2.5C5.5 2.22386 5.72386 2 6 2H13C13.2761 2 13.5 2.22386 13.5 2.5V9.5C13.5 9.77614 13.2761 10 13 10H10',
    'M2.5 6C2.5 5.72386 2.72386 5.5 3 5.5H10C10.2761 5.5 10.5 5.72386 10.5 6V13C10.5 13.2761 10.2761 13.5 10 13.5H3C2.72386 13.5 2.5 13.2761 2.5 13V6Z',
  ])

/** The runtime card's badge: a bolt (the HQ Edge core distribution). */
export const BOLT_ICON = (size = 14): string =>
  glyph(size, REGULAR, ['M9.33333 2L4.66667 8H8L6.66667 14L11.33333 8H8L9.33333 2Z'])

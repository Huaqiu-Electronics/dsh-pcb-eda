/**
 * The HuaQiu brand mark, byte-for-byte `assets/huaqiu.svg` (repo root).
 *
 * The client bundle cannot fetch repository assets or add runtime dependencies
 * (its `inject` list is fixed and `@deepseek-ai/*` is never bundled), so the file
 * travels as a base64 data URI: one string constant, no build-side asset pipeline,
 * and the rendered mark is the vendor file itself rather than a redrawn lookalike.
 *
 * `test/brand.test.ts` decodes this back to text and compares it with the asset on
 * disk, so a re-exported logo that is not re-encoded here fails the suite instead of
 * silently drifting.
 */
export const HUAQIU_LOGO_SVG_BASE64 =
  'PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4KPCEtLSBHZW5lcmF0b3I6IEFkb2JlIElsbHVzdHJhdG9yIDI1LjAuMCwgU1ZHIEV4cG9ydCBQbHVnLUluIC4gU1ZHIFZlcnNpb246IDYuMDAgQnVpbGQgMCkgIC0tPgo8c3ZnIHZlcnNpb249IjEuMSIgaWQ9IuWbvuWxgl8xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB4PSIwcHgiIHk9IjBweCIKCSB2aWV3Qm94PSIwIDAgNTAgNTAiIHN0eWxlPSJlbmFibGUtYmFja2dyb3VuZDpuZXcgMCAwIDUwIDUwOyIgeG1sOnNwYWNlPSJwcmVzZXJ2ZSI+CjxzdHlsZSB0eXBlPSJ0ZXh0L2NzcyI+Cgkuc3Qwe2ZpbGw6I0NDMDAwMDt9Cjwvc3R5bGU+CjxnPgoJPHBhdGggY2xhc3M9InN0MCIgZD0iTTM4LjMsMEgxMS45QzUuNSwwLDAuMSw1LjMsMC4xLDExLjh2MjYuM0MwLjEsNDQuNiw1LjQsNTAsMTEuOSw1MGgyNi4zYzAuMSwwLDAuMywwLDAuNiwwCgkJYy0xLjUtMS41LTIuMi0zLjMtMi4yLTUuNWMwLTAuNiwwLTEuMiwwLjEtMS43SDEyLjFjLTIuNSwwLTQuNC0yLTQuNC00LjRWMTEuOGMwLTIuNSwyLTQuNCw0LjQtNC40aDI2LjNjMi41LDAsNC40LDIsNC40LDQuNHYyNC43CgkJYzAuNi0wLjEsMS4yLTAuMSwxLjctMC4xYzIuMiwwLDQuMSwwLjksNS41LDIuMmMwLTAuMSwwLTAuMywwLTAuNFYxMS44QzUwLDUuMyw0NC44LDAsMzguMywweiIvPgoJPHBhdGggY2xhc3M9InN0MCIgZD0iTTQ0LjUsMzguOWMtMy4xLDAtNS41LDIuNS01LjUsNS41czIuNSw1LjUsNS41LDUuNWMzLjEsMCw1LjUtMi41LDUuNS01LjVDNDkuOSw0MS4yLDQ3LjYsMzguOSw0NC41LDM4Ljl6Ii8+Cgk8cG9seWdvbiBjbGFzcz0ic3QwIiBwb2ludHM9IjM3LjgsMzcuNyAzNy44LDEyLjMgMzAuNSwxMi4zIDMwLjUsMjEuMyAxOS44LDIxLjMgMTkuOCwxMi4zIDEyLjMsMTIuMyAxMi4zLDM3LjcgMTkuOCwzNy43IAoJCTE5LjgsMjguNiAzMC41LDI4LjYgMzAuNSwzNy43IAkiLz4KPC9nPgo8L3N2Zz4K'

/** The mark as an `<img src>`; carries its own viewBox, so it scales to any size. */
export const HUAQIU_LOGO_SRC = `data:image/svg+xml;base64,${HUAQIU_LOGO_SVG_BASE64}`

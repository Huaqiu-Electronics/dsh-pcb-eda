/**
 * Runtime locale pack for the `gen-hit` card (zh + en). Kept self-contained
 * (not the DSH `locale` service) so the card works without registering a
 * namespace; the default is zh.
 */
import { useCallback } from 'react'
import { useLocale } from './theme.js'

/**
 * Chinese is the source of truth: `CopyKey` is derived from it, and `EN` is
 * typed against it. A key added to `ZH` but missing from `EN` is a COMPILE
 * error, which is what stops a half-translated pack from silently falling
 * back to Chinese at runtime.
 */
const ZH = {
    'card.title.symbol': '生成符号',
    'card.title.footprint': '生成封装',
    'card.title.generic': '生成结果',
    'card.kind.symbol': '符号',
    'card.kind.footprint': '封装',
    'card.kind.schematic': '原理图',
    'card.kind.pcb': 'PCB',
    'card.status.generating': '正在生成…',
    'card.status.generated': '已生成',
    'card.status.failed': '生成失败',
    'card.status.cancelled': '已取消',
    'card.status.confirm': '待确认尺寸',
    'card.status.noPreview': '预览不可用',
    'card.preview.loading': '正在加载预览…',
    'card.preview.renderError': '预览渲染失败：',
    'card.preview.resolveError': '无法解析工件：',
    'card.preview.missing': '没有可用于预览的工件内容',
    'card.error.toolFailed': '工具调用失败',
    'card.error.retry': '重试',
    'card.confirm.body': '请确认或修正以下尺寸；确认后告诉我，我将继续生成。',
    'card.note.noPreview': '预览不可用，可下载原始文件。',
    'card.action.download': '下载',
    'card.action.downloading': '下载中…',
    'card.action.place': '放置到编辑器',
    'card.action.placing': '放置中…',
    'card.place.done': '已放置到编辑器',
    'card.place.failed': '放置失败：',
    'card.action.regenerate': '重新生成',
    'card.action.regenerating': '重新生成中…',
    'card.action.inspect': '详情',
    'card.action.regenerateFailed': '重新生成失败',
    'card.regeneratePrompt': '请重新生成刚才的{kind}',
    'card.meta.pkg': '封装类型',
    'card.editor.unit': 'mm',
    'card.editor.hint': '请确认或修改下方尺寸，确认后自动生成封装。',
    'card.editor.dragHint': '拖动图形或直接输入数值调整尺寸',
    'card.editor.confirm': '确认尺寸',
    'card.editor.cancel': '取消',
    'card.editor.sent': '已确认尺寸，正在继续生成…',
    'card.editor.declined': '已取消生成',
    'card.editor.invalid': '数值无效',
    'card.editor.pins': '{count} 引脚',
    'card.editor.body': '本体',
    'card.editor.pitch': '间距',
    'card.editor.edited': '已改',
    'card.editor.ai': 'AI',
    'card.editor.advanced': '高级尺寸',
    'card.editor.validationOk': '✓ 就绪',
    'card.editor.validationIssue': '⚠ {n} 个问题',
    'card.editor.issueOutOfRange': '超出允许范围',
    'card.editor.issueMinGtMax': '最小值大于最大值',
    'card.editor.svgHint': '这是从您上传的图片中提取到的封装参数，请确认参数正确后继续',
    'card.editor.notSupported': '对不起，暂时不支持此种类型',
    'card.auth.title': '华秋 EDA（eda.cn）登录',
    'card.auth.desc': '工具「{tool}」需要登录华秋 EDA 账号才能继续。请在下方的登录框完成登录（或点击左侧「华秋EDA登录」按钮）；登录完成后，回复助手「已登录，请重试」，助手会自动重新调用该工具。',
    'card.auth.loggedIn': '✓ 已登录{nickname}—— 现在可以回复助手「已登录，请重试」，助手会重新调用工具。',
    'card.auth.loggedOut': '未登录 —— 请在上方登录华秋 EDA（eda.cn）账号，或点击左侧「华秋EDA登录」按钮；登录完成后让助手重试。',
    'card.auth.descHost': '工具「{tool}」需要登录华秋 EDA 账号才能继续。点击下方按钮后，EDA（KiCad）将弹出登录窗口，请在弹出的窗口中完成登录；登录完成后回复助手「已登录，请重试」，助手会自动重新调用该工具。',
    'card.auth.loginBtn': '登录华秋 EDA',
    // Rendered inside `{nickname}` by `card.auth.loggedIn`. The separator is
    // locale-specific punctuation: zh uses a full-width colon, en a half-width
    // one followed by a space. Hardcoding '：' made en read "：John".
    'card.nicknameSep': '：{nickname}',
    // ── dimension field labels ────────────────────────────────────────────
    'field.maxOf': '{field}（最大）',
    'field.minOf': '{field}（最小）',
    'field.width': '宽',
    'field.height': '高',
    'field.length': '长',
    'field.depth': '深度',
    'field.span': '跨距',
    'field.bodyWidth': '本体宽',
    'field.bodyLength': '本体长',
    'field.bodyHeight': '本体高',
    'field.boardWidth': '板宽',
    'field.boardHeight': '板高',
    'field.overallWidth': '总宽',
    'field.overallLength': '总长',
    'field.overallHeight': '总高',
    'field.pitch': '间距',
    'field.pitchX': 'X 向间距',
    'field.pitchY': 'Y 向间距',
    'field.leadPitch': '引脚间距',
    'field.padWidth': '焊盘宽',
    'field.padLength': '焊盘长',
    'field.padHeight': '焊盘高',
    'field.leadWidth': '引脚宽',
    'field.leadLength': '引脚长',
    'field.leadSpan': '引脚跨距',
    'field.pinCount': '引脚数',
    'field.rows': '行数',
    'field.columns': '列数',
    'field.standoff': '抬升高度',
  } as const

export type CopyKey = keyof typeof ZH

const EN: Record<CopyKey, string> = {
    'card.title.symbol': 'Generated symbol',
    'card.title.footprint': 'Generated footprint',
    'card.title.generic': 'Generated result',
    'card.kind.symbol': 'symbol',
    'card.kind.footprint': 'footprint',
    'card.kind.schematic': 'schematic',
    'card.kind.pcb': 'PCB',
    'card.status.generating': 'Generating…',
    'card.status.generated': 'Generated',
    'card.status.failed': 'Failed',
    'card.status.cancelled': 'Cancelled',
    'card.status.confirm': 'Confirm dimensions',
    'card.status.noPreview': 'Preview unavailable',
    'card.preview.loading': 'Loading preview…',
    'card.preview.renderError': 'Preview render failed: ',
    'card.preview.resolveError': 'Could not resolve artifact: ',
    'card.preview.missing': 'No previewable artifact content',
    'card.error.toolFailed': 'Tool call failed',
    'card.error.retry': 'Retry',
    'card.confirm.body': 'Confirm or correct these dimensions, then tell me to continue.',
    'card.note.noPreview': 'Preview unavailable; download the raw file instead.',
    'card.action.download': 'Download',
    'card.action.downloading': 'Downloading…',
    'card.action.place': 'Place in editor',
    'card.action.placing': 'Placing…',
    'card.place.done': 'Placed into the editor',
    'card.place.failed': 'Placement failed: ',
    'card.action.regenerate': 'Regenerate',
    'card.action.regenerating': 'Regenerating…',
    'card.action.inspect': 'Inspect',
    'card.action.regenerateFailed': 'Regenerate failed',
    'card.regeneratePrompt': 'Please regenerate the {kind} above',
    'card.meta.pkg': 'Package',
    'card.editor.unit': 'mm',
    'card.editor.hint': 'Confirm or adjust the dimensions below; the footprint is generated once you confirm.',
    'card.editor.dragHint': 'Drag the geometry or edit the values',
    'card.editor.confirm': 'Use these dimensions',
    'card.editor.cancel': 'Cancel',
    'card.editor.sent': 'Dimensions confirmed — continuing…',
    'card.editor.declined': 'Generation cancelled',
    'card.editor.invalid': 'Invalid value',
    'card.editor.pins': '{count} pins',
    'card.editor.body': 'Body',
    'card.editor.pitch': 'Pitch',
    'card.editor.edited': 'edited',
    'card.editor.ai': 'AI',
    'card.editor.advanced': 'Advanced dimensions',
    'card.editor.validationOk': '✓ Ready',
    'card.editor.validationIssue': '⚠ {n} issue(s)',
    'card.editor.issueOutOfRange': 'outside allowed range',
    'card.editor.issueMinGtMax': 'min is greater than max',
    'card.editor.svgHint': 'These are the package dimensions extracted from your image. Review and confirm them to continue.',
    'card.editor.notSupported': 'Sorry, this package type is not yet supported.',
    'card.auth.title': 'Huaqiu EDA (eda.cn) login',
    // The reply phrase was hardcoded to the Chinese "已登录，请重试" even in
    // this English string, telling an English-speaking user to type Chinese.
    'card.auth.desc': 'Tool "{tool}" requires a Huaqiu EDA login. Complete the login below (or use the 华秋EDA AI login button in the sidebar); then reply "I have logged in, please retry" so the assistant can retry the tool.',
    'card.auth.loggedIn': '✓ Logged in{nickname} — reply "I have logged in, please retry" and the assistant will retry.',
    'card.auth.loggedOut': 'Not logged in — complete the login above, or use the 华秋EDA AI sidebar button.',
    'card.auth.descHost': 'Tool "{tool}" requires a Huaqiu EDA account. Click the button below — EDA (KiCad) will open its login dialog. Complete the login there, then reply "I have logged in, please retry" so the assistant can retry the tool.',
    'card.auth.loginBtn': 'Sign in to Huaqiu EDA',
    'card.nicknameSep': ': {nickname}',
    'field.maxOf': '{field} (max)',
    'field.minOf': '{field} (min)',
    'field.width': 'Width',
    'field.height': 'Height',
    'field.length': 'Length',
    'field.depth': 'Depth',
    'field.span': 'Span',
    'field.bodyWidth': 'Body width',
    'field.bodyLength': 'Body length',
    'field.bodyHeight': 'Body height',
    'field.boardWidth': 'Board width',
    'field.boardHeight': 'Board height',
    'field.overallWidth': 'Overall width',
    'field.overallLength': 'Overall length',
    'field.overallHeight': 'Overall height',
    'field.pitch': 'Pitch',
    'field.pitchX': 'Pitch X',
    'field.pitchY': 'Pitch Y',
    'field.leadPitch': 'Lead pitch',
    'field.padWidth': 'Pad width',
    'field.padLength': 'Pad length',
    'field.padHeight': 'Pad height',
    'field.leadWidth': 'Lead width',
    'field.leadLength': 'Lead length',
    'field.leadSpan': 'Lead span',
    'field.pinCount': 'Pin count',
    'field.rows': 'Rows',
    'field.columns': 'Columns',
    'field.standoff': 'Standoff',
}

const COPY: Record<'zh' | 'en', Record<CopyKey, string>> = { zh: ZH, en: EN }

/** Every copy key, in declaration order (used to assert bilingual balance). */
export const COPY_KEYS = Object.keys(ZH) as CopyKey[]

/**
 * Canonical dimension key → i18n copy key.
 *
 * Keys are lowercased with separators stripped, so `body_width`, `bodyWidth`
 * and `Body Width` all resolve to `bodywidth`. Unknown keys fall back to
 * `humanizeKey()`, which is why this map only needs the common vocabulary —
 * the agent can emit arbitrary dimension names.
 */
export const FIELD_LABEL_KEY: Record<string, CopyKey> = {
  w: 'field.width',
  width: 'field.width',
  h: 'field.height',
  height: 'field.height',
  l: 'field.length',
  length: 'field.length',
  d: 'field.depth',
  depth: 'field.depth',
  e: 'field.span',
  span: 'field.span',
  bodywidth: 'field.bodyWidth',
  bodylength: 'field.bodyLength',
  bodyheight: 'field.bodyHeight',
  boardwidth: 'field.boardWidth',
  boardheight: 'field.boardHeight',
  overallwidth: 'field.overallWidth',
  overalllength: 'field.overallLength',
  overallheight: 'field.overallHeight',
  pitch: 'field.pitch',
  pitchx: 'field.pitchX',
  pitchy: 'field.pitchY',
  pitchd: 'field.pitch',
  pitche: 'field.pitch',
  leadpitch: 'field.leadPitch',
  padwidth: 'field.padWidth',
  padlength: 'field.padLength',
  padheight: 'field.padHeight',
  leadwidth: 'field.leadWidth',
  leadlength: 'field.leadLength',
  leadspan: 'field.leadSpan',
  pincount: 'field.pinCount',
  pins: 'field.pinCount',
  totalpins: 'field.pinCount',
  n: 'field.pinCount',
  nmax: 'field.pinCount',
  rows: 'field.rows',
  row: 'field.rows',
  columns: 'field.columns',
  column: 'field.columns',
  col: 'field.columns',
  cols: 'field.columns',
  standoff: 'field.standoff',
}

export type Translate = (key: string, params?: Record<string, unknown>) => string

export function translate(lang: 'zh' | 'en', key: string, params?: Record<string, unknown>): string {
  const dict = lang === 'en' ? COPY.en : COPY.zh
  let v = dict[key as CopyKey]
  // `EN` is typed against `ZH`, so a key cannot be missing at compile time.
  // This stays as a runtime net for keys built dynamically at a call site.
  if (v === undefined) v = COPY.zh[key as CopyKey]
  if (v === undefined) v = key
  if (params) {
    for (const k of Object.keys(params)) {
      v = v.split(`{${k}}`).join(String(params[k]))
    }
  }
  return v
}

/** Fallback translate used when the slot's locale `t` is unavailable. */
export const defaultT: Translate = (key, params) => translate('zh', key, params)

/**
 * Translate bound to the HOST UI language.
 *
 * The card used to hard-pin `const t = defaultT`, which silently froze every
 * string to zh and left the `en` dictionary above as dead code. `useT()`
 * follows the locale store in `theme.js` instead, so the card switches
 * language with the app.
 */
export function useT(): Translate {
  const lang = useLocale()
  return useCallback(
    (key: string, params?: Record<string, unknown>) => translate(lang, key, params),
    [lang],
  )
}

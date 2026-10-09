/**
 * Runtime locale pack for the schematic/system HIT card (zh + en), default zh.
 */
import { useCallback } from 'react'
import { useLocale } from './theme.js'

/**
 * Chinese is the source of truth: `CopyKey` is derived from it and `EN` is
 * typed against it, so a key added to `ZH` but missing from `EN` is a COMPILE
 * error instead of a silent Chinese fallback at runtime.
 */
const ZH = {
    'card.title.schematic': '生成原理图',
    'card.title.system': '生成系统设计',
    'card.kind.schematic': '原理图',
    'card.kind.system': '系统设计',
    'card.status.generating': '正在生成…',
    'card.status.generated': '已生成',
    'card.status.failed': '生成失败',
    // Live progress: one label per rung of the coarse stage ladder. The keys
    // match `STAGE_LADDERS` in src/progress.ts; a run can take 10+ minutes, so
    // these are what the user reads while waiting.
    'card.progress.waiting': '正在等待智能体开始…',
    'card.stage.requirement': '解析需求',
    'card.stage.architecture': '设计架构',
    'card.stage.circuit': '设计电路',
    'card.stage.report': '撰写报告',
    'card.stage.output': '导出图纸',
    'card.stage.plan': '制定方案',
    'card.stage.search': '检索器件',
    'card.stage.bom': '生成 BOM',
    'card.stage.modules': '设计模块',
    'card.stage.connect': '连接网络',
    'card.stage.erc': 'ERC 检查',
    'card.stage.export': '导出工程',
    'card.preview.loading': '正在加载预览…',
    'card.preview.renderError': '预览渲染失败：',
    'card.preview.resolveError': '无法解析工件：',
    'card.preview.missing': '没有可用于预览的工件内容',
    'card.error.toolFailed': '工具调用失败',
    'card.error.retry': '重试',
    'card.meta.design': '设计',
    'card.meta.sheets': '{count} 张图纸',
    'card.meta.modules': '{count} 个模块',
    'card.meta.connections': '{count} 条连接',
    'card.action.download': '下载',
    'card.action.downloading': '下载中…',
    'card.action.place': '放置到编辑器',
    'card.action.placing': '放置中…',
    'card.action.openInEda': '在 EDA 中打开',
    'card.action.openingInEda': '导入中…',
    'card.import.done': '已在 EDA 中打开设计（{id}）',
    'card.import.failed': '在 EDA 中打开失败：{detail}',
    'card.place.done': '已放置 {count} 个文件到编辑器',
    'card.place.partial': '已放置 {placed} 个，{failed} 个失败：',
    'card.place.failed': '放置失败：',
    'card.action.regenerate': '重新生成',
    'card.action.regenerating': '重新生成中…',
    'card.action.inspect': '详情',
    'card.regeneratePrompt.schematic': '请重新生成刚才的原理图',
    'card.regeneratePrompt.system': '请重新生成刚才的系统设计',
    'card.auth.title': '华秋 EDA AI（eda.cn）登录',
    'card.auth.desc': '工具「{tool}」需要登录华秋 EDA AI 账号才能继续。请在下方的登录框完成登录（或点击左侧「华秋EDA AI登录」按钮）；登录完成后，回复助手「已登录，请重试」，助手会自动重新调用该工具。',
    'card.auth.loggedIn': '✓ 已登录{nickname}—— 现在可以回复助手「已登录，请重试」，助手会重新调用工具。',
    'card.auth.loggedOut': '未登录 —— 请在上方登录华秋 EDA AI（eda.cn）账号，或点击左侧「华秋EDA AI 登录」按钮；登录完成后让助手重试。',
    'card.auth.descHost': '工具「{tool}」需要登录华秋 EDA AI 账号才能继续。点击下方按钮后，EDA（KiCad）将弹出登录窗口，请在弹出的窗口中完成登录；登录完成后回复助手「已登录，请重试」，助手会自动重新调用该工具。',
    'card.auth.loginBtn': '登录华秋 EDA AI',
    // Subscription gate (needs_subscription card).
    'card.subscription.title': '生成配额不足',
    'card.subscription.desc': '当前账号没有可用的 GEN 生成次数，设计未生成。',
    'card.subscription.package': '套餐：{name}',
    'card.subscription.quota': '可用次数：{count}',
    'card.subscription.subscribe': '订阅 / 升级',
    'card.subscription.afterSubscribe': '订阅或升级套餐后，回复助手「已订阅，请重试」，助手会重新生成。',
    // Substituted into `{nickname}` by `card.auth.loggedIn`. zh uses a
    // full-width colon, en a half-width one plus a space — hardcoding '：'
    // made the English card read "Logged in：John".
    'card.nicknameSep': '：{nickname}',
  } as const

export type CopyKey = keyof typeof ZH

const EN: Record<CopyKey, string> = {
    'card.title.schematic': 'Generated schematic',
    'card.title.system': 'Generated system design',
    'card.kind.schematic': 'schematic',
    'card.kind.system': 'system design',
    'card.status.generating': 'Generating…',
    'card.status.generated': 'Generated',
    'card.status.failed': 'Failed',
    'card.progress.waiting': 'Waiting for the agent to start…',
    'card.stage.requirement': 'Parsing requirement',
    'card.stage.architecture': 'Designing architecture',
    'card.stage.circuit': 'Designing circuit',
    'card.stage.report': 'Writing report',
    'card.stage.output': 'Exporting sheets',
    'card.stage.plan': 'Planning',
    'card.stage.search': 'Searching parts',
    'card.stage.bom': 'Building BOM',
    'card.stage.modules': 'Designing modules',
    'card.stage.connect': 'Connecting nets',
    'card.stage.erc': 'Running ERC',
    'card.stage.export': 'Exporting project',
    'card.preview.loading': 'Loading preview…',
    'card.preview.renderError': 'Preview render failed: ',
    'card.preview.resolveError': 'Could not resolve artifact: ',
    'card.preview.missing': 'No previewable artifact content',
    'card.error.toolFailed': 'Tool call failed',
    'card.error.retry': 'Retry',
    'card.meta.design': 'Design',
    'card.meta.sheets': '{count} sheet(s)',
    'card.meta.modules': '{count} module(s)',
    'card.meta.connections': '{count} connection(s)',
    'card.action.download': 'Download',
    'card.action.downloading': 'Downloading…',
    'card.action.place': 'Place in editor',
    'card.action.placing': 'Placing…',
    'card.action.openInEda': 'Open in EDA',
    'card.action.openingInEda': 'Importing…',
    'card.import.done': 'Design opened in EDA ({id})',
    'card.import.failed': 'Failed to open in EDA: {detail}',
    'card.place.done': 'Placed {count} file(s) into the editor',
    'card.place.partial': 'Placed {placed}, {failed} failed: ',
    'card.place.failed': 'Placement failed: ',
    'card.action.regenerate': 'Regenerate',
    'card.action.regenerating': 'Regenerating…',
    'card.action.inspect': 'Inspect',
    'card.regeneratePrompt.schematic': 'Please regenerate the schematic above',
    'card.regeneratePrompt.system': 'Please regenerate the system design above',
    'card.auth.title': 'Huaqiu EDA AI (eda.cn) login',
    // The reply phrase was hardcoded to the Chinese "已登录，请重试" even in
    // this English string, telling an English-speaking user to type Chinese.
    'card.auth.desc': 'Tool "{tool}" requires a Huaqiu EDA AI login. Complete the login below (or use the 华秋EDA AI sidebar button); then reply "I have logged in, please retry" so the assistant can retry the tool.',
    'card.auth.loggedIn': '✓ Logged in{nickname} — reply "I have logged in, please retry" and the assistant will retry.',
    'card.auth.loggedOut': 'Not logged in — complete the login above, or use the 华秋EDA AI sidebar button.',
    'card.auth.descHost': 'Tool "{tool}" requires a Huaqiu EDA AI account. Click the button below — EDA (KiCad) will open its login dialog. Complete the login there, then reply "I have logged in, please retry" so the assistant can retry the tool.',
    'card.auth.loginBtn': 'Sign in to Huaqiu EDA AI',
    // Subscription gate (needs_subscription card).
    'card.subscription.title': 'No generation quota',
    'card.subscription.desc': 'This account has no GEN generation quota left, so the design was not generated.',
    'card.subscription.package': 'Plan: {name}',
    'card.subscription.quota': 'Available: {count}',
    'card.subscription.subscribe': 'Subscribe / Upgrade',
    'card.subscription.afterSubscribe': 'After subscribing or upgrading, reply "I have subscribed, please retry" and the assistant will regenerate.',
    'card.nicknameSep': ': {nickname}',
}

const COPY: Record<'zh' | 'en', Record<CopyKey, string>> = { zh: ZH, en: EN }

/** Every copy key, in declaration order (used to assert bilingual balance). */
export const COPY_KEYS = Object.keys(ZH) as CopyKey[]

export type Translate = (key: string, params?: Record<string, unknown>) => string

export function translate(lang: 'zh' | 'en', key: string, params?: Record<string, unknown>): string {
  const dict = lang === 'en' ? COPY.en : COPY.zh
  let v = dict[key as CopyKey]
  if (v === undefined) v = COPY.zh[key as CopyKey]
  if (v === undefined) v = key
  if (params) {
    for (const k of Object.keys(params)) {
      v = v.split(`{${k}}`).join(String(params[k]))
    }
  }
  return v
}

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

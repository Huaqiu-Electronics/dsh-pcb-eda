/**
 * zh / en copy for every user-visible string of the auth UI (sidebar trigger,
 * account menu, login tool card).
 *
 * Kept self-contained rather than registered into DSH's `ctx.locale`
 * namespace — same call the sibling packages made
 * (`dsh-tool-symbol-footprint/src/client/i18n.ts`) — because the slot system
 * hands components props, not ctx, and a missing namespace would leave the UI
 * blank. `en` is typed as `Record<AuthCopyKey, string>`, so a key added to one
 * language without the other is a COMPILE error (bilingual balance enforced at
 * build time, mirroring DSH's own locale registry).
 *
 * The en「Go to profile」/「Log out」wording is the one the sidebar spec asks
 * for; the zh side follows `hq-eda-ai`'s `locales/cn.ts` (个人中心 / 退出登录).
 */
import { useMemo } from 'react'
import type { AuthLocale } from './lib.js'
import { useLocale } from './ui-env.js'

const zh = {
  'sidebar.login': '华秋EDA AI登录',
  'sidebar.loginTitle': '登录华秋 EDA AI（eda.cn）账号',
  'sidebar.accountTitle': '华秋 EDA AI 账号',
  'sidebar.account': '华秋EDA AI · 已登录',

  'menu.profile': '个人中心',
  'menu.logout': '退出登录',

  // Subscription quota + upgrade (sidebar account menu / HIT cards).
  'subscription.title': '订阅',
  'subscription.dialogTitle': '华秋 EDA 订阅',
  'subscription.gen': '系统设计（GEN）',
  'subscription.erc': '电路检查（ERC）',
  'subscription.package': '套餐：{name}',
  'subscription.quota': '可用次数：{count}',
  'subscription.quotaCount': '{used} / {total}次',
  'subscription.quotaPercent': '{percent}%',
  'subscription.noQuota': '无可用次数',
  'subscription.unsubscribed': '未订阅',
  'subscription.subscribe': '订阅 / 升级',
  'subscription.subscribing': '正在打开订阅…',
  'subscription.desc': '当前账号没有可用的 GEN 生成次数，请订阅或升级套餐后重试。',
  'subscription.hostUnavailable': '无法打开订阅页面（宿主未提供对话框服务）。',
  // Avatar popup (redesigned sidebar account menu).
  'subscription.quotaHeader': '套餐与使用额度',
  'subscription.upgrade': '订阅 / 升级套餐',
  'subscription.online': '在线',
  // AI usage — the third metric beside GEN and ERC. The headline is the
  // upstream `quotaRemainPercent`, passed through unchanged (`99.68%`).
  'subscription.ai': 'AI 用量',
  'subscription.aiUsagePercent': '{percent}%',
  'subscription.aiUsageUnknown': '暂无数据',
  // Turn-error quota CTA (rendered inside the Chat turn-error card when the
  // huaqiu gateway reports `insufficient_user_quota`).
  'turnError.aiQuotaCta': '升级获取更多 AI 额度',
  'turnError.aiQuotaSignIn': '登录后升级',
  'turnError.aiQuotaOpenFailed': '无法打开订阅页面，请稍后重试。',

  'card.title': '华秋 EDA AI（eda.cn）登录',
  'card.desc': '工具「{tool}」需要登录华秋 EDA AI 账号才能继续。请在下方的登录框完成登录（或点击左侧「华秋EDA AI登录」按钮）；登录完成后，回复助手「已登录，请重试」，助手会自动重新调用该工具。',
  'card.loggedIn': '✓ 已登录{nickname} —— 现在可以回复助手「已登录，请重试」，助手会重新调用工具。',
  'card.loggedOut': '未登录 —— 请在上方登录华秋 EDA AI（eda.cn）账号，或点击左侧「华秋EDA AI登录」按钮；登录完成后让助手重试。',
  'card.tool': '工具：{tool}',
  'card.empty': '(无输出)',
  // Substituted into `{nickname}` by `card.loggedIn`. zh uses a full-width
  // colon, en a half-width one plus a space; hardcoding '：' made the English
  // card read "Logged in：John".
  'card.nicknameSep': '：{nickname}',

  'dialog.close': '关闭',

  // Embedded-host launch onboarding wizard (shell.overlay). Shown only when
  // hq-edge launched this dsh and no Huaqiu account is signed in.
  'onboarding.badge': '快速开始',
  'onboarding.hostLabel': '华秋 DSH 版',
  'onboarding.title': '解锁开箱即用的 AI 能力',
  'onboarding.desc': '登录华秋账号即可直接使用内置电子设计 AI，无需手工配置 API Key 或模型。',
  'onboarding.featureModelsTitle': '零配置内置模型',
  'onboarding.featureModelsDesc': '开箱即用 auto-model 与华秋调优的 EDA 智能体。',
  'onboarding.featurePartsTitle': '器件、BOM 与供应链情报',
  'onboarding.featurePartsDesc': '在工作区内直接查询华秋器件库、数据手册与 DFM 检查。',
  'onboarding.featureFlowTitle': '从想法到可制造 PCB',
  'onboarding.featureFlowDesc': '从概念、原理图到布局、DFM 检查与一站式 PCB 制造。',
  'onboarding.login': '使用华秋账号登录',
  'onboarding.loginBusy': '正在打开登录窗口…',
  'onboarding.skip': '暂时跳过',
  'onboarding.dontShow': '本次启动不再提示',
  'onboarding.createAccount': '注册新账号',
  'onboarding.error': '无法打开华秋登录窗口，请重试。',
} as const

/** Every key of the zh dictionary — the contract both languages satisfy. */
export type AuthCopyKey = keyof typeof zh

const en: Record<AuthCopyKey, string> = {
  'sidebar.login': 'Huaqiu EDA AI login',
  'sidebar.loginTitle': 'Sign in to your Huaqiu EDA AI (eda.cn) account',
  'sidebar.accountTitle': 'Huaqiu EDA AI account',
  'sidebar.account': 'Huaqiu EDA AI · signed in',

  'menu.profile': 'Go to profile',
  'menu.logout': 'Log out',

  'subscription.title': 'Subscription',
  'subscription.dialogTitle': 'Huaqiu EDA subscription',
  'subscription.gen': 'System design (GEN)',
  'subscription.erc': 'Circuit check (ERC)',
  'subscription.package': 'Plan: {name}',
  'subscription.quota': 'Available: {count}',
  'subscription.quotaCount': '{used} / {total}',
  'subscription.quotaPercent': '{percent}%',
  'subscription.noQuota': 'No quota left',
  'subscription.unsubscribed': 'Not subscribed',
  'subscription.subscribe': 'Subscribe / Upgrade',
  'subscription.subscribing': 'Opening subscription…',
  'subscription.desc': 'This account has no GEN generation quota left. Subscribe or upgrade to continue.',
  'subscription.hostUnavailable': 'Cannot open the subscription page (the host provides no dialog service).',
  // Avatar popup (redesigned sidebar account menu).
  'subscription.quotaHeader': 'Plan & usage quota',
  'subscription.upgrade': 'Subscribe / Upgrade plan',
  'subscription.online': 'Online',
  // AI usage — the third metric beside GEN and ERC. The headline is the
  // upstream `quotaRemainPercent`, passed through unchanged (`99.68%`).
  'subscription.ai': 'AI usage',
  'subscription.aiUsagePercent': '{percent}%',
  'subscription.aiUsageUnknown': 'No data',
  // Turn-error quota CTA (rendered inside the Chat turn-error card when the
  // huaqiu gateway reports `insufficient_user_quota`).
  'turnError.aiQuotaCta': 'Upgrade for more AI tokens',
  'turnError.aiQuotaSignIn': 'Sign in to upgrade',
  'turnError.aiQuotaOpenFailed': 'Could not open the subscription page. Please try again later.',

  'card.title': 'Huaqiu EDA AI (eda.cn) login',
  // The reply phrase used to be hardcoded to the Chinese "已登录，请重试" even
  // in these English strings, telling an English-speaking user to type Chinese.
  'card.desc': 'Tool "{tool}" needs a Huaqiu EDA AI account. Complete the login below (or use the Huaqiu EDA AI button in the sidebar), then reply "I have logged in, please retry" so the assistant can retry the tool.',
  'card.loggedIn': '✓ Logged in{nickname} — reply "I have logged in, please retry" and the assistant will retry the tool.',
  'card.loggedOut': 'Not logged in — sign in above, or use the Huaqiu EDA AI button in the sidebar, then ask the assistant to retry.',
  'card.tool': 'Tool: {tool}',
  'card.empty': '(no output)',
  'card.nicknameSep': ': {nickname}',

  'dialog.close': 'Close',

  // Embedded-host launch onboarding wizard (shell.overlay).
  'onboarding.badge': 'Quick Setup',
  'onboarding.hostLabel': 'Huaqiu DSH Edition',
  'onboarding.title': 'Unlock Out-of-the-Box AI Capabilities',
  'onboarding.desc': 'Sign in with your Huaqiu account to activate built-in Electronic Design AI right away — no manual API keys or model configuration required.',
  'onboarding.featureModelsTitle': 'Zero-Config Built-in AI Models',
  'onboarding.featureModelsDesc': 'Instant access to auto-model and Huaqiu-tuned EDA agents out of the box.',
  'onboarding.featurePartsTitle': 'Component, BOM & Supply Chain Intelligence',
  'onboarding.featurePartsDesc': 'Query Huaqiu part libraries, datasheets and DFM checks inside your workspace.',
  'onboarding.featureFlowTitle': 'End-to-End: Idea to Producible PCB',
  'onboarding.featureFlowDesc': 'Go from concept and schematic capture to layout, DFM checks and turnkey PCB manufacturing.',
  'onboarding.login': 'Login with Huaqiu Account',
  'onboarding.loginBusy': 'Opening Huaqiu sign-in…',
  'onboarding.skip': 'Skip for now',
  'onboarding.dontShow': "Don't show this again this launch",
  'onboarding.createAccount': 'Create account',
  'onboarding.error': 'Could not open the Huaqiu sign-in dialog. Please try again.',
}

const COPY: Record<AuthLocale, Record<AuthCopyKey, string>> = { zh, en }

/** Every copy key, in declaration order (used to assert bilingual balance). */
export const AUTH_COPY_KEYS = Object.keys(zh) as AuthCopyKey[]

export type Translate = (key: AuthCopyKey, params?: Record<string, unknown>) => string

/**
 * Look a key up, interpolating `{name}` placeholders.
 *
 * Chain: active locale → zh (the source of truth) → the key itself, so a
 * missing translation stays VISIBLE instead of blanking the UI.
 */
export function translate(locale: AuthLocale, key: AuthCopyKey, params?: Record<string, unknown>): string {
  const template = COPY[locale]?.[key] ?? COPY.zh[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

/** Translate bound to one locale (stable for the lifetime of that locale). */
export function createT(locale: AuthLocale): Translate {
  return (key, params) => translate(locale, key, params)
}

/** Translate bound to the host UI language, re-created when it changes. */
export function useT(): Translate {
  const locale = useLocale()
  return useMemo(() => createT(locale), [locale])
}

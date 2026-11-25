/**
 * zh_CN copy for every user-visible string of the Hardware Engineering product
 * UI (browser half).
 *
 * Why one module instead of strings at the call sites: the same sentence is
 * rendered from up to three seats (navigation row, viewer body, settings
 * section), and a literal that drifts between them reads as two different
 * products. One dictionary also makes "is this text translated?" a mechanical
 * question — grep for a Chinese character outside this file and the answer is
 * no.
 *
 * Why not DSH's own locale service: `ctx.locale.register(ns, { zh, en })` plus a
 * `locale: 'ns'` slot registration would put a typed, reactive `t` seat on the
 * component props, and it is the right answer for a bilingual plugin. It cannot
 * express zh-only: the typed overload takes
 * `Record<BuiltInLocaleId, LocaleDictOf<N>>` — both baseline locales are
 * required — and the untyped single-locale arm leaves an en-active host falling
 * back to the raw key (`FALLBACK_LOCALE = 'en'`, and a namespace registered only
 * for `zh` is not in `en`'s chain). The sibling packages hit the same wall and
 * self-contained for the same reason (`dsh-auth/src/client/i18n.ts`,
 * `dsh-tool-plugin-update/src/client/copy.ts`).
 *
 * Why one module instead of strings at the call sites: the same sentence is
 * rendered from up to three seats (navigation row, viewer body, settings
 * section), and a literal that drifts between them reads as two different
 * products. One dictionary also makes "is this text translated?" a mechanical
 * question — grep for a Chinese character outside this file and the answer is
 * no.
 *
 * Adding a language later is mechanical: turn `COPY` into `{ zh, en }` with
 * `en: Record<CopyKeys, string>` (the `dsh-auth` shape, so a missing key is a
 * COMPILE error), pick by `<html lang>`, and — if the second language is real —
 * move the dictionary into `ctx.locale.register` and declare `locale:` on the
 * slots to get the framework's reactive `t` seat instead. Nothing that renders
 * would move, because every render site already reads through this module.
 *
 * Wording rules that hold across the file:
 *   - Commands, file names, extension names, and host paths are NOT translated
 *     (`kicad-cli`, `.kicad_pcb`, `Settings → Hardware Engineering` becomes
 *     「设置 → 硬件工程」 only because the host section label is translated too).
 *   - Host-origin text is never re-spelled here: {@link describeHostError} maps
 *     a stable host `code` to a sentence and appends the host detail where it
 *     is technical output (kicad-cli stderr) rather than prose.
 *   - Interpolation is a function, not `{placeholder}` templates: a function
 *     cannot be rendered with its placeholders unfilled by accident.
 *
 * @module
 */

/** The only locale this bundle ships. See the module note above. */
export const LOCALE = 'zh_CN' as const

export const COPY = {
  /** Product name — tab title, settings section label, wizard title. */
  product: {
    name: '硬件工程',
  },

  /** The five persistent destinations, in `DESTINATIONS` order. */
  destinations: {
    schematic: '原理图',
    pcb: 'PCB',
    bom: 'BOM',
    '3d': '3D 模型',
    order: '下单',
  },

  /** Navigation row + viewer strip. */
  viewer: {
    discoveryFailed: (detail: string) => `产物扫描失败：${detail}`,
    installationFailed: (detail: string) => `安装检查失败：${detail}`,
    noArtifact: '未选择产物',
    kicadMissing: '未找到 KiCad',
    kicadVersion: (version: string) => `KiCad ${version}`,
    openInKicad: '用 KiCad 打开',
    openInKicadTitle: (path: string) => `在 KiCad 中打开 ${path}`,
    selectArtifactFirst: '请先选择一个产物',
    configureKicad: '请在「设置 → 硬件工程」中配置 KiCad',
    selectProject: '选择工程…',
    // aria labels / titles (screen-reader text is visible text too)
    projectField: '工程',
    schematicSheetField: '原理图页',
    boardField: '板文件',
  },

  /**
   * Empty viewers. A placeholder names what is missing and then says how to get
   * it: the agent creates hardware, so the copy points there instead of stopping
   * at "not available". BOM is the one destination nobody creates directly — it
   * follows the schematic.
   */
  placeholder: {
    title: {
      schematic: '暂无原理图',
      pcb: '暂无 PCB',
      bom: '暂无 BOM',
      '3d': '暂无 3D 模型',
      order: '暂无可下单的板',
    },
    /** One sentence: what the agent can create for this destination. */
    guide: {
      schematic: '可以让智能体在当前工程中创建原理图（.kicad_sch），创建后会直接在这里显示。',
      pcb: '可以让智能体创建 PCB 并完成布局（.kicad_pcb），保存后会直接在这里显示。',
      bom: 'BOM 由原理图自动生成：让智能体先创建原理图，BOM 会自动更新。',
      '3d': '3D 模型由 PCB 生成：让智能体创建 PCB 后，这里会自动出现三维预览。',
      order: '制板与贴片都需要 PCB：让智能体创建 PCB 后即可在这里报价下单。',
    },
    /** Shown instead of a destination guide when no project was discovered. */
    noProject: '可以让智能体在当前工作区创建 KiCad 工程（.kicad_pro），工程出现后这里会自动刷新。',
    /** The ask, phrased so the user can paste it into the conversation. */
    askAgent: '对智能体说：「为当前工程创建原理图」/「创建 PCB」/「导出 3D 模型」即可。',
  },

  /**
   * Discovery outcomes. These are the panel's OWN sentences for a host state —
   * the host also sends a `message`, but re-deriving it here keeps the copy in
   * one place and lets the count/cwd be woven in. {@link issueText} bridges the
   * two: known codes get translated, unknown ones fall back to the host text.
   */
  discovery: {
    selectionRequiredCount: (count: number) => `发现 ${count} 个硬件工程，请明确选择一个。`,
    selectionRequiredArtifact: '该工程包含多个可选产物，请明确选择一个。',
    noProjectSelected: '尚未选择硬件工程。请打开或选择一个硬件工程。',
    noSchematic: '该工程没有可用的根原理图。',
    noBoard: '该工程没有可用的 .kicad_pcb 板文件。',
    noBoardToOrder: '请先选择板文件，再报价或下单制板。',
    // Host `issue.code` vocabulary.
    noProject: (cwd: string) => (cwd === '' ? '未找到 .kicad_pro 工程文件' : `${cwd} 下未找到 .kicad_pro 工程文件`),
    missingProject: (path: string) => `工程文件不存在：${path}`,
    badManifest: (detail: string) => `配置文件 .hardware-engineering.json 无效：${detail}`,
  },

  /** schematic / pcb / 3d / bom stages. */
  preview: {
    loading: '正在加载已保存的产物…',
    kindSchematic: '原理图',
    kindBoard: 'PCB',
    revision: (revision: string) => `版本 ${revision}`,
    ecadHint: '仅预览已保存的文件；文件必须存在且可解析。',
    ecadKindMismatch: (expected: string, actual: string) =>
      `宿主返回的产物类型（${actual}）与预览类型（${expected}）不一致。`,
    ecadOverlay: '已保存文件 · 滚轮缩放，拖拽平移',
    kicadNotConfigured: 'KiCad 尚未配置。',
    glbExporting: '正在用 kicad-cli 导出 PCB 的 GLB…',
    glbLoading: '正在加载 3D 模型…',
    glbCached: '缓存',
    glbGenerated: '已生成',
    glbOverlay: '拖拽旋转 · 滚轮缩放',
    bomHint: 'BOM 行来自 kicad-cli sch export bom。请在「设置 → 硬件工程」中配置 KiCad。',
    bomTitle: (lines: number) => `物料清单 · ${String(lines)} 行`,
    bomPlacements: (count: number) => `${String(count)} 个元件位`,
    bomColumns: ['位号', '数量', '值', '封装', '备注'] as const,
  },

  /** Order Placing destination. */
  order: {
    title: '制板与贴片',
    packaging: '打包中…',
    packageReady: '打包完成',
    packagePending: '尚未打包',
    packageRunning: '正在运行 kicad-cli 导出 Gerber 与钻孔…',
    packageNotPrepared: '尚未打包。',
    packageCard: '制板文件包',
    packageFiles: (files: number, size: string) => `${String(files)} 个文件 · ${size}`,

    pcbTitle: '裸板制板',
    pcbSubtitle: '通过华秋制板服务对选中的板文件报价并下单。',
    pcbSummary: (zip: string, files: number, size: string) =>
      `${zip} · ${String(files)} 个 Gerber/钻孔文件 · ${size}`,
    pcbAction: '提交 PCB 订单',

    smtTitle: '整包贴片',
    smtSubtitle: '需要工程根原理图以生成 BOM 与元件坐标。',
    smtSummary: (placements: number, lines: number, size: string) =>
      `${String(placements)} 个贴片点位 · ${String(lines)} 行 BOM · ${size}`,
    smtAction: '提交贴片订单',

    boardFile: '板文件',
    placements: '贴片点位',
    bomLines: 'BOM 行数',
    credential: '登录凭据',
    signedIn: '华秋登录',
    signedOut: '未登录',

    signInToOrder: '请先登录华秋账号再下单——订单页将以你的账号打开。',
    signInToOrderSmt: '请先登录华秋账号再下单贴片——订单页将以你的账号打开。',
    waitingForPackage: '正在等待制板文件包。',
    configureToPackage: '请配置 KiCad 以打包板文件。',
    selectRootSchematic: '请选择根原理图，以便生成 BOM 与坐标。',

    // Board facts (values keep their units, which are not prose).
    layers: '层数',
    layersValue: (layers: number) => `${String(layers)} 层`,
    outline: '外形尺寸',
    thickness: '板厚',
    minTrace: '最小线宽',
    minDrill: '最小钻孔',
    outerCopper: '外层铜厚',
    defaultValue: '默认',
    copperValue: (oz: number | string) => `${String(oz)} oz`,

    agentEntryPoints: 'Agent 入口',
    submitting: '提交中…',

    tabTitle: '华秋订单',
    tabOrder: (id: string) => `订单 ${id}`,
    tabMissing: '没有可显示的订单页。',
    tabAddressHint: '订单页在本页签中打开；链接包含你的登录凭据，因此只显示订单号。',
    openInSystemBrowser: '在系统浏览器打开',

    resultTitlePcb: 'PCB 订单已创建',
    resultTitleSmt: '贴片订单已创建',
    resultLaunched: '已在右侧面板打开',
    resultReady: '待打开',
    resultNote: '与 KiCad 在下单窗口中展示的是同一个页面，已在本页右侧的浏览器页签中打开。',
    resultLaunchedMessage: (kind: string) => `已在右侧面板的浏览器页签中打开「${kind}」订单页。`,
    resultReadyMessage: (kind: string) => `「${kind}」订单页已就绪，点击「在右侧面板打开」即可继续。`,
    openInBrowser: '在右侧面板打开',
    opening: '正在打开…',
    copyUrl: '复制链接',
    copied: '已复制',

    confirmAria: '确认下单上传',
    confirmTitlePcb: '上传板文件并创建 PCB 订单？',
    confirmTitleSmt: '上传贴片文件包？',
    confirmBody: '以下文件将发送到华秋下单服务。订单在那里创建，其页面会在右侧面板中打开；付款仍在该页面完成。',
    confirmZip: (zip: string, size: string) => `${zip} — Gerber 与钻孔文件（${size}）`,
    confirmPositions: (size: string) => `元件坐标（${size}）`,
    confirmBom: (size: string) => `贴片 BOM（${size}）`,
    confirmHost: (baseUrl: string | undefined) => baseUrl ?? '已配置的下单服务',
    confirmAck: '我了解这些板文件将离开本机。',
    cancel: '取消',
    uploadAndOpen: '上传并打开订单页',
    uploading: '正在上传…',

    batch: '生产数量',
    batchUnits: (count: number) => `${String(count)} 片`,
    quoteBasis: (count: number) => `报价基准 · ${String(count)} 片`,
  },

  /** First-run setup wizard. */
  wizard: {
    steps: ['欢迎', 'KiCad', 'SolidCraft'] as const,
    stepCounter: (index: number, total: number, label: string) =>
      `${String(index)}/${String(total)} · ${label}`,
    aria: '硬件工程初始化',

    welcomeTitle: '配置你的硬件工具链',
    welcomeKicker: '仅需一次 · 可跳过',
    welcomeLead: '硬件工程可预览 KiCad 工程、导出 PCB 三维模型、打包制板文件并调用本地程序打开文件。只需指定一次本地安装位置。',
    welcomeUsesTitle: '使用到的组件',
    welcomeUses: 'kicad-cli 负责预览、BOM、GLB 与 Gerber/钻孔打包。SolidCraft 仅作为环境上下文提供给 Agent。',
    welcomeLocal: '只使用本机的可执行文件。不会上传任何内容，也不会替你安装任何东西。',

    kicadTitle: 'KiCad 安装位置',
    kicadOptional: '可选',
    kicadLead: '填写 KiCad 安装目录或 kicad-cli 路径。它用于 .kicad_sch / .kicad_pcb 预览、PCB 的 GLB 导出、制板文件打包，以及「用 KiCad 打开」。',
    kicadPlaceholder: 'C:\\Program Files\\KiCad\\8.0\\  或  /usr/bin/kicad-cli',
    kicadSkipHint: '留空即跳过。之后可在「设置 → 硬件工程」中配置。',

    solidcraftTitle: 'SolidCraft 安装位置',
    solidcraftLead: '本 POC 中 SolidCraft 仅作为环境上下文提供给 Agent——不启动本地程序，也不做结构预览。',
    solidcraftPlaceholder: 'C:\\Program Files\\SolidCraft\\bin\\SolidCraft.exe',

    skip: '跳过设置',
    back: '上一步',
    next: '下一步',
    finish: '完成',
    saving: '保存中…',
    footerNote: '随时可在「设置 → 硬件工程」中修改。',
  },

  /** Settings section (the two CAD installation roots). */
  settings: {
    title: '硬件工程',
    lead: '用于预览、制板打包、一键调用本地程序以及 Agent 环境上下文的本地 EDA / MCAD 可执行文件。',
    kicadTitle: 'KiCad EDA 套件',
    kicadBlurb: '可填 KiCad 安装目录或 kicad-cli 路径。用于 .kicad_sch / .kicad_pcb 预览、GLB 导出、BOM、Gerber 打包与本地打开。',
    kicadPlaceholder: 'C:\\Program Files\\KiCad\\8.0\\  或  /usr/bin/kicad-cli',
    solidcraftTitle: 'SolidCraft 三维 CAD',
    solidcraftBlurb: '本 POC 中仅用于 Agent 环境上下文。不启动本地程序，也不做结构预览；「3D 模型」页签渲染的是所选 PCB。',
    solidcraftPlaceholder: 'C:\\Program Files\\SolidCraft\\bin\\SolidCraft.exe',
    pathField: (title: string) => `${title}路径`,
    validate: '校验并保存',
    validating: '校验中…',
    configured: '已配置',
    notConfigured: '未配置',
    notDetected: '未检测到',
    savedAndValidated: (application: string) => `${application} 校验通过并已保存。`,
    savedButInvalid: (application: string, detail: string) => `${application} 已保存，但校验失败：${detail}`,
    hostSettingsUnavailable: '宿主未提供设置服务，无法保存。',
    hostRejected: (application: string) => `宿主拒绝了${application}的设置。`,
  },

  /**
   * Host error sentences, keyed by the stable `code` in the route envelope
   * (`packages/hardware-artifacts/src/routes.ts`). A code missing here is not a
   * bug in the UI: the host detail is then shown verbatim, which is the right
   * answer for an unmodelled failure.
   */
  errors: {
    unauthorized: '没有权限访问该产物：它不在当前会话的工作区授权范围内。',
    forbidden: '没有权限执行该操作。',
    'missing-artifact': '该产物不存在。',
    'unsupported-artifact': '不支持该产物类型。',
    'invalid-identity': '产物路径无效。',
    'missing-executable': '已配置的 KiCad 中没有可打开该产物的程序。',
    'not-configured': '尚未配置 KiCad。请在「设置 → 硬件工程」中填写安装位置。',
    'too-large': '产物超过可预览的大小上限。',
    'export-timeout': 'kicad-cli 执行超时。',
    'export-failed': 'kicad-cli 导出失败。',
    'stale-revision': '文件已变化，请刷新后重试。',
    'invalid-request': '请求参数不完整。',
    'invalid-application': '不支持该本地程序。',
    'confirmation-required': '下单需要先在上传确认框中确认。',
    'invalid-order-url': '订单链接无效，已拒绝打开。',
    'order-unreachable': '无法连接下单服务。',
    'order-rejected': '下单服务未能返回可用的订单页。',
    'not-found': '未找到该接口。',
    internal: '服务内部错误。',
  },
} as const

export type HardwareCopy = typeof COPY

/**
 * Codes whose host detail is a technical tail worth keeping next to the
 * translated sentence: kicad-cli stderr, an HTTP failure, a backend payload.
 * For the rest the detail merely restates the sentence in English.
 */
const KEEPS_DETAIL = new Set([
  'export-failed',
  'order-unreachable',
  'order-rejected',
  'invalid-order-url',
  'internal',
])

/**
 * One host error → one zh_CN sentence.
 *
 * `detail` is the host's own message. Unknown codes keep it untouched, so an
 * unmodelled failure still says something specific instead of collapsing into
 * a generic "出错了".
 */
export function describeHostError(code: string | undefined, detail: string): string {
  if (code === undefined) return detail
  const sentence = (COPY.errors as Record<string, string | undefined>)[code]
  if (sentence === undefined) return detail
  return KEEPS_DETAIL.has(code) && detail !== '' ? `${sentence}（${detail}）` : sentence
}

/**
 * Translate one discovery `issue` without losing the host's specifics.
 *
 * The count and the workspace come from the discovery result, not from the
 * host sentence, so the wording does not depend on how the host phrased it.
 */
export function issueText(
  issue: { readonly code: string; readonly message: string },
  context: { readonly cwd?: string; readonly count?: number } = {},
): string {
  switch (issue.code) {
    case 'selection-required':
      return context.count !== undefined && context.count > 1
        ? COPY.discovery.selectionRequiredCount(context.count)
        : COPY.discovery.selectionRequiredArtifact
    case 'no-project':
      return COPY.discovery.noProject(context.cwd ?? '')
    case 'missing-project':
      // Host text is `${path} does not exist`; the path is the useful half.
      return COPY.discovery.missingProject(issue.message.replace(/\s+does not exist\s*$/u, ''))
    case 'bad-manifest':
      return COPY.discovery.badManifest(issue.message.replace(/^invalid \.hardware-engineering\.json:\s*/u, ''))
    default:
      return issue.message
  }
}

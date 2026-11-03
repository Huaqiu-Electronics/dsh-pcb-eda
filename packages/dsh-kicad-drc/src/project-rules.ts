/**
 * 工程规则注入：把 `.kicad_pro` 的板级 DRC 约束翻成 `.kicad_dru` 规则，
 * 通过 pcblint 的会话规则接口（`GET/PUT /api/s/dru`）写进去，让远端检查使用
 * 工程自己的阈值，而不是服务端默认工程的 KiCad 默认值。
 *
 * 为什么需要：pcblint 只接收单个 `.kicad_pcb`，工程级 `.kicad_pro` 传不过去，
 * 服务端用它自己的默认工程跑 kicad-cli，板级约束（最小线宽/过孔/孔环/间距…）
 * 全部退回 KiCad 默认值——于是 0.102mm 的正常走线被按 0.2mm 判成 ERROR。
 *
 * 只注入**板级**约束（`board.design_settings.rules`），并且只注入实测不改变
 * 检查项语义的 8 类；`min_silk_clearance` / `min_text_*` / `min_microvia_*`
 * 故意不注入，原因见 `SKIPPED_KEYS`。
 *
 * 实测（board-1，带 `.kicad_pro` 的完整板，同一会话）：
 *   注入前 1139 条（track_width 199 / annular_width 122 / via_diameter 122 / clearance 499）
 *   注入后  126 条，且 copper_edge 4 / lib_footprint 59 / padstack 2 / starved_thermal 6
 *   与本地 kicad-cli 读同一份 `.kicad_pro` 的结果一致。
 *
 * @module
 */

/** 注入块的起始标记：重复注入时据此先剥掉上一次的内容，保证幂等。 */
export const PROJECT_RULES_MARKER = '# >>> dsh-kicad-drc: project rules injected from .kicad_pro >>>'

/** 工程自带 `.kicad_dru` 的注入标记，独立于板级约束块，便于分别剥离。 */
export const PROJECT_DRU_MARKER = '# >>> dsh-kicad-drc: rules from project .kicad_dru >>>'

/** `.kicad_pro` 的 rules 键 → KiCad 自定义规则约束名（顺序即生成顺序）。 */
const BOARD_CONSTRAINTS: ReadonlyArray<readonly [constraint: string, key: string]> = [
  ['clearance', 'min_clearance'],
  ['track_width', 'min_track_width'],
  ['via_diameter', 'min_via_diameter'],
  ['annular_width', 'min_via_annular_width'],
  ['hole_size', 'min_through_hole_diameter'],
  ['hole_clearance', 'min_hole_clearance'],
  ['hole_to_hole', 'min_hole_to_hole'],
  ['edge_clearance', 'min_copper_edge_clearance'],
]

/**
 * 明确不注入的键及原因。
 *
 * `min_silk_clearance` 最典型：板级设置与自定义规则的语义不同，注入后
 * silk_overlap 从 13 涨到 199，而本地 kicad-cli 读同一工程只有 126 条——
 * 属于凭空放大，宁可保留服务端默认。
 */
const SKIPPED_KEYS: Record<string, string> = {
  min_silk_clearance: '自定义 silk_clearance 规则与板级设置语义不一致，注入会放大 silk 违规',
  min_text_height: '未验证与板级 text 约束等价，注入可能改变检查项本身',
  min_text_thickness: '未验证与板级 text 约束等价，注入可能改变检查项本身',
  min_microvia_diameter: '微孔约束不适用于普通过孔，全局注入会放宽既有检查',
  min_microvia_drill: '微孔约束不适用于普通过孔，全局注入会放宽既有检查',
}

/** 一条实际生效的约束。 */
export interface AppliedProjectRule {
  /** KiCad 约束名，如 `track_width`。 */
  constraint: string
  /** 阈值（毫米）。 */
  mm: number
  /** 网络类名；缺省表示这是板级（无条件）规则。 */
  netclass?: string
  /** 该网络类在板上实际命中的网络名（决定条件表达式怎么写）。 */
  nets?: string[]
}

/** 一条被跳过的规则键及原因。 */
export interface SkippedProjectRule {
  key: string
  reason: string
}

/** 解析结果：既有可注入内容，也有跳过说明，便于在结果里如实标注。 */
export interface ProjectRuleSet {
  /** 来源文件名（`.kicad_pro`）。 */
  source: string
  applied: AppliedProjectRule[]
  skipped: SkippedProjectRule[]
  /** 追加到 `.kicad_dru` 末尾的规则块（含 marker）；无可注入内容时为空串。 */
  block: string
}

/** 数字转 mm 字面量：0.0505 → `0.0505mm`，避免科学计数法。 */
function mm(value: number): string {
  return `${Number(value.toFixed(6))}mm`
}

/** 规则名只保留 KiCad 能接受的安全字符（类名来自用户工程）。 */
function sanitizeRuleName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/gu, '_')
}

/** 条件表达式里的单引号字符串需要转义，否则类名带引号会破坏语法。 */
function escapeCondition(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")
}

/**
 * 去掉工程 `.kicad_dru` 开头的 `(version N)`。
 *
 * 会话规则文件本身已有版本声明，把工程文件整段追加进去会出现第二个
 * `(version …)`，KiCad 解析会失败。
 */
function stripDruVersion(text: string): string {
  return text.replace(/^\s*\(version\s+\d+\)\s*/u, '')
}

/** 网络类模式：KiCad 里 `*` / `?` 是通配符，其余按字面量。 */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*/gu, '.*')
    .replace(/\?/gu, '.')
  return new RegExp(`^${escaped}$`, 'u')
}

/**
 * 解析网络类的成员网络。
 *
 * 顺序与 KiCad 一致：`netclass_assignments` 的显式指派优先，剩下的按
 * `netclass_patterns` 的通配符匹配；都没有的网络属于 Default。
 */
export function resolveNetClassMembers(
  netSettings: { classes?: unknown; netclass_assignments?: unknown; netclass_patterns?: unknown },
  netNames: readonly string[],
): Map<string, string[]> {
  const assigned = new Map<string, string>()
  const assignments = netSettings.netclass_assignments
  if (assignments && typeof assignments === 'object' && !Array.isArray(assignments)) {
    for (const [net, cls] of Object.entries(assignments as Record<string, unknown>)) {
      if (typeof cls === 'string' && cls) assigned.set(net, cls)
    }
  }

  const patterns = Array.isArray(netSettings.netclass_patterns)
    ? netSettings.netclass_patterns.filter(
        (row): row is { netclass: string; pattern: string } =>
          !!row &&
          typeof row === 'object' &&
          typeof (row as { netclass?: unknown }).netclass === 'string' &&
          typeof (row as { pattern?: unknown }).pattern === 'string',
      )
    : []
  for (const { netclass, pattern } of patterns) {
    const matcher = patternToRegExp(pattern)
    for (const net of netNames) {
      if (assigned.has(net)) continue
      if (matcher.test(net)) assigned.set(net, netclass)
    }
  }

  const byClass = new Map<string, string[]>()
  for (const [net, cls] of assigned) {
    const list = byClass.get(cls) ?? []
    list.push(net)
    byClass.set(cls, list)
  }
  for (const list of byClass.values()) list.sort()
  return byClass
}

/**
 * 条件表达式要按**网络名**写，不能按类名。
 *
 * 远端 pcblint 用自己那一份默认工程跑检查，那里没有本工程的网络类，
 * `A.NetClass == 'Power'` 永远不成立——实测注入后仍是 126 条（本地原生 720）。
 * 换成网络名条件后逐项一致（720 / clearance 499）。
 */
function netNameCondition(nets: readonly string[]): string {
  const clauses: string[] = []
  for (const net of nets) {
    const literal = escapeCondition(net)
    clauses.push(`A.NetName == '${literal}'`, `B.NetName == '${literal}'`)
  }
  return clauses.join(' || ')
}

/**
 * 从 `.kicad_pro` 文本生成可注入的规则块。
 *
 * @throws 当文本不是合法 JSON 时抛出，由调用方降级为"不注入"。
 */
export function buildProjectRuleSet(
  proJson: string,
  source: string,
  netNames: readonly string[] = [],
): ProjectRuleSet {
  let data: unknown
  try {
    data = JSON.parse(proJson)
  } catch {
    throw new Error(`${source} 不是合法 JSON`)
  }
  const rules = (data as { board?: { design_settings?: { rules?: Record<string, unknown> } } })
    ?.board?.design_settings?.rules ?? {}

  const applied: AppliedProjectRule[] = []
  const skipped: SkippedProjectRule[] = []

  for (const [constraint, key] of BOARD_CONSTRAINTS) {
    const raw = rules[key]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      skipped.push({ key, reason: '工程里没有该约束' })
      continue
    }
    // KiCad 用 0 表示"不启用该约束"，注入 (min 0) 等于关掉检查，必须跳过
    if (raw <= 0) {
      skipped.push({ key, reason: '值为 0，表示该约束在工程里未启用' })
      continue
    }
    applied.push({ constraint, mm: raw })
  }

  for (const [key, reason] of Object.entries(SKIPPED_KEYS)) {
    if (key in rules) skipped.push({ key, reason })
  }

  // 网络类：只还原 clearance。
  //
  // 实测（board-full，造一个 Power 类 0.4mm，与原生 netclass 对照）：
  //   clearance 条件规则 → 720 条 / clearance 499，与原生**逐项一致**；
  //   track_width / via_diameter 原生根本不当作 DRC 约束，注入后会凭空多出
  //   31 / 87 条。所以这两个不注入，避免重演 silk 那种放大。
  //
  // 宽松的类也安全：KiCad 对一对物件取两类 clearance 的较大值，注入较小的
  // 值不会放宽板级下限（实测 0.05 与原生同为 221 条）。
  const netSettings = (
    data as {
      net_settings?: {
        classes?: unknown
        netclass_assignments?: unknown
        netclass_patterns?: unknown
      }
    }
  ).net_settings
  const classes = netSettings?.classes
  if (Array.isArray(classes)) {
    const members =
      netSettings && netNames.length > 0
        ? resolveNetClassMembers(netSettings, netNames)
        : new Map<string, string[]>()
    for (const entry of classes) {
      if (!entry || typeof entry !== 'object') continue
      const row = entry as { name?: unknown; clearance?: unknown }
      const name = typeof row.name === 'string' ? row.name.trim() : ''
      if (!name || name === 'Default') continue
      const clearance = row.clearance
      if (typeof clearance !== 'number' || !Number.isFinite(clearance) || clearance <= 0) {
        skipped.push({ key: `netclass:${name}:clearance`, reason: '网络类没有可用的 clearance' })
        continue
      }
      const resolved = members.get(name) ?? []
      if (netNames.length > 0 && resolved.length === 0) {
        skipped.push({ key: `netclass:${name}:clearance`, reason: '该网络类在板上没有命中的网络' })
        continue
      }
      applied.push({
        constraint: 'clearance',
        mm: clearance,
        netclass: name,
        ...(resolved.length > 0 ? { nets: resolved } : {}),
      })
    }
  }

  const block = applied.length === 0
    ? ''
    : [
        PROJECT_RULES_MARKER,
        '# 由宿主插件按工程 .kicad_pro 的板级约束与网络类生成；服务端默认工程没有这些值。',
        ...applied.map(({ constraint, mm: value, netclass, nets }) => {
          if (netclass === undefined) {
            return `(rule "dsh_project_${constraint}"\n  (constraint ${constraint} (min ${mm(value)})))`
          }
          const condition =
            nets && nets.length > 0
              ? netNameCondition(nets)
              : `A.NetClass == '${escapeCondition(netclass)}'`
          return `(rule "dsh_netclass_${sanitizeRuleName(netclass)}_${constraint}"\n  (condition "${condition}")\n  (constraint ${constraint} (min ${mm(value)})))`
        }),
        '',
      ].join('\n')

  return { source, applied, skipped, block }
}

const MARKERS = [PROJECT_RULES_MARKER, PROJECT_DRU_MARKER] as const

/**
 * 剥掉某个标记开头的注入段，切到下一个注入标记或文件末尾为止。
 *
 * 两个注入段可能同时存在且顺序固定（板级约束在前、工程 `.kicad_dru` 在后），
 * 所以不能一律切到 EOF，否则会把后面的段一起带走。
 */
function stripSection(content: string, marker: string): string {
  const at = content.indexOf(marker)
  if (at < 0) return content
  const after = content.slice(at + marker.length)
  let next = Number.POSITIVE_INFINITY
  for (const other of MARKERS) {
    const index = after.indexOf(other)
    if (index >= 0 && index < next) next = index
  }
  const tail = Number.isFinite(next) ? after.slice(next) : ''
  return `${content.slice(0, at).trimEnd()}\n${tail}`
}

/** 剥掉上一次注入的板级约束块，保证重复注入不叠加。 */
export function stripInjectedRules(content: string): string {
  return stripSection(content, PROJECT_RULES_MARKER)
}

/** 把规则块拼到会话规则文件末尾。 */
export function injectProjectRules(baseContent: string, set: ProjectRuleSet): string {
  if (!set.block) return stripInjectedRules(baseContent)
  return `${stripInjectedRules(baseContent)}\n${set.block}`
}

/**
 * 剥掉上一次注入的工程 `.kicad_dru` 段。
 *
 * 该段总是排在板级约束块之前，所以剥到下一个注入标记（或文件末尾）为止。
 */
export function stripProjectDru(content: string): string {
  return stripSection(content, PROJECT_DRU_MARKER)
}

/**
 * 把工程自带的 `.kicad_dru` 拼到会话规则**末尾**，幂等。
 *
 * 必须放在生成块之后：KiCad 里后出现的规则覆盖先出现的（实测把工程规则放前面，
 * 会被同名的网络类规则盖掉，0.4mm 的间距当场失效）。工程自定义规则本来就该
 * 优先于按板级默认值生成的规则。
 *
 * 会话里已有的服务端语义规则（ic_keepout 等）保留不动；版本声明会被去掉，
 * 避免出现第二个 `(version N)`。
 */
export function injectProjectDru(baseContent: string, druContent: string | undefined): string {
  // 只剥工程 dru 段：调用方通常已经先写好了板级约束块，不能连它一起清掉
  const stripped = stripProjectDru(baseContent)
  const body = stripDruVersion(druContent ?? '').trim()
  if (!body) return stripped
  return `${stripped.trimEnd()}\n\n${PROJECT_DRU_MARKER}\n${body}\n`
}

/** 一条人类可读的摘要，写进结果的 stderr，让调用方知道判定用了哪套阈值。 */
export function describeProjectRules(set: ProjectRuleSet): string {
  const board = set.applied.filter((r) => r.netclass === undefined)
  const declared = set.applied.filter((r) => r.netclass !== undefined)
  const list = board.map((r) => `${r.constraint} ${r.mm}`).join(' / ')
  const classes = [...new Set(declared.map((r) => r.netclass))].join(' / ')
  const parts = [
    `工程规则已注入（${set.source}，${board.length} 条板级约束：${list}）`,
  ]
  if (declared.length > 0) {
    parts.push(`${declared.length} 条网络类规则：${classes}`)
  }
  return parts.join('；')
}

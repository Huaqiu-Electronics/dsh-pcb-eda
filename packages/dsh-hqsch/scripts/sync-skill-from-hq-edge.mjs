#!/usr/bin/env node
/**
 * Sync the DSH-bundled `hqsch-scenario-b` skill from the hq-edge upstream
 * package, then re-apply the DSH-only layer on top.
 *
 * Usage (from packages/dsh-hqsch):
 *   node scripts/sync-skill-from-hq-edge.mjs --check
 *   node scripts/sync-skill-from-hq-edge.mjs
 *   node scripts/sync-skill-from-hq-edge.mjs --target <dir> [--target <dir>]...
 *
 * Upstream (READ-ONLY, never written by this script):
 *   <sibling repo>/hq-edge/skills/hqeda/scenario-b
 *   override with  HQ_EDGE_SCENARIO_B=<abs path>
 *
 * ---------------------------------------------------------------------------
 * Merge rule:   result = upstream  +  DSH layer
 * ---------------------------------------------------------------------------
 * The upstream package is the single source of truth for every file it ships
 * (content AND file set). The DSH layer is then re-applied because
 * `pnpm run build:scenario-b:dsh` wipes the target directory and cannot know
 * about DSH-specific material. See skills/hqsch-scenario-b/INSTALL.md
 * § "DSH 侧额外层".
 *
 * DSH layer:
 *   A. DSH-only files (absent upstream -> preserved verbatim from the current
 *      bundle):
 *        docs/script-lifetime.md
 *        template/scripts/lib/hq.ts
 *   B. `hqMain` / `hqMainWithProject` entry shell for the template scripts
 *      (upstream uses a bare `connect()` + `main().catch(...)`):
 *        edit-property-by-ref.ts  export-layout-pdf.ts  fix-designators.ts
 *        hello.ts  layout-audit.ts  place-part.ts  probe-rpc.ts
 *        read-circuit.ts  replace-part-by-ref.ts  rewire-pin-by-ref.ts
 *      `search-parts.ts` is HTTP-only and stays byte-identical to upstream.
 *      `modular-lib.ts` is library code: upstream wins outright.
 *   C. identity + wording:
 *        SKILL.md          name -> hqsch-scenario-b, script-lifetime row,
 *                          hqMain blockquote, DSH part-search wording
 *        SYSTEM-PROMPT.md  same rewording; AGENTS.md / CLAUDE.md are copies
 *        skill.json        id -> hqsch-scenario-b, name -> HQSCH Scenario B
 *        INSTALL.md        ^0.1.9 pin rationale + hq.ts row + DSH layer note
 *        docs/quickstart.md  "no bare connect() in the DSH bundle" note
 *        template/package.json       name + `typecheck` + @types/node
 *        template/package-lock.json  name + @types/node tree
 *        the three non-md files are taken verbatim from the current bundle,
 *        which is already the upstream text plus exactly that DSH delta.
 *   D. bundle-relative link repair: upstream ships a few links written for the
 *      authoring monorepo that escape the skill bundle (`../../guides/...`,
 *      `../../../scenario-b/...`). Rewritten to the in-bundle target.
 *
 * Both `--check` and a real run rebuild the bundle from scratch in
 * `.sync-staging/` and fail loudly when an anchor no longer matches upstream,
 * so a drift surfaces here instead of shipping a half-merged skill.
 *
 * Deliberate resets: several upstream-generated files (docs/rpc-*.md indexes,
 * docs/skill-dependencies.md, docs/reading-a-circuit.md, modular-lib.ts) were
 * regenerated upstream after the last sync. Upstream wins for them, so those
 * bundles lose the older, locally-stale text — that is intended.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(__dirname, '..')
const bundleDir = join(pkgRoot, 'skills', 'hqsch-scenario-b')

const upstreamDir =
  process.env.HQ_EDGE_SCENARIO_B ??
  resolve(pkgRoot, '..', '..', '..', 'hq-edge', 'skills', 'hqeda', 'scenario-b')

// ---------------------------------------------------------------- cli ------

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const extraTargets = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--target') {
    const value = argv[++i]
    if (!value) fail('--target needs a directory')
    extraTargets.push(resolve(value))
  } else if (argv[i] !== '--check') {
    fail(`unknown argument: ${argv[i]}`)
  }
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

// ------------------------------------------------------- text helpers ------

const EOL = '\r\n'
const toLf = (text) => text.replace(/\r\n/g, '\n')

function read(file) {
  return readFileSync(file, 'utf8')
}

/** Read a UTF-8 file as LF-normalised text. */
function readText(file) {
  return toLf(read(file))
}

/** Write LF-normalised text back as CRLF, UTF-8 without BOM. */
function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text.replace(/\n/g, EOL), 'utf8')
}

/**
 * Apply `[find, replace, count]` patches; every `find` must occur exactly
 * `count` times (default once; `Infinity` means "at least once"). Throws on a
 * miss so drifting upstream text never passes silently.
 */
function patch(label, text, patches) {
  let out = text
  for (const [find, replace, count = 1] of patches) {
    const hits = out.split(find).length - 1
    const ok = count === Infinity ? hits >= 1 : hits === count
    if (!ok) {
      throw new Error(
        `${label}: patch anchor found ${hits}× (expected ${count}×) — upstream drifted, merge manually:\n` +
          `  ${find.split('\n')[0].slice(0, 120)}`,
      )
    }
    out = out.split(find).join(replace)
  }
  return out
}

/** Multiset line difference, used as a drift guard for the entry-shell files. */
function changedLines(before, after) {
  const count = (text) => {
    const m = new Map()
    for (const line of text.split('\n')) m.set(line, (m.get(line) ?? 0) + 1)
    return m
  }
  const a = count(before)
  const b = count(after)
  const removed = []
  const added = []
  for (const [line, n] of a) {
    const delta = n - (b.get(line) ?? 0)
    for (let i = 0; i < delta; i++) removed.push(line)
  }
  for (const [line, n] of b) {
    const delta = n - (a.get(line) ?? 0)
    for (let i = 0; i < delta; i++) added.push(line)
  }
  return { removed, added, count: removed.length + added.length }
}

function listFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry)
      if (statSync(abs).isDirectory()) {
        if (entry === 'node_modules') continue
        walk(abs)
      } else {
        out.push(relative(root, abs).split('\\').join('/'))
      }
    }
  }
  walk(root)
  return out.sort()
}

// ------------------------------------------------------- layer spec --------

/** A. files that exist only in the DSH bundle. */
const DSH_ONLY_FILES = ['docs/script-lifetime.md', 'template/scripts/lib/hq.ts']

/** B. template scripts carrying the `hqMain*` entry shell. */
const ENTRY_SHELL_SCRIPTS = [
  'template/scripts/edit-property-by-ref.ts',
  'template/scripts/export-layout-pdf.ts',
  'template/scripts/fix-designators.ts',
  'template/scripts/hello.ts',
  'template/scripts/layout-audit.ts',
  'template/scripts/place-part.ts',
  'template/scripts/probe-rpc.ts',
  'template/scripts/read-circuit.ts',
  'template/scripts/replace-part-by-ref.ts',
  'template/scripts/rewire-pin-by-ref.ts',
]

/** Scripts that stay byte-identical to upstream (no editor connection). */
const UPSTREAM_VERBATIM_SCRIPTS = ['template/scripts/search-parts.ts']

/** Entry-shell files whose content is exactly `upstream + DSH delta`. */
const DSH_DELTA_VERBATIM = [
  'docs/quickstart.md',
  'template/package.json',
  'template/package-lock.json',
  ...ENTRY_SHELL_SCRIPTS.filter((f) => f !== 'template/scripts/probe-rpc.ts'),
]

/** Largest tolerated line delta for an entry-shell file. */
const ENTRY_SHELL_MAX_DELTA = 40

// ------------------------------------------------ patches (applied to a) ---

const HQSCH_SKILL_NAME = 'hqsch-scenario-b'

const SKILL_MD_PATCHES = [
  ['name: hqeda-scenario-b\n', `name: ${HQSCH_SKILL_NAME}\n`],
  [
    '| 15 | [docs/layout-visual-review.md](./docs/layout-visual-review.md) | save → export PDF 目视验收 |\n' +
      '| 16 | [docs/rpc/](./docs/rpc/) | RPC field reference |\n',
    '| 15 | [docs/layout-visual-review.md](./docs/layout-visual-review.md) | save → export PDF 目视验收 |\n' +
      '| 16 | [docs/script-lifetime.md](./docs/script-lifetime.md) | **Process lifetime — must use `hqMain` / `hqMainWithProject`, or node processes leak** |\n' +
      '| 17 | [docs/rpc/](./docs/rpc/) | RPC field reference |\n',
  ],
  [
    'HQ EDA desktop must be running with a schematic project open.\n\n## Execution flow (summary)\n',
    'HQ EDA desktop must be running with a schematic project open.\n' +
      '\n' +
      '> **Every script must enter through `hqMain` / `hqMainWithProject` in\n' +
      '> `scripts/lib/hq.ts`** (per-RPC deadline passed to `connect({ timeoutMs })` +\n' +
      '> deterministic `client.close()` + guaranteed exit). A stalled RPC refs the Node\n' +
      '> event loop and makes the process immortal, so each retry leaks another one.\n' +
      '> See [docs/script-lifetime.md](./docs/script-lifetime.md).\n' +
      '\n' +
      '## Execution flow (summary)\n',
  ],
  [
    '- **Part selection (every part, passives included):** list candidates first (`search_hqsch_parts` when the tool exists, otherwise `scripts/search-parts.ts`), pick one explicitly',
    '- **Part selection (every part, passives included):** list candidates first with the DSH tool `search_hqsch_parts` (fall back to `scripts/search-parts.ts` only if the tool is unavailable), pick one explicitly',
  ],
]

const SYSTEM_PROMPT_PATCHES = [
  [
    '16. `docs/rpc/*.md` — 仅当需要某个 RPC 的精确字段名时查阅\n',
    '16. `docs/script-lifetime.md` — **进程生命周期：必须用 `hqMain` / `hqMainWithProject`，否则泄漏 node 进程**（写任何脚本前先读）\n' +
      '17. `docs/rpc/*.md` — 仅当需要某个 RPC 的精确字段名时查阅\n',
  ],
  [
    '- 器件（R/C/Q/U）：在线搜索 + `client.componentPlace.placeKicadSymbol`；**禁止**手写 `json_part` / `PlacePart`\n',
    '- **所有脚本必须经 `scripts/lib/hq.ts` 的 `hqMain` / `hqMainWithProject` 进入**；**禁止**裸 `connect()` + `main().catch(e => process.exit(1))`。外壳透传 `connect({ timeoutMs })`、`finally { client.close() }`、保证进程退出。见 `docs/script-lifetime.md`。唯一例外是 `scripts/search-parts.ts`：只发 HTTP、不连编辑器。\n' +
      '- **不要依赖「脚本会自己退出」**：卡住的 RPC 会让 node 进程永久存活，重试一次多泄漏一个。\n' +
      '- 器件（R/C/Q/U）：在线搜索 + `client.componentPlace.placeKicadSymbol`；**禁止**手写 `json_part` / `PlacePart`\n',
  ],
  [
    '- **器件选型先看候选再选（所有器件，含阻容）**：当前环境有 `search_hqsch_parts` / `get_hqsch_part_models` 等 tool 就用 tool；没有就跑 `npx tsx scripts/search-parts.ts`（`QUERY=…`，只读、不连编辑器）。',
    '- **器件选型先看候选再选（所有器件，含阻容）**：DSH 已装 `@huaqiu/dsh-tool-part-search`，选型 / 查参数 / 查供货一律用 `search_hqsch_parts` / `get_hqsch_part` / `get_hqsch_part_models` / `get_hqsch_supply_chain` 这几个 tool；只有 tool 不可用时才跑 `npx tsx scripts/search-parts.ts`（`QUERY=…`，只读、不连编辑器，是唯一不经 `hqMain` 的脚本）。',
  ],
  [
    '2.5 **器件选型**（生成脚本前，必做）：对每个位号查候选（有 tool 用 `search_hqsch_parts`，否则 `scripts/search-parts.ts`），在设计说明里列出',
    '2.5 **器件选型**（生成脚本前，必做）：对每个位号用 `search_hqsch_parts` 查候选（tool 不可用时用 `scripts/search-parts.ts`），在设计说明里列出',
  ],
  [
    'import { connect, toJsonString } from "@huaqiu/huaqiu-client";\n' +
      'import { HqServicesV1PatternLayoutService } from "@hqedge/connect";\n' +
      '\n' +
      'const PL = HqServicesV1PatternLayoutService;   // 枚举来源\n' +
      'const INSTANCE = process.env.HQ_INSTANCE_ID;\n' +
      'const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\n' +
      '\n' +
      'async function main() {\n' +
      '  const client = INSTANCE\n' +
      '    ? await connect({ instanceId: INSTANCE })\n' +
      '    : await connect();\n' +
      '\n' +
      '  const editorCtx = client.createEditorContext();\n' +
      '  const active = await client.project.getActiveProject({ context: editorCtx });\n' +
      '  const projectId = active.project?.projectId;\n' +
      '  if (!projectId) throw new Error("请先在 HQ EDA 中打开原理图工程");\n' +
      '  const ctx = client.createProjectContext(projectId);\n',
    'import { toJsonString } from "@huaqiu/huaqiu-client";\n' +
      'import { HqServicesV1PatternLayoutService } from "@hqedge/connect";\n' +
      'import { hqMainWithProject, waitForRegistered } from "./lib/hq.js";\n' +
      '\n' +
      'const PL = HqServicesV1PatternLayoutService;   // 枚举来源\n' +
      'const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\n' +
      '\n' +
      'hqMainWithProject(async ({ client, projectId, projectContext: ctx }) => {\n' +
      '  console.log("projectId:", projectId);\n',
  ],
  [
    '  await client.canvasOps.zoomAll({ context: ctx });\n  console.log("done");\n}\n\nmain().catch((e) => { console.error(e); process.exit(1); });\n',
    '  await client.canvasOps.zoomAll({ context: ctx });\n  console.log("done");\n});\n',
  ],
]

/** `probe-rpc.ts` gained probes upstream after the last sync: rebuild it. */
const PROBE_RPC_PATCHES = [
  ['import { connect } from "@huaqiu/huaqiu-client";\n', 'import { hqMain } from "./lib/hq.js";\n'],
  [
    'async function main() {\n' +
      '  const client: any = await connect(\n' +
      '    process.env.HQ_INSTANCE_ID ? { instanceId: process.env.HQ_INSTANCE_ID } : undefined,\n' +
      '  );\n',
    'hqMain(async (client: any) => {\n',
  ],
  [
    '  process.exit(fail > 0 ? 1 : 0);\n}\n\nmain().catch((e) => {\n  console.error(e);\n  process.exit(2);\n});\n',
    '  process.exitCode = fail > 0 ? 1 : 0;\n});\n',
  ],
]

const SKILL_JSON_PATCHES = [
  ['"id": "hqeda-scenario-b",', `"id": "${HQSCH_SKILL_NAME}",`],
  ['"name": "HQ EDA Scenario B — Coding Agent + Local Scripts",', '"name": "HQSCH Scenario B — Coding Agent + Local Scripts",'],
]

const DSH_LAYER_NOTE = `> **DSH 侧额外层**（上游 \`pnpm run build:scenario-b:dsh\` 会清空目标目录，同步后必须补回）：
>
> 1. \`docs/script-lifetime.md\` 与 \`template/scripts/lib/hq.ts\`（\`hqMain\` / \`hqMainWithProject\`
>    运行时外壳）—— 上游不提供。
> 2. 模板脚本入口 —— 改回 \`hqMain\` / \`hqMainWithProject\`（上游是裸 \`connect()\` + \`main().catch()\`），
>    含 \`place-part.ts\`。\`search-parts.ts\` 不连编辑器，保持上游原样。
>    \`layout-audit.ts\` 走外壳后不再调用 \`openCtx()\`，改为在入口显式 \`refreshPageTop(client, ctx)\`。
> 3. \`SKILL.md\` / \`SYSTEM-PROMPT.md\`（→ \`AGENTS.md\`、\`CLAUDE.md\`）—— 补回 \`hqMain\` 硬性规则（含
>    \`search-parts.ts\` 例外）、\`docs/script-lifetime.md\` 阅读清单条目、\`^0.1.9\` 客户端版本要求，
>    以及「本环境已装 part-search tool，选型优先用 tool」的选型规则措辞。
> 4. \`template/package.json\` / \`template/package-lock.json\` —— 保留 \`name: hqsch-scenario-b\`、
>    \`typecheck\` 脚本、\`@types/node\` 与 \`^0.1.9\` 依赖钉版。
> 5. \`docs/quickstart.md\` —— 在 \`connect()\` 小节补一条「DSH bundle 里不要裸调 \`connect()\`，走 \`hqMain\`」的提示。
> 6. 包内相对链接修复 —— 上游有少量按 monorepo 目录书写的链接会**跳出 skill 包**
>    （\`../../guides/…\`、\`../../../scenario-b/…\`），改为包内相对路径：
>    \`docs/reading-a-circuit.md\`、\`docs/modular-layout-hq-mapping.md\`、\`docs/modular-layout-playbook.md\`。
>
> 1–6 已脚本化，**优先用它**（幂等、带漂移校验；\`--check\` 只演练不落盘）：
>
> \`\`\`bash
> cd packages/dsh-hqsch
> node scripts/sync-skill-from-hq-edge.mjs --check     # 演练 + 校验
> node scripts/sync-skill-from-hq-edge.mjs             # 同步本包
> # 再把已部署的插件副本一起镜像（dist 的 dsh-plugins、DSH_HOME 的 builtin-plugins）：
> node scripts/sync-skill-from-hq-edge.mjs --target <skills/hqsch-scenario-b 目录> ...
> \`\`\`
>
> 脚本以**上游为准**：上游新增或改写的文件一律覆盖本包。因此上游重新生成过的
> \`docs/rpc-index/*\`、\`docs/skill-dependencies.md\`、\`docs/reading-a-circuit.md\`、
> \`template/scripts/modular-lib.ts\` 会丢掉本包早先那份较旧的文本 —— 这是预期行为。
>
> \`refreshPageTop(client, ctx)\` 自 2026-10-08 起已由上游 \`modular-lib.ts\` 导出
> （\`calibratePageTop\` 的兼容别名），不再需要单独补丁。`

const INSTALL_MD_PATCHES = [
  [
    '| `template/` | 本地脚本工程 + 连通性测试 |\n',
    '| `template/` | 本地脚本工程 + 连通性测试 |\n' +
      '| `template/scripts/lib/hq.ts` | 所有脚本的运行时外壳（**必须**用 `hqMain` / `hqMainWithProject`） |\n',
  ],
  [
    '目标目录：`dsh-pcb-eda/packages/dsh-hqsch/skills/hqsch-scenario-b/`（SKILL 名改为 `hqsch-scenario-b`）。\n',
    '目标目录：`dsh-pcb-eda/packages/dsh-hqsch/skills/hqsch-scenario-b/`（SKILL 名改为 `hqsch-scenario-b`）。\n' +
      `\n${DSH_LAYER_NOTE}\n`,
  ],
  [
    '| 推荐版本 | `@huaqiu/huaqiu-client` ^0.1.9；可选 `@huaqiu/hqeda` ^0.2.7 |\n',
    '| 推荐版本 | `@huaqiu/huaqiu-client` **^0.1.9**（per-RPC 截止时间在库传输层实现，必须有）；可选 `@huaqiu/hqeda` ^0.2.7 |\n',
  ],
]

/** D. links that escape the skill bundle -> in-bundle target. */
const LINK_REPAIRS = {
  'docs/reading-a-circuit.md': [
    ['../../../scenario-b/docs/hierarchical-schematic-playbook.md', 'hierarchical-schematic-playbook.md'],
  ],
  'docs/modular-layout-hq-mapping.md': [['../../guides/', '']],
  'docs/modular-layout-playbook.md': [['../../guides/', '']],
}

// ------------------------------------------------------------ staging ------

function buildBundle() {
  if (!existsSync(join(upstreamDir, 'SKILL.md'))) {
    fail(`upstream scenario-b not found at ${upstreamDir} (set HQ_EDGE_SCENARIO_B)`)
  }
  if (!existsSync(join(bundleDir, 'SKILL.md'))) {
    fail(`current DSH bundle not found at ${bundleDir}`)
  }

  const staging = join(pkgRoot, '.sync-staging')
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  // 1) upstream wholesale, minus the authoring-only node_modules
  cpSync(upstreamDir, staging, {
    recursive: true,
    filter: (src) => !src.includes(join('template', 'node_modules')),
  })

  const notes = []
  const readUp = (rel) => readText(join(upstreamDir, rel))
  const readDsh = (rel) => readText(join(bundleDir, rel))
  const put = (rel, text) => writeText(join(staging, rel), text)

  // 2) A. DSH-only files survive untouched
  for (const rel of DSH_ONLY_FILES) {
    if (!existsSync(join(bundleDir, rel))) fail(`DSH-only file missing from the bundle: ${rel}`)
    cpSync(join(bundleDir, rel), join(staging, rel))
  }

  // 3) B. entry shell
  for (const rel of ENTRY_SHELL_SCRIPTS) {
    const up = readUp(rel)
    const dsh = readDsh(rel)
    if (!/hqMain(WithProject)?\s*\(/.test(dsh)) fail(`${rel}: bundle copy lost the hqMain shell`)
    if (/hqMain(WithProject)?\s*\(/.test(up)) fail(`${rel}: upstream now ships its own hqMain shell — merge manually`)
    const delta = changedLines(up, dsh)
    if (delta.count > ENTRY_SHELL_MAX_DELTA) {
      fail(
        `${rel}: bundle differs from upstream by ${delta.count} lines (> ${ENTRY_SHELL_MAX_DELTA}) — ` +
          'upstream changed more than the entry shell, merge manually',
      )
    }
    notes.push(`    ${rel}  (entry shell, ${delta.count} lines)`)
    put(rel, dsh)
  }

  // 4) B'. probe-rpc.ts carries new upstream probes -> re-wrap it
  put('template/scripts/probe-rpc.ts', patch('probe-rpc.ts', readUp('template/scripts/probe-rpc.ts'), PROBE_RPC_PATCHES))
  notes.push('    template/scripts/probe-rpc.ts  (upstream probes + entry shell)')

  // 5) C. identity + wording
  put('SKILL.md', patch('SKILL.md', readUp('SKILL.md'), SKILL_MD_PATCHES))
  const prompt = patch('SYSTEM-PROMPT.md', readUp('SYSTEM-PROMPT.md'), SYSTEM_PROMPT_PATCHES)
  put('SYSTEM-PROMPT.md', prompt)
  put('AGENTS.md', prompt)
  put('CLAUDE.md', prompt)
  put('skill.json', patch('skill.json', readUp('skill.json'), SKILL_JSON_PATCHES))
  put('INSTALL.md', patch('INSTALL.md', readUp('INSTALL.md'), INSTALL_MD_PATCHES))

  // 6) C'. files whose bundle copy is already exactly upstream + DSH delta
  for (const rel of DSH_DELTA_VERBATIM) put(rel, readDsh(rel))

  // 7) D. bundle-relative link repair
  for (const [rel, patches] of Object.entries(LINK_REPAIRS)) {
    put(rel, patch(rel, readUp(rel), patches.map(([f, r]) => [f, r, Infinity])))
  }

  // 8) guards
  const staged = listFiles(staging)
  for (const rel of ['SKILL.md', 'SYSTEM-PROMPT.md', 'AGENTS.md', 'CLAUDE.md', 'skill.json', ...DSH_ONLY_FILES]) {
    if (!staged.includes(rel)) fail(`staged bundle is missing ${rel}`)
  }
  if (staged.some((f) => f.includes('node_modules'))) fail('staged bundle must not contain node_modules')
  const skillMd = readText(join(staging, 'SKILL.md'))
  if (!skillMd.includes(`name: ${HQSCH_SKILL_NAME}`)) fail('SKILL.md name rename failed')
  if (!skillMd.includes('docs/script-lifetime.md')) fail('SKILL.md lost the script-lifetime row')
  if (!skillMd.includes('hierarchical-schematic-playbook.md')) fail('SKILL.md lost the upstream hierarchical row')
  for (const rel of UPSTREAM_VERBATIM_SCRIPTS) {
    if (readText(join(staging, rel)) !== readUp(rel)) fail(`${rel} must stay identical to upstream`)
  }

  return { staging, notes, files: staged }
}

// ------------------------------------------------------------- mirror ------

function removeTree(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      return
    } catch (err) {
      if (attempt === 4) throw err
    }
  }
}

function targets() {
  const all = [bundleDir, ...extraTargets]
  return all.filter((dir, i) => existsSync(dir) && all.indexOf(dir) === i)
}

// --------------------------------------------------------------- main ------

const { staging, notes, files } = buildBundle()

console.log(`upstream : ${upstreamDir}`)
console.log(`bundle   : ${bundleDir}`)
console.log(`staged   : ${files.length} files`)
console.log('DSH layer re-applied:')
for (const note of notes) console.log(note)
console.log(`    DSH-only files preserved: ${DSH_ONLY_FILES.join(', ')}`)
console.log('    identity/wording: SKILL.md, SYSTEM-PROMPT.md, AGENTS.md, CLAUDE.md, skill.json, INSTALL.md, docs/quickstart.md, template/package*.json')
console.log(`    link repair: ${Object.keys(LINK_REPAIRS).join(', ')}`)

if (checkOnly) {
  console.log('\n--check: staging built and verified; nothing written to the targets.')
  process.exit(0)
}

for (const target of targets()) {
  removeTree(target)
  mkdirSync(target, { recursive: true })
  cpSync(staging, target, { recursive: true })
  const mismatched = listFiles(staging).filter(
    (rel) => readFileSync(join(staging, rel)).compare(readFileSync(join(target, rel))) !== 0,
  )
  if (mismatched.length) fail(`${target}: ${mismatched.length} file(s) did not mirror: ${mismatched.join(', ')}`)
  console.log(`✓ ${target}`)
}

rmSync(staging, { recursive: true, force: true })
console.log(`\nDone — ${files.length} files per target.`)

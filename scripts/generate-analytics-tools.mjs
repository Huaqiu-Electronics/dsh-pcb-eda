#!/usr/bin/env node
/**
 * Generate the Sensors Analytics built-in business-tool allowlist.
 *
 * Discovers every DSH plugin under `packages/`, scans its Host-side TypeScript
 * sources for tools created with `defineTool()`, and writes the deterministic
 * tool-name list consumed by `@huaqiu/dsh-analytics`. Client sources are
 * excluded so tool-view registrations are never mistaken for executable
 * tools. Local helper functions that forward a literal tool name into
 * `defineTool()` are supported as well.
 *
 * The analytics package runs this script automatically before each build, so
 * adding or removing an in-repo built-in tool refreshes the generated list
 * without editing the analytics plugin by hand. Exceptional external tools
 * remain opt-in through `EXTRA_TRACKED_TOOLS` in `src/tool-events.ts`.
 *
 * A second source is merged in: the HQ Edge DSH built-in plugins
 * (`apps/server/dsh-plugins/` in the *hq-edge* repository). They are not
 * published from here and live outside `packages/`, so they are pinned below in
 * `HQ_EDGE_BUILTIN_TOOLS` and verified against the real sources whenever an
 * hq-edge checkout is reachable. See the block comment on that constant.
 *
 * Usage:
 *   node scripts/generate-analytics-tools.mjs
 *
 * Environment:
 *   HQ_EDGE_ROOT — path to the hq-edge checkout used for the drift check.
 *                  Defaults to a sibling `../hq-edge`. Absent checkout = the
 *                  check is skipped (CI checks out this repo only).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { dshPlugins, repoRoot } from './utils/packages.mjs'

const output = join(repoRoot, 'packages', 'dsh-analytics', 'src', 'generated', 'builtin-tools.ts')

/**
 * Agent tools registered by the HQ Edge DSH built-in plugins.
 *
 * HQ Edge ships its own sealed DSH plugins — `apps/server/dsh-plugins/` in the
 * *hq-edge* repository — and materializes them into `DSH_HOME` at boot
 * (`apps/server/src/dsh/supervisor.ts` → `ensureHQBuiltinPlugins`). They are
 * hard-coded in that repo (plain JavaScript, not `packages/` here), so the
 * in-repo scan above can never see them, yet their tools run in the same DSH
 * runtime as everything else here. Without them the ERC / BOM usage vanishes
 * from analytics.
 *
 * They are pinned rather than discovered because this package is published from
 * CI, which checks out dsh-pcb-eda alone (`.github/workflows/ci.yml`) — a scan
 * would silently drop them from the published allowlist. Keep the list in sync
 * by hand; `verifyHqEdgeBuiltinTools()` below cross-checks it against the real
 * plugin sources whenever an hq-edge checkout is reachable, so a stale pin is
 * caught on any developer machine instead of in production.
 *
 * Source of truth: hq-edge `apps/server/dsh-plugins/erc/lib/index.js`
 * (the `ctx.tools.register(...)` calls in `apply()`).
 */
const HQ_EDGE_BUILTIN_TOOLS = [
  'get_eda_bom',
  'match_bom',
  'run_erc',
]

function sourceFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'client') files.push(...sourceFiles(path))
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(path)
    }
  }
  return files
}

function callName(expression) {
  return ts.isIdentifier(expression) ? expression.text : undefined
}

function helperName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const declaration = node.parent
    if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) return declaration.name.text
  }
  return undefined
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current
  }
  return undefined
}

function literalName(expression) {
  return ts.isStringLiteralLike(expression) ? expression.text : undefined
}

function collectTools(filename) {
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const names = new Set()
  const helpers = new Map()

  function visitDefinitions(node) {
    if (ts.isCallExpression(node) && callName(node.expression) === 'defineTool') {
      const config = node.arguments[0]
      if (config && ts.isObjectLiteralExpression(config)) {
        const property = config.properties.find(item =>
          (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item))
          && ts.isIdentifier(item.name) && item.name.text === 'name')
        if (property && (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))) {
          const initializer = ts.isPropertyAssignment(property) ? property.initializer : property.name
          const literal = literalName(initializer)
          if (literal) names.add(literal)
          else if (ts.isIdentifier(initializer)) {
            const fn = enclosingFunction(node)
            const name = fn && helperName(fn)
            const index = fn?.parameters.findIndex(parameter => ts.isIdentifier(parameter.name)
              && parameter.name.text === initializer.text) ?? -1
            if (name && index >= 0) helpers.set(name, index)
          }
        }
      }
    }
    ts.forEachChild(node, visitDefinitions)
  }
  visitDefinitions(source)

  function visitHelpers(node) {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression)
      const index = name === undefined ? undefined : helpers.get(name)
      if (index !== undefined) {
        const literal = node.arguments[index] && literalName(node.arguments[index])
        if (literal) names.add(literal)
      }
    }
    ts.forEachChild(node, visitHelpers)
  }
  visitHelpers(source)
  return names
}

// ─── HQ Edge DSH built-in plugins (pinned above, verified below) ──────────────

/** Plugin root inside the hq-edge repository (`apps/server/dsh-plugins`). */
const HQ_EDGE_DSH_PLUGINS_SUBPATH = ['apps', 'server', 'dsh-plugins']

/** Resolve the hq-edge checkout to verify against, or undefined if there is none. */
function hqEdgePluginsRoot() {
  const override = process.env.HQ_EDGE_ROOT
  const root = override && override.length > 0 ? resolve(override) : resolve(repoRoot, '..', 'hq-edge')
  return existsSync(root) ? join(root, ...HQ_EDGE_DSH_PLUGINS_SUBPATH) : undefined
}

/**
 * Plugin halves that can register agent tools.
 *
 * `lib/` holds the shipped JavaScript (these plugins are checked in pre-built,
 * no compile step), `src/` is scanned too so a plugin that keeps TypeScript
 * sources is picked up as well (see {@link hqEdgePluginHalves}). `client.*`
 * halves are skipped for the same reason as in {@link sourceFiles}: they
 * contribute tool *views*, never executable tools. Tests are skipped because
 * they restate every tool name in assertions and would mask a missing pin.
 */
function hqEdgeSourceFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...hqEdgeSourceFiles(path))
      continue
    }
    if (!entry.isFile()) continue
    const name = entry.name
    if (!/\.(?:[cm]?js|ts)$/.test(name)) continue
    if (name.endsWith('.d.ts')) continue
    if (/\.(?:test|spec)\./.test(name)) continue
    if (basename(name).startsWith('client.')) continue
    files.push(path)
  }
  return files
}

/** The `src/` + `lib/` halves of every plugin under the hq-edge plugin root. */
function hqEdgePluginHalves(pluginsRoot) {
  const halves = []
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const half of ['src', 'lib']) {
      const dir = join(pluginsRoot, entry.name, half)
      if (existsSync(dir)) halves.push(dir)
    }
  }
  return halves
}

/** Value of a string-literal property on an object literal, if present. */
function stringProperty(node, key) {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (!ts.isIdentifier(property.name) || property.name.text !== key) continue
    return literalName(property.initializer)
  }
  return undefined
}

/** Whether an object literal declares `key` at all (any value shape). */
function hasProperty(node, key) {
  return node.properties.some(property =>
    (ts.isPropertyAssignment(property)
      || ts.isShorthandPropertyAssignment(property)
      || ts.isMethodDeclaration(property))
    && ts.isIdentifier(property.name)
    && property.name.text === key)
}

/**
 * Collect tool names from one HQ Edge plugin half.
 *
 * These plugins do not use DSH's `defineTool()` helper; they hand a plain
 * definition object to `ctx.tools.register(...)`, usually one returned from a
 * `createXTool()` factory (`createGetEdaBomTool`, …). The registration call site
 * and the definition therefore live far apart, so recognise the *shape* instead
 * of the call: a tool definition is an object literal with a string `name` and
 * an `execute` member — the two fields DSH requires on every registered tool.
 * That covers both the factory style used by `@hqedge/dsh-erc` and any future
 * plugin that inlines the object at the `register()` call.
 */
function collectRegisteredTools(filename) {
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const names = new Set()

  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const name = stringProperty(node, 'name')
      if (name !== undefined && hasProperty(node, 'execute')) names.add(name)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

/**
 * Scan the hq-edge built-in plugins for the tools they register.
 * Returns undefined when there is no checkout to scan.
 */
function discoverHqEdgeBuiltinTools() {
  const pluginsRoot = hqEdgePluginsRoot()
  if (pluginsRoot === undefined || !existsSync(pluginsRoot)) return undefined

  const names = new Set()
  for (const half of hqEdgePluginHalves(pluginsRoot)) {
    for (const file of hqEdgeSourceFiles(half)) {
      for (const name of collectRegisteredTools(file)) names.add(name)
    }
  }
  return names
}

/**
 * Cross-check the pinned list against a real hq-edge checkout.
 *
 * A tool that the plugins register but the pin omits is an analytics gap —
 * those calls would go unrecorded in a release built from this pin — so it
 * fails the build. A pinned tool that no plugin registers any more is only a
 * dead allowlist entry, so it warns instead. A checkout that yields nothing
 * (plugins not checked out / not built) is not a signal either way and leaves
 * the pin untouched, which keeps CI — where hq-edge is absent entirely —
 * deterministic.
 */
function verifyHqEdgeBuiltinTools(discovered) {
  if (discovered === undefined) {
    console.log(
      'generate-analytics-tools: no hq-edge checkout found (set HQ_EDGE_ROOT to verify) — ' +
      `using the pinned ${HQ_EDGE_BUILTIN_TOOLS.length} HQ Edge built-in tools as-is`,
    )
    return
  }
  if (discovered.size === 0) {
    console.warn('generate-analytics-tools: hq-edge checkout has no discoverable plugin tools — skipping the pin check')
    return
  }

  const pinned = new Set(HQ_EDGE_BUILTIN_TOOLS)
  const missing = [...discovered].filter(name => !pinned.has(name)).sort()
  if (missing.length > 0) {
    throw new Error(
      'generate-analytics-tools: HQ_EDGE_BUILTIN_TOOLS is stale — the hq-edge built-in plugins register ' +
      `tools not listed here: ${missing.join(', ')}. Add them to HQ_EDGE_BUILTIN_TOOLS in this script ` +
      '(analytics would otherwise not track those calls).',
    )
  }

  const stale = HQ_EDGE_BUILTIN_TOOLS.filter(name => !discovered.has(name))
  if (stale.length > 0) {
    console.warn(
      `generate-analytics-tools: HQ_EDGE_BUILTIN_TOOLS lists tools no plugin registers any more: ${stale.join(', ')}`,
    )
  }
}

const names = new Set()
for (const plugin of dshPlugins()) {
  if (plugin.name === '@huaqiu/dsh-analytics') continue
  try {
    for (const file of sourceFiles(join(plugin.dir, 'src'))) {
      for (const name of collectTools(file)) names.add(name)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

// Merge the out-of-repo HQ Edge built-in tools (pinned + verified against a
// checkout when one is reachable).
verifyHqEdgeBuiltinTools(discoverHqEdgeBuiltinTools())
for (const name of HQ_EDGE_BUILTIN_TOOLS) names.add(name)

const sorted = [...names].sort()
if (sorted.length === 0) throw new Error('generate-analytics-tools: no built-in tools discovered')

const content = `// Generated by scripts/generate-analytics-tools.mjs. Do not edit by hand.\nexport const BUILTIN_TOOLS = [\n${sorted.map(name => `  ${JSON.stringify(name)},`).join('\n')}\n] as const\n`
writeFileSync(output, content)
console.log(`generate-analytics-tools: wrote ${sorted.length} tools to ${relative(repoRoot, output).split(sep).join('/')}`)

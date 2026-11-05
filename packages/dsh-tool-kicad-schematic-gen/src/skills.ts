/** Load the unified module-first schematic design skill from installed assets. */
import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillResourceBase } from '@deepseek-ai/dsh-skill'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { getKiCadPaths } from './runtime-paths.ts'

export const name = 'kicad-schematic-design-skill'
export const inject = ['skills']

const skillName = 'kicad-schematic-design'
const providerName = `bundled:${skillName}`
const directory = fileURLToPath(new URL(`../skills/${skillName}/`, import.meta.url))
const skillFile = new URL(`../skills/${skillName}/SKILL.md`, import.meta.url)

/** Read-only installed resources; project outputs must use the session workspace. */
export function skillResourcePaths() {
  return {
    pluginDir: fileURLToPath(new URL('../', import.meta.url)),
    skillDir: directory,
    referencesDir: join(directory, 'references'),
    assetsDir: join(directory, 'assets'),
    runtimePath: join(directory, 'assets', 'runtime.mjs'),
    powerLibraryPath: join(directory, 'assets', 'libraries', 'power.kicad_sym'),
    runnerPath: join(directory, 'scripts', 'run-design.mjs'),
    propertySyncPath: join(directory, 'scripts', 'sync-component-properties.mjs'),
    moduleTasksPath: join(directory, 'scripts', 'module-tasks.mjs'),
    moduleCheckerPath: join(directory, 'scripts', 'check-module.mjs'),
    modulePreflightPath: join(directory, 'scripts', 'preflight-modules.mjs'),
    moduleRuntimePath: join(directory, 'assets', 'module-runtime.mjs'),
    moduleTemplatesPath: join(directory, 'assets', 'module-templates.mjs'),
    moduleCircuitPath: join(directory, 'assets', 'module-circuit.mjs'),
    parallelTemplateDir: join(directory, 'assets', 'parallel-design'),
    drawingPatternsPath: join(directory, 'references', 'drawing-patterns.md'),
    patternReaderPath: join(directory, 'scripts', 'read-patterns.mjs'),
    drawingPatternAssetsDir: join(directory, 'assets', 'drawing-patterns'),
    geometryPath: join(directory, 'assets', 'drawing-patterns', 'geometry.mjs'),
    templateDir: join(directory, 'templates'),
  }
}

/** Display every resource without repeating the installation prefix twenty times. */
export function skillResourceLocations() {
  const { pluginDir, skillDir, ...resources } = skillResourcePaths()
  return { pluginDir, skillDir,
    runnerPath:resources.runnerPath,runtimePath:resources.runtimePath,parallelTemplateDir:resources.parallelTemplateDir,
    relativeToSkillDir: Object.fromEntries(
    Object.entries(resources).map(([key, path]) => [key, relative(skillDir, path).replaceAll('\\', '/')]),
  ) }
}

function parseSkill(raw: string): { description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (!frontmatter) throw new Error(`${skillName}: missing skill frontmatter`)
  const field = (key: string) => new RegExp(`^${key}: (.+)$`, 'm').exec(frontmatter[1]!)?.[1]?.trim()
  if (field('name') !== skillName) throw new Error(`${skillName}: SKILL.md name does not match provider`)
  const description = field('description')
  if (!description) throw new Error(`${skillName}: SKILL.md requires a description`)
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

/** Register the bundled skill provider with disposal owned by this plugin.
 * @param ctx - skill registry and registration effect scope.
 */
export function apply(ctx: Pick<Context, 'skills' | 'effect'>, kicadCliPath?:string): void {
  const parsed = parseSkill(readFileSync(skillFile, 'utf8'))
  const resourceBase: SkillResourceBase = { kind: 'directory', path: directory }
  const candidate: SkillCandidate = {
    name: skillName,
    description: parsed.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: providerName,
    source: 'bundled',
    resourceBase,
    rank: 600,
    locator: skillFile,
  }
  ctx.effect(() => ctx.skills.registerProvider(() => ({
    name: providerName,
    list: () => Promise.resolve([candidate]),
    async get(_candidate, options) {
      const loaded = parseSkill(await readFile(skillFile, { encoding: 'utf8', signal: options.signal }))
      const paths=getKiCadPaths(kicadCliPath);
      return {
        name: skillName,
        description: loaded.description,
        invocation: candidate.invocation,
        provider: providerName,
        source: candidate.source,
        resourceBase,
        content: `${loaded.content}\n\n## 当前资源位置（运行时生成）\n\nrunnerPath、runtimePath、parallelTemplateDir已是绝对路径，直接使用；其余relativeToSkillDir项用join(skillDir,相对路径)，不可基于pluginDir拼接。ESM再转file URL；不扫描目录或builder源码，安装资源只读，输出存工作区。\n\n\`\`\`json\n${JSON.stringify(skillResourceLocations(), null, 2)}\n\`\`\`\n\n项目脚本的DSH_SCHEMATIC_PLUGIN_DIR取pluginDir。CLI=${JSON.stringify(paths.kicadCliPath)}。${paths.symbolDir ? `KICAD_SYMBOL_DIR=${JSON.stringify(paths.symbolDir)}。` : '未找到标准符号库；使用项目符号，不猜安装目录；参考符号不代替实际器件和封装。'}`,
      }
    },
  })))
}

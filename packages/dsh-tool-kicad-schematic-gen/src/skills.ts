/** Load the unified module-first schematic design skill from installed assets. */
import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillResourceBase } from '@deepseek-ai/dsh-skill'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { getKiCadPaths } from './runtime-paths.ts'

export const name = 'kicad-schematic-design-skill'
export const inject = ['skills']

const skillName = 'kicad-schematic-design'
const providerName = `bundled:${skillName}`
const directory = fileURLToPath(new URL(`../skills/${skillName}/`, import.meta.url))
const skillFile = new URL(`../skills/${skillName}/SKILL.md`, import.meta.url)

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
        content: `${loaded.content}\n\n## 当前安装路径（运行时生成）\n\n项目脚本设置 DSH_SCHEMATIC_PLUGIN_DIR=${JSON.stringify(fileURLToPath(new URL('../', import.meta.url)))}。CLI=${JSON.stringify(paths.kicadCliPath)}。${paths.symbolDir ? `KICAD_SYMBOL_DIR=${JSON.stringify(paths.symbolDir)}。` : '未找到标准符号库；使用项目符号或配置 KICAD_SYMBOL_DIR。'}`,
      }
    },
  })))
}

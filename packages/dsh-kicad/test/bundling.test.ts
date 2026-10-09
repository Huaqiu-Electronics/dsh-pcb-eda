/**
 * Bundling + packaging (task §16, §23).
 *
 *   artifact -> dsh-kicad
 *   artifact -> skills/<id>/SKILL.md   (every registered bundled skill)
 *
 * These run against the source tree and the manifest, and assert the properties
 * that make the *published tarball* correct: every registered skill directory is
 * shipped, the patch file is shipped and covered, every script the tools
 * reference exists on disk, and nothing points back at the old `kicad-agent`
 * repository (§17).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { KICAD_SCRIPTS } from '../src/scripts.js'
import { KICAD_SCRIPT_SKILL_ID, KICAD_SKILL_IDS, KICAD_SKILLS } from '../src/skills.js'
import { kicadToolNames } from '../src/tools.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const skillsRoot = join(packageRoot, 'skills')
const skillDir = join(skillsRoot, KICAD_SCRIPT_SKILL_ID)

const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  name: string
  version: string
  files: string[]
  dsh?: { bundle?: { patch?: string } }
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
}

describe('package manifest', () => {
  it('is named @huaqiu/<dir> and is a DSH plugin', () => {
    // scripts/check-publish.mjs:58 enforces this naming rule.
    expect(manifest.name).toBe('@huaqiu/dsh-kicad')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(existsSync(join(packageRoot, 'cordis.patch.yml'))).toBe(true)
  })

  it('ships the skill directory in files[]', () => {
    // Without this npm/pnpm strips skills/ and the plugin cannot find SKILL.md
    // at runtime (§15 — the skill must be in the published artifact).
    expect(manifest.files).toContain('skills')
    expect(manifest.files).toContain('lib')
    expect(manifest.files).toContain('cordis.patch.yml')
  })

  it('declares only DSH peer dependencies, never hq-edge (§21)', () => {
    const deps = {
      ...manifest.peerDependencies,
      ...manifest.dependencies,
    }
    for (const key of Object.keys(deps)) {
      expect(key.startsWith('@hqedge/')).toBe(false)
    }
  })

  it('matches the workspace release version', () => {
    const root = JSON.parse(
      readFileSync(resolve(packageRoot, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string }
    expect(manifest.version).toBe(root.version)
  })
})

describe('bundled skills — registry ↔ disk', () => {
  it('ships every registered skill directory', () => {
    for (const id of KICAD_SKILL_IDS) {
      expect(existsSync(join(skillsRoot, id, 'SKILL.md')), `missing skills/${id}/SKILL.md`).toBe(true)
    }
  })

  it('registers every skill directory that ships', () => {
    // The reverse direction: an unregistered directory would ship but never be
    // loaded, which looks like a broken skill rather than a missing entry.
    const onDisk = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(onDisk).toEqual([...KICAD_SKILL_IDS].sort())
  })

  it('gives every skill DSH-discoverable frontmatter whose id matches its directory', () => {
    for (const id of KICAD_SKILL_IDS) {
      const md = readFileSync(join(skillsRoot, id, 'SKILL.md'), 'utf8')
      expect(md.startsWith('---')).toBe(true)
      // DSH ignores a skill without a description, and rejects an id that does
      // not match /^[a-z0-9]+(?:-[a-z0-9]+)*$/.
      expect(md).toMatch(/description:\s*\S/)
      const nameLine = /^name:\s*(\S+)\s*$/m.exec(md)?.[1]
      expect(nameLine, `skills/${id}/SKILL.md declares the wrong name`).toBe(id)
      expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    }
  })

  it('marks exactly one skill as the owner of the tool scripts', () => {
    // The tools resolve scripts through this skill; zero or several owners would
    // make scriptsDir ambiguous.
    const owners = KICAD_SKILL_IDS.filter((id) => KICAD_SKILLS[id]!.ownsScripts)
    expect(owners).toEqual([KICAD_SCRIPT_SKILL_ID])
  })

  it('ships no build junk from the old repository', () => {
    // kicad-agent committed a __pycache__ directory; it must not come across —
    // checked over the whole skills tree, not just the script skill.
    const pycache = execFileSync(
      'find',
      [skillsRoot, '-name', '__pycache__', '-o', '-name', '*.pyc'],
      { encoding: 'utf8' },
    ).trim()
    expect(pycache).toBe('')
  })
})

describe('bundled skill — kicad-ipc (the tool scripts)', () => {
  it('bundles every script the tool registry references', () => {
    for (const script of Object.values(KICAD_SCRIPTS)) {
      const path = join(skillDir, 'scripts', script.file)
      expect(existsSync(path), `missing bundled script ${script.file}`).toBe(true)
    }
  })

  it('ships the progressive-disclosure reference', () => {
    expect(existsSync(join(skillDir, 'references', 'ipc-pcb-workflows.md'))).toBe(true)
  })

  it('documents how it pairs with the tools it ships alongside (§11)', () => {
    // The dsh wrapper: upstream only describes KiCad operating principles, so
    // the section connecting the skill to the registered tools is added here.
    // The table names the shared prefix once per row
    // (`kicad_pcb_create_track` / `create_via` / …), so assert the tool surface
    // rather than every full id.
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
    expect(md).toContain('## 本技能与工具的配合')
    expect(md).toContain('kicad_ipc_diagnose')
    expect(md).toContain('kicad_ipc_verify_live')
    expect(md).toContain('kicad_pcb_create_track')
    expect(md).toContain('kicad_pcb_remove_selected_items')
    // The tools and the skill must agree on the result envelope (§10).
    expect(md).toContain('ok')
    expect(md).toContain('effect')
  })

  it('still documents the operating principles from kicad-agent', () => {
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
    expect(md).toContain('## 基本边界')
    expect(md).toContain('## PCB 对象工作流')
    expect(md).toContain('## 外部 SES 布线结果导入')
    expect(md).toContain('.kicad_pcb')
    expect(md).toContain('pcbnew')
  })
})

describe('bundled skill — hardware-design-brief', () => {
  const briefDir = join(skillsRoot, 'hardware-design-brief')

  it('ships the three progressive-disclosure guides', () => {
    for (const guide of ['mrd-guide.md', 'hardware-prd-guide.md', 'design-brief-guide.md']) {
      expect(existsSync(join(briefDir, 'references', guide)), `missing ${guide}`).toBe(true)
    }
  })

  it('ships the agent interface descriptor', () => {
    expect(existsSync(join(briefDir, 'agents', 'openai.yaml'))).toBe(true)
  })

  it('registers as a skill without owning the tool scripts', () => {
    // Knowledge-only: it contributes prompting/structure, not executables, so it
    // must not carry scripts/ — that would imply a second script root.
    expect(KICAD_SKILLS['hardware-design-brief']?.ownsScripts).toBe(false)
    expect(existsSync(join(briefDir, 'scripts'))).toBe(false)
  })

  it('keeps the upstream requirement workflow intact', () => {
    const md = readFileSync(join(briefDir, 'SKILL.md'), 'utf8')
    expect(md).toContain('## 文档位置与关系')
    expect(md).toContain('## 对话与生成')
    expect(md).toContain('docs/01-MRD.md')
  })

  it('documents how it pairs with the KiCad skill and tools (dsh wrapper)', () => {
    const md = readFileSync(join(briefDir, 'SKILL.md'), 'utf8')
    expect(md).toContain('## 本技能与同包能力的配合')
    expect(md).toContain('kicad-ipc')
  })
})

describe('upstream lockstep with kicad-agent', () => {
  // The two trees are meant to be byte-identical for every skill that ALSO
  // lives upstream: `kicad-agent` was made to adopt the English scripts, the
  // `kicad-ipc` rename and the dsh wrapper sections, so an upstream update is
  // a plain `cp -r` instead of a manual zh->en re-merge. Skills added locally
  // that upstream does not have (e.g. `pcb-initial-placement`) are exempt from
  // the byte-identical guard — there is nothing upstream to diverge from.
  //
  // Optional by necessity: CI clones dsh-pcb-eda alone (`.github/workflows/ci.yml`),
  // so there is nothing to compare against there. Locally the sibling checkout
  // is normally present and the guard runs. `KICAD_AGENT_ROOT` matches the
  // `HQ_EDGE_ROOT` convention used by scripts/generate-analytics-tools.mjs.
  const upstreamSkills =
    process.env.KICAD_AGENT_ROOT ??
    resolve(packageRoot, '..', '..', '..', 'kicad-agent', 'skills')
  const hasUpstream = existsSync(upstreamSkills)
  /** Bundled skills that also exist upstream — the only ones lockstep applies to. */
  const sharedSkills = hasUpstream
    ? KICAD_SKILL_IDS.filter((id) => existsSync(join(upstreamSkills, id)))
    : []

  it.skipIf(!hasUpstream)('is byte-identical to the upstream checkout for every shared skill', () => {
    expect(sharedSkills.length, 'no bundled skill is present upstream — lockstep has nothing to guard').toBeGreaterThan(0)
    for (const id of sharedSkills) {
      const diff = diffTrees(join(upstreamSkills, id), join(skillsRoot, id))
      expect(diff, `skills/${id} diverged from upstream — re-run the sync`).toBe('')
    }
  })

  it.skipIf(!hasUpstream)('deploys every upstream skill downstream', () => {
    // Upstream directories must all be registered (or they silently never
    // reach the published bundle); locally-added skills may exceed the set.
    const upstream = readdirSync(upstreamSkills, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    for (const id of upstream) {
      expect(KICAD_SKILL_IDS, `upstream skill ${id} not registered in src/skills.ts`).toContain(id)
    }
    expect([...KICAD_SKILL_IDS].sort()).toEqual([...new Set([...upstream, ...KICAD_SKILL_IDS])].sort())
  })
})

describe('no dependency on the old kicad-agent repository (§17)', () => {
  it('contains no reference to the old repository path', () => {
    // Provenance comments may still say "kicad-agent" — what §17 forbids is a
    // build/runtime dependency on the old checkout, i.e. a path reference.
    // Scanned over the shipped content only (the test files name the path as
    // the thing they are asserting the absence of).
    const hits = grepFiles(['/Users/admin/code/kicad-agent', join(packageRoot, 'src'), skillsRoot])
    expect(hits).toEqual([])
  })

  it('contains no absolute developer paths in source or skill files', () => {
    const hits = grepFiles(['/Users/admin/code/', join(packageRoot, 'src'), skillsRoot])
    expect(hits).toEqual([])
  })

  it('uses no path-based, symlink or file: dependency on the old repo', () => {
    const allDeps = {
      ...manifest.peerDependencies,
      ...manifest.dependencies,
    }
    for (const range of Object.values(allDeps)) {
      expect(range).not.toMatch(/kicad-agent/)
      expect(range).not.toMatch(/^file:|^link:/)
    }
  })
})

/**
 * `diff -r` over two trees, returning the reported differences as text.
 *
 * Returns `''` when the trees are identical. diff exits 1 when they differ and
 * 2 on a real error, so the exit status disambiguates "different" from "failed".
 */
function diffTrees(upstream: string, mine: string): string {
  try {
    return execFileSync('diff', ['-r', upstream, mine], { encoding: 'utf8' }).trim()
  } catch (err) {
    const failure = err as NodeJS.ErrnoException & { status?: number; stdout?: string }
    if (failure.status === 1) return String(failure.stdout ?? '').trim()
    throw err
  }
}

/**
 * `grep -rl` over a path list.
 *
 * Returns an empty array when nothing matches — grep exits 1 in that case, so
 * the non-zero status is the success signal here.
 */
function grepFiles(args: string[]): string[] {
  try {
    return execFileSync('grep', ['-rl', ...args], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException & { status?: number }).status === 1) return []
    throw err
  }
}

describe('tool registry consistency', () => {
  it('exposes one tool per bundled script (§10 — 1:1 preserve mapping)', () => {
    expect(kicadToolNames()).toHaveLength(Object.keys(KICAD_SCRIPTS).length)
  })
})

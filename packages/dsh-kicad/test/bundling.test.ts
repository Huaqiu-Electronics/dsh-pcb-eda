/**
 * Bundling + packaging (task §16, §23).
 *
 *   artifact -> dsh-kicad
 *   artifact -> kicad-ipc/SKILL.md
 *
 * These run against the source tree and the manifest, and assert the properties
 * that make the *published tarball* correct: the skill directory is shipped, the
 * patch file is shipped and covered, every script the tools reference exists on
 * disk, and nothing points back at the old `kicad-agent` repository (§17).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { KICAD_SCRIPTS, KICAD_SKILL_NAME } from '../src/scripts.js'
import { kicadToolNames } from '../src/tools.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const skillDir = join(packageRoot, 'skills', KICAD_SKILL_NAME)

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

describe('bundled skill', () => {
  it('has a SKILL.md with DSH-discoverable frontmatter', () => {
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
    expect(md.startsWith('---')).toBe(true)
    expect(md).toContain(`name: ${KICAD_SKILL_NAME}`)
    expect(md).toMatch(/description:\s*\S/)
  })

  it('declares a skill id that matches its directory name', () => {
    // dsh-plugin-scout's convention; also what makes the id stable in the catalog.
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
    const nameLine = /^name:\s*(\S+)\s*$/m.exec(md)?.[1]
    expect(nameLine).toBe(KICAD_SKILL_NAME)
  })

  it('bundles every script the tool registry references', () => {
    for (const script of Object.values(KICAD_SCRIPTS)) {
      const path = join(skillDir, 'scripts', script.file)
      expect(existsSync(path), `missing bundled script ${script.file}`).toBe(true)
    }
  })

  it('ships no build junk from the old repository', () => {
    // kicad-agent committed a __pycache__ directory; it must not come across.
    expect(existsSync(join(skillDir, 'scripts', '__pycache__'))).toBe(false)
    const pycache = execFileSync(
      'find',
      [skillDir, '-name', '__pycache__', '-o', '-name', '*.pyc'],
      { encoding: 'utf8' },
    ).trim()
    expect(pycache).toBe('')
  })

  it('ships the progressive-disclosure reference', () => {
    expect(existsSync(join(skillDir, 'references', 'ipc-pcb-workflows.md'))).toBe(true)
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

describe('no dependency on the old kicad-agent repository (§17)', () => {
  it('contains no reference to the old repository path', () => {
    // Provenance comments may still say "kicad-agent" — what §17 forbids is a
    // build/runtime dependency on the old checkout, i.e. a path reference.
    // Scanned over the shipped content only (the test files name the path as
    // the thing they are asserting the absence of).
    const hits = grepFiles(['/Users/admin/code/kicad-agent', join(packageRoot, 'src'), skillDir])
    expect(hits).toEqual([])
  })

  it('contains no absolute developer paths in source or skill files', () => {
    const hits = grepFiles(['/Users/admin/code/', join(packageRoot, 'src'), skillDir])
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

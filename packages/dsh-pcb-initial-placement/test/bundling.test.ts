/**
 * Packaging tests: the skill tree must actually ship, and the plugin must stay
 * independent of `@huaqiu/dsh-kicad` (the package it was extracted from).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const skillsRoot = join(packageRoot, 'skills')
const skillDir = join(skillsRoot, 'pcb-initial-placement')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  name: string
  version: string
  files?: string[]
  dsh?: { bundle?: { patch?: string } }
  dependencies?: Record<string, string>
}

describe('bundled skill tree', () => {
  it('ships SKILL.md with frontmatter naming the skill', () => {
    const md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
    expect(md.startsWith('---')).toBe(true)
    expect(md).toContain('name: pcb-initial-placement')
    expect(md).toContain('## 与 kicad-ipc 的关系')
  })

  it('ships the progressive-disclosure resources the skill references', () => {
    expect(existsSync(join(skillDir, 'references', 'algorithm.md'))).toBe(true)
    expect(existsSync(join(skillDir, 'agents', 'openai.yaml'))).toBe(true)
  })

  it('ships every Python helper the workflow runs', () => {
    for (const script of [
      'apply_via_ipc.py',
      'board_geometry.py',
      'pack.py',
      'pose_table.py',
      'verify_placement.py',
      'write_board_file.py',
    ]) {
      expect(existsSync(join(skillDir, 'scripts', script)), `missing ${script}`).toBe(true)
    }
  })

  it('is the only skill in this package (one row, one skill)', () => {
    const skillDirs = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    expect(skillDirs).toEqual(['pcb-initial-placement'])
  })
})

describe('packaging manifest', () => {
  it('ships skills/ and the bundle patch in the tarball', () => {
    expect(manifest.files).toContain('skills')
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(existsSync(join(packageRoot, manifest.dsh!.bundle!.patch!))).toBe(true)
  })

  it('does not depend on @huaqiu/dsh-kicad (the split must be real)', () => {
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@huaqiu/dsh-kicad')
  })

  it('keeps the workspace lockstep version', () => {
    expect(manifest.version).toBe('0.7.17')
  })
})

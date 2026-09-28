import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { HQSCH_SKILL_NAME } from '../src/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const skillDir = join(packageRoot, 'skills', HQSCH_SKILL_NAME)

const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  name: string
  version: string
  files: string[]
  dsh?: { bundle?: { patch?: string } }
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
}

describe('package manifest', () => {
  it('is named @huaqiu/dsh-hqsch and is a DSH plugin', () => {
    expect(manifest.name).toBe('@huaqiu/dsh-hqsch')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(existsSync(join(packageRoot, 'cordis.patch.yml'))).toBe(true)
  })

  it('ships the skill directory in files[]', () => {
    expect(manifest.files).toContain('skills')
    expect(manifest.files).toContain('lib')
    expect(manifest.files).toContain('cordis.patch.yml')
  })

  it('does not declare @hqedge runtime dependencies', () => {
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
    expect(md).toContain(`name: ${HQSCH_SKILL_NAME}`)
    expect(md).toMatch(/description:\s*\S/)
  })

  it('ships the scenario-b prompt, docs and template entrypoints', () => {
    expect(existsSync(join(skillDir, 'SYSTEM-PROMPT.md'))).toBe(true)
    expect(existsSync(join(skillDir, 'docs', 'reading-a-circuit.md'))).toBe(true)
    expect(existsSync(join(skillDir, 'docs', 'editing-a-circuit.md'))).toBe(true)
    expect(existsSync(join(skillDir, 'template', 'package.json'))).toBe(true)
    expect(existsSync(join(skillDir, 'template', 'scripts', 'hello.ts'))).toBe(true)
  })

  it('keeps the scenario-b operating rules intact', () => {
    const systemPrompt = readFileSync(join(skillDir, 'SYSTEM-PROMPT.md'), 'utf8')
    expect(systemPrompt).toContain('流程 A')
    expect(systemPrompt).toContain('流程 B')
    expect(systemPrompt).toContain('流程 C')
    expect(systemPrompt).toContain('npx tsx scripts/')
  })
})

describe('packaged content boundaries', () => {
  it('contains no absolute checkout paths in source or bundled skill files', () => {
    const hits = grepFiles([packageRoot], /E:\\github\\|\/Users\/admin\/code\//)
    expect(hits).toEqual([])
  })
})

function grepFiles(roots: string[], pattern: RegExp): string[] {
  const hits: string[] = []
  for (const root of roots) {
    walk(root, hits, pattern)
  }
  return hits
}

function walk(path: string, hits: string[], pattern: RegExp): void {
  if (path.includes(`${join('node_modules')}`) || path.includes(`${join('lib')}`)) return
  const stat = statSync(path)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      walk(join(path, entry), hits, pattern)
    }
    return
  }
  if (!/\.(json|md|ts|yml|yaml)$/.test(path)) return
  const content = readFileSync(path, 'utf8')
  if (pattern.test(content)) hits.push(path)
}

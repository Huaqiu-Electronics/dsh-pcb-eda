import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HardwareArtifactService } from '../src/service.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hw-artifacts-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(relative: string, content = ''): string {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return path
}

function fakeKicad(): string {
  const app = join(root, 'KiCad.app')
  write('KiCad.app/Contents/MacOS/kicad-cli', '')
  write('KiCad.app/Contents/MacOS/kicad', '')
  write('KiCad.app/Contents/Applications/eeschema.app/Contents/MacOS/eeschema', '')
  write('KiCad.app/Contents/Applications/pcbnew.app/Contents/MacOS/pcbnew', '')
  return app
}

describe('deterministic discovery', () => {
  it('resolves one unambiguous project and keeps source identities', () => {
    write('main.kicad_pro', '{}')
    write('main.kicad_sch')
    write('sheet1.kicad_sch')
    write('main.kicad_pcb')
    write('mech/assembly.step')

    const result = new HardwareArtifactService().discover(root)
    expect(result.issue).toBeUndefined()
    expect(result.selected?.schematic?.path).toBe(join(root, 'main.kicad_sch'))
    expect(result.selected?.sheets.map(sheet => sheet.path)).toEqual([join(root, 'sheet1.kicad_sch')])
    expect(result.selected?.sheets[0]?.sourcePath).toBe(join(root, 'main.kicad_sch'))
    expect(result.selected?.bom?.sourcePath).toBe(join(root, 'main.kicad_sch'))
    expect(result.selected?.pcb3d?.sourcePath).toBe(join(root, 'main.kicad_pcb'))
    expect(result.selected?.mechanical.map(model => model.path)).toEqual([join(root, 'mech/assembly.step')])
  })

  it('requires explicit selection for multiple projects', () => {
    write('a.kicad_pro', '{}')
    write('b.kicad_pro', '{}')
    const result = new HardwareArtifactService().discover(root)
    expect(result.issue?.code).toBe('selection-required')
    expect(result.projects).toHaveLength(2)
  })

  it('requires explicit board selection and never takes the first board', () => {
    write('main.kicad_pro', '{}')
    write('main.kicad_sch')
    write('power.kicad_pcb')
    write('main.kicad_pcb')
    const result = new HardwareArtifactService().discover(root)
    expect(result.issue?.code).toBe('selection-required')
    expect(result.selected?.boards.map(board => board.path)).toEqual([
      join(root, 'main.kicad_pcb'),
      join(root, 'power.kicad_pcb'),
    ])
  })

  it('honours an explicit manifest without creating it', () => {
    write('custom.pro', '{}')
    write('root_sch.kicad_sch')
    write('board_a.kicad_pcb')
    write('mech/case.step')
    write('.hardware-engineering.json', JSON.stringify({
      project: 'custom.pro',
      schematic: 'root_sch.kicad_sch',
      boards: [{ id: 'a', path: 'board_a.kicad_pcb' }],
      mechanical: [{ id: 'case', path: 'mech/case.step' }],
    }))

    const result = new HardwareArtifactService().discover(root)
    expect(result.manifestPath).toBe(join(root, '.hardware-engineering.json'))
    expect(result.issue).toBeUndefined()
    expect(result.selected?.path).toBe(join(root, 'custom.pro'))
    expect(result.selected?.schematic?.path).toBe(join(root, 'root_sch.kicad_sch'))
    expect(result.selected?.boards[0]?.id).toBe(`pcb:${join(root, 'board_a.kicad_pcb')}`)
  })

  it('excludes build and archive folders from default discovery', () => {
    write('main.kicad_pro', '{}')
    write('dist/old.kicad_pcb')
    write('backup/copy.kicad_pcb')
    const result = new HardwareArtifactService().discover(root)
    expect(result.selected?.boards).toEqual([])
  })
})

describe('installation resolution and agent context', () => {
  it('resolves KiCad CLI and editors from one root, and reports missing SolidCraft', () => {
    const app = fakeKicad()
    const service = new HardwareArtifactService({
      kicadRoot: app,
      probeVersion: () => '10.0.7',
    })
    const installed = service.installations()
    expect(installed.kicad).toMatchObject({
      configured: true,
      version: '10.0.7',
      cli: join(app, 'Contents/MacOS/kicad-cli'),
      pcbEditor: join(app, 'Contents/Applications/pcbnew.app/Contents/MacOS/pcbnew'),
      schematicEditor: join(app, 'Contents/Applications/eeschema.app/Contents/MacOS/eeschema'),
    })
    expect(installed.solidcraft.configured).toBe(false)
    const text = service.environmentText()
    expect(text).toContain('<hardware_environment>')
    expect(text).toContain('configured: true')
    expect(text).toContain('configured: false')
    expect(text).toContain(join(app, 'Contents/MacOS/kicad-cli'))
  })

  it('passes validated paths only through scoped child env', () => {
    const app = fakeKicad()
    const service = new HardwareArtifactService({ kicadRoot: app, probeVersion: () => '10.0.7' })
    expect(service.childEnvironment()).toEqual({
      HUAQIU_KICAD_CLI: join(app, 'Contents/MacOS/kicad-cli'),
      HUAQIU_KICAD_PCBNEW: join(app, 'Contents/Applications/pcbnew.app/Contents/MacOS/pcbnew'),
      HUAQIU_KICAD_EESCHEMA: join(app, 'Contents/Applications/eeschema.app/Contents/MacOS/eeschema'),
    })
  })
})

describe('native launch', () => {
  it('opens the exact selected schematic with no shell', () => {
    const app = fakeKicad()
    const sch = write('main.kicad_sch')
    const calls: { command: string; args: readonly string[]; options: unknown }[] = []
    const service = new HardwareArtifactService({
      kicadRoot: app,
      probeVersion: () => '10.0.7',
      spawnProcess: (command, args, options) => {
        calls.push({ command, args, options })
        return { pid: 4242 }
      },
    })
    expect(service.open({ application: 'kicad', artifactPath: sch, kind: 'schematic' })).toEqual({
      launched: true,
      command: join(app, 'Contents/Applications/eeschema.app/Contents/MacOS/eeschema'),
      args: [sch],
      cwd: root,
      pid: 4242,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options).toMatchObject({ cwd: root, detached: true, stdio: 'ignore', shell: false })
  })

  it('refuses a missing or unsupported artifact', () => {
    const app = fakeKicad()
    const service = new HardwareArtifactService({ kicadRoot: app, probeVersion: () => '10.0.7' })
    expect(() => service.open({ application: 'kicad', artifactPath: join(root, 'nope.kicad_pcb'), kind: 'pcb' }))
      .toThrow(/does not exist/)
    const txt = write('notes.txt')
    expect(() => service.open({ application: 'kicad', artifactPath: txt, kind: 'schematic' }))
      .toThrow(/unsupported KiCad artifact/)
  })

  it('reports SolidCraft as unconfigured rather than guessing an executable', () => {
    const model = write('case.step')
    const service = new HardwareArtifactService()
    expect(() => service.open({ application: 'solidcraft', artifactPath: model, kind: 'mechanical-3d' }))
      .toThrow(/SolidCraft is not configured/)
  })
})

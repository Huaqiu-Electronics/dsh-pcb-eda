import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HardwareArtifactService, groupBomRows, parseCsv } from '../src/service.js'

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

const IS_WINDOWS = process.platform === 'win32'

/** Install a fake KiCad tree in the layout this host platform resolves. */
function fakeKicad(): { root: string; cli: string; eeschema: string; pcbnew: string } {
  if (process.platform === 'darwin') {
    const app = join(root, 'KiCad.app')
    const cli = write('KiCad.app/Contents/MacOS/kicad-cli', '')
    write('KiCad.app/Contents/MacOS/kicad', '')
    const eeschema = write('KiCad.app/Contents/Applications/eeschema.app/Contents/MacOS/eeschema', '')
    const pcbnew = write('KiCad.app/Contents/Applications/pcbnew.app/Contents/MacOS/pcbnew', '')
    return { root: app, cli, eeschema, pcbnew }
  }
  const suffix = IS_WINDOWS ? '.exe' : ''
  const installRoot = join(root, 'kicad')
  const cli = write(join('kicad', 'bin', `kicad-cli${suffix}`), '')
  write(join('kicad', 'bin', `kicad${suffix}`), '')
  const eeschema = write(join('kicad', 'bin', `eeschema${suffix}`), '')
  const pcbnew = write(join('kicad', 'bin', `pcbnew${suffix}`), '')
  return { root: installRoot, cli, eeschema, pcbnew }
}

function sheet(file: string, name = file): string {
  return `  (sheet (at 10 10) (size 20 20) (uuid "0000") (property "Sheetname" "${name}") (property "Sheetfile" "${file}"))\n`
}

function schematic(children: readonly string[] = []): string {
  return `(kicad_sch (version 20231120)\n${children.map(child => sheet(child)).join('')})\n`
}

describe('deterministic discovery', () => {
  it('resolves one unambiguous project and keeps source identities', () => {
    write('main.kicad_pro', '{}')
    write('main.kicad_sch', schematic([]))
    write('main.kicad_pcb')
    write('mech/assembly.step')

    const result = new HardwareArtifactService().discover(root)
    expect(result.issue).toBeUndefined()
    expect(result.selected?.schematic?.path).toBe(join(root, 'main.kicad_sch'))
    expect(result.selected?.rootSheet?.path).toBe(join(root, 'main.kicad_sch'))
    expect(result.selected?.sheets).toEqual([])
    expect(result.selected?.bom?.sourcePath).toBe(join(root, 'main.kicad_sch'))
    expect(result.selected?.pcb3d?.sourcePath).toBe(join(root, 'main.kicad_pcb'))
    expect(result.selected?.defaultBoard).toBe(join(root, 'main.kicad_pcb'))
    expect(result.selected?.mechanical.map(model => model.path)).toEqual([join(root, 'mech/assembly.step')])
  })

  it('resolves the child hierarchy from sheet references and ignores unrelated siblings', () => {
    write('main.kicad_pro', '{}')
    write('main.kicad_sch', schematic(['sub/power.kicad_sch', 'sub/mcu.kicad_sch']))
    write('sub/power.kicad_sch', schematic(['regulator.kicad_sch']))
    write('sub/regulator.kicad_sch', schematic([]))
    write('sub/mcu.kicad_sch', schematic([]))
    write('unrelated.kicad_sch', schematic([]))

    const result = new HardwareArtifactService().discover(root)
    const sheets = (result.selected?.sheets ?? []).map(sheet => sheet.path)
    expect(sheets).toEqual([
      join(root, 'sub/mcu.kicad_sch'),
      join(root, 'sub/power.kicad_sch'),
      join(root, 'sub/regulator.kicad_sch'),
    ])
    expect(sheets).not.toContain(join(root, 'unrelated.kicad_sch'))
    expect(result.selected?.selectionRequired).toBe(false)
  })

  it('tolerates a cyclic sheet reference instead of recursing forever', () => {
    write('main.kicad_pro', '{}')
    write('main.kicad_sch', schematic(['a.kicad_sch']))
    write('a.kicad_sch', schematic(['main.kicad_sch', 'b.kicad_sch']))
    write('b.kicad_sch', schematic([]))
    const result = new HardwareArtifactService().discover(root)
    expect((result.selected?.sheets ?? []).map(sheet => sheet.path)).toEqual([
      join(root, 'a.kicad_sch'),
      join(root, 'b.kicad_sch'),
    ])
  })

  it('requires explicit selection for multiple projects', () => {
    write('a.kicad_pro', '{}')
    write('b.kicad_pro', '{}')
    const result = new HardwareArtifactService().discover(root)
    expect(result.issue?.code).toBe('selection-required')
    expect(result.projects).toHaveLength(2)
  })

  it('ranks a project-owned board ahead of an unrelated neighbour', () => {
    write('main.kicad_pro', '{}')
    write('main.kicad_sch', schematic([]))
    write('power.kicad_pcb')
    write('main.kicad_pcb')
    const result = new HardwareArtifactService().discover(root)
    expect(result.selected?.boards.map(board => board.path)).toEqual([
      join(root, 'main.kicad_pcb'),
      join(root, 'power.kicad_pcb'),
    ])
    expect(result.selected?.defaultBoard).toBe(join(root, 'main.kicad_pcb'))
    expect(result.issue).toBeUndefined()
  })

  it('requires explicit board selection when no candidate is demonstrably owned', () => {
    write('board.kicad_pro', '{}')
    write('board.kicad_sch', schematic([]))
    write('alpha.kicad_pcb')
    write('beta.kicad_pcb')
    const result = new HardwareArtifactService().discover(root)
    expect(result.issue?.code).toBe('selection-required')
    expect(result.selected?.defaultBoard).toBeUndefined()
    expect(result.selected?.boards.map(board => board.path)).toEqual([
      join(root, 'alpha.kicad_pcb'),
      join(root, 'beta.kicad_pcb'),
    ])
  })

  it('honours an explicit manifest without creating it', () => {
    write('custom.pro', '{}')
    write('root_sch.kicad_sch', schematic([]))
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
    expect(result.selected?.defaultBoard).toBe(join(root, 'board_a.kicad_pcb'))
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
    const service = new HardwareArtifactService({ kicadRoot: app.root, probeVersion: () => '10.0.7' })
    const installed = service.installations()
    expect(installed.kicad).toMatchObject({
      configured: true,
      version: '10.0.7',
      cli: app.cli,
      pcbEditor: app.pcbnew,
      schematicEditor: app.eeschema,
    })
    expect(installed.solidcraft.configured).toBe(false)
    const text = service.environmentText()
    expect(text).toContain('<hardware_environment>')
    expect(text).toContain('configured: true')
    expect(text).toContain('configured: false')
    expect(text).toContain(app.cli)
  })

  it('passes validated paths only through scoped child env', () => {
    const app = fakeKicad()
    const service = new HardwareArtifactService({ kicadRoot: app.root, probeVersion: () => '10.0.7' })
    expect(service.childEnvironment()).toEqual({
      HUAQIU_KICAD_CLI: app.cli,
      HUAQIU_KICAD_PCBNEW: app.pcbnew,
      HUAQIU_KICAD_EESCHEMA: app.eeschema,
    })
  })

  it('does not report an executable that failed validation', () => {
    const app = fakeKicad()
    const service = new HardwareArtifactService({ kicadRoot: app.root, probeVersion: () => undefined })
    expect(service.installations().kicad.configured).toBe(false)
    expect(service.environmentText()).toContain('did not answer a version probe')
  })
})

describe('native launch', () => {
  it('opens the exact selected schematic with no shell', () => {
    const app = fakeKicad()
    const sch = write('main.kicad_sch', schematic([]))
    const calls: { command: string; args: readonly string[]; options: unknown }[] = []
    const service = new HardwareArtifactService({
      kicadRoot: app.root,
      probeVersion: () => '10.0.7',
      spawnProcess: (command, args, options) => {
        calls.push({ command, args, options })
        return { pid: 4242 }
      },
    })
    expect(service.open({ application: 'kicad', artifactPath: sch, kind: 'schematic' })).toEqual({
      launched: true,
      command: app.eeschema,
      args: [sch],
      cwd: root,
      pid: 4242,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options).toMatchObject({ cwd: root, detached: true, stdio: 'ignore', shell: false })
  })

  it('opens the exact selected PCB for the 3D destination', () => {
    const app = fakeKicad()
    const board = write('main.kicad_pcb', '(kicad_pcb)')
    const calls: readonly string[][] = []
    const service = new HardwareArtifactService({
      kicadRoot: app.root,
      probeVersion: () => '10.0.7',
      spawnProcess: (_command, args) => {
        (calls as string[][]).push([...args])
        return { pid: 7 }
      },
    })
    service.open({ application: 'kicad', artifactPath: board, kind: 'pcb-3d' })
    expect(calls).toEqual([[board]])
  })

  it('refuses a missing or unsupported artifact', () => {
    const app = fakeKicad()
    const service = new HardwareArtifactService({ kicadRoot: app.root, probeVersion: () => '10.0.7' })
    expect(() => service.open({ application: 'kicad', artifactPath: join(root, 'nope.kicad_pcb'), kind: 'pcb' }))
      .toThrow(/does not exist/)
    const txt = write('notes.txt')
    expect(() => service.open({ application: 'kicad', artifactPath: txt, kind: 'schematic' }))
      .toThrow(/unsupported KiCad artifact/)
  })

  it('reports an unconfigured installation rather than guessing a binary', () => {
    const sch = write('main.kicad_sch', schematic([]))
    const service = new HardwareArtifactService()
    expect(() => service.open({ application: 'kicad', artifactPath: sch, kind: 'schematic' }))
      .toThrow(/no editor/)
  })
})

describe('authorized source reads', () => {
  it('returns saved text with a content revision', async () => {
    const sch = write('main.kicad_sch', schematic([]))
    const service = new HardwareArtifactService()
    const result = await service.readSource({ artifactPath: sch, roots: [root] })
    expect(result.kind).toBe('schematic')
    expect(result.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(result.text).toContain('kicad_sch')
    expect(result.bytes).toBe(Buffer.byteLength(result.text))
  })

  it('rejects paths outside the authorized workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'hw-outside-'))
    try {
      const sch = join(outside, 'other.kicad_sch')
      writeFileSync(sch, schematic([]))
      const service = new HardwareArtifactService()
      await expect(service.readSource({ artifactPath: sch, roots: [root] }))
        .rejects.toMatchObject({ code: 'unauthorized', status: 403 })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects traversal and relative identities', async () => {
    const service = new HardwareArtifactService()
    await expect(service.readSource({ artifactPath: '../escape.kicad_sch', roots: [root] }))
      .rejects.toMatchObject({ code: 'invalid-identity', status: 400 })
    await expect(service.readSource({ artifactPath: join(root, '..', 'escape.kicad_sch'), roots: [root] }))
      .rejects.toMatchObject({ code: 'unauthorized', status: 403 })
  })

  it('rejects a symlink that escapes the workspace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'hw-link-'))
    try {
      const target = join(outside, 'secret.kicad_sch')
      writeFileSync(target, schematic([]))
      const link = join(root, 'linked.kicad_sch')
      try {
        symlinkSync(target, link, 'file')
      } catch {
        return // Windows without Developer Mode: symlinks unavailable, nothing to assert
      }
      const service = new HardwareArtifactService()
      await expect(service.readSource({ artifactPath: link, roots: [root] }))
        .rejects.toMatchObject({ code: 'unauthorized', status: 403 })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('rejects unsupported file types and oversized sources', async () => {
    const txt = write('notes.txt', 'hello')
    const service = new HardwareArtifactService()
    await expect(service.readSource({ artifactPath: txt, roots: [root] }))
      .rejects.toMatchObject({ code: 'unsupported-artifact', status: 415 })

    const big = write('big.kicad_sch', 'x'.repeat(64))
    const limited = new HardwareArtifactService({ maxSourceBytes: 32 })
    await expect(limited.readSource({ artifactPath: big, roots: [root] }))
      .rejects.toMatchObject({ code: 'too-large', status: 413 })
  })

  it('rejects a stale expected revision', async () => {
    const sch = write('main.kicad_sch', schematic([]))
    const service = new HardwareArtifactService()
    const first = await service.readSource({ artifactPath: sch, roots: [root] })
    await expect(service.readSource({ artifactPath: sch, roots: [root], expectedRevision: 'deadbeef' }))
      .rejects.toMatchObject({ code: 'stale-revision', status: 409 })
    const second = await service.readSource({ artifactPath: sch, roots: [root], expectedRevision: first.revision })
    expect(second.revision).toBe(first.revision)
  })
})

describe('pcb glb export', () => {
  const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(8, 1)])

  function serviceWithCli(runCommand: (
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
  ) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>): HardwareArtifactService {
    const app = fakeKicad()
    return new HardwareArtifactService({
      kicadRoot: app.root,
      probeVersion: () => '10.0.7',
      cacheRoot: join(root, '.cache'),
      runCommand: async (command, args, options) => {
        const output = args[args.indexOf('--output') + 1]
        const result = await runCommand(command, args, options)
        // A successful fake CLI must leave a valid GLB behind, as kicad-cli does.
        if (output !== undefined && result.exitCode === 0 && !existsSync(output)) {
          writeFileSync(output, GLB)
        }
        return result
      },
    })
  }

  it('exports the selected board with explicit argv and publishes atomically', async () => {
    const board = write('main.kicad_pcb', '(kicad_pcb (version 20231120))')
    const calls: { command: string; args: readonly string[]; cwd: string }[] = []
    const service = serviceWithCli(async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd })
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    })
    const result = await service.exportGlb({ artifactPath: board, roots: [root] })
    expect(result.cached).toBe(false)
    expect(result.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toHaveLength(6)
    expect(calls[0]?.args.slice(0, 3)).toEqual(['pcb', 'export', 'glb'])
    expect(calls[0]?.args[calls[0].args.length - 1]).toBe(board)
    expect(calls[0]?.args[calls[0].args.indexOf('--output') + 1]).toMatch(/\.glb$/u)
    expect(calls[0]?.cwd).toBe(root)
    expect(service.glbFile(board, result.revision)).toBe(result.file)
  })

  it('invalidates the cache when board content changes', async () => {
    const board = write('main.kicad_pcb', '(kicad_pcb (version 20231120))')
    let runs = 0
    const service = serviceWithCli(async () => {
      runs += 1
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    })
    await service.exportGlb({ artifactPath: board, roots: [root] })
    await service.exportGlb({ artifactPath: board, roots: [root] })
    expect(runs).toBe(1)
    // Same size, same second: only the content hash can tell them apart.
    writeFileSync(board, '(kicad_pcb (version 20231121))')
    const after = await service.exportGlb({ artifactPath: board, roots: [root] })
    expect(runs).toBe(2)
    expect(after.cached).toBe(false)
  })

  it('shares one export between concurrent callers', async () => {
    const board = write('main.kicad_pcb', '(kicad_pcb)')
    let runs = 0
    const service = serviceWithCli(async () => {
      runs += 1
      await new Promise(resolve => setTimeout(resolve, 20))
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    })
    const [left, right] = await Promise.all([
      service.exportGlb({ artifactPath: board, roots: [root] }),
      service.exportGlb({ artifactPath: board, roots: [root] }),
    ])
    expect(runs).toBe(1)
    expect(left.revision).toBe(right.revision)
  })

  it('reports a timeout and leaves no partial output', async () => {
    const board = write('main.kicad_pcb', '(kicad_pcb)')
    const service = serviceWithCli(async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }))
    await expect(service.exportGlb({ artifactPath: board, roots: [root] }))
      .rejects.toMatchObject({ code: 'export-timeout', status: 504 })
    expect(() => service.glbFile(board, 'anything')).toThrowError(/not available/)
  })

  it('reports a CLI failure without publishing the result', async () => {
    const board = write('main.kicad_pcb', '(kicad_pcb)')
    const service = serviceWithCli(async () => ({ exitCode: 3, stdout: '', stderr: 'unsupported board', timedOut: false }))
    await expect(service.exportGlb({ artifactPath: board, roots: [root] }))
      .rejects.toMatchObject({ code: 'export-failed', status: 502 })
  })

  it('rejects an unconfigured CLI instead of falling back to PATH', async () => {
    const board = write('main.kicad_pcb', '(kicad_pcb)')
    const service = new HardwareArtifactService({ cacheRoot: join(root, '.cache') })
    await expect(service.exportGlb({ artifactPath: board, roots: [root] }))
      .rejects.toMatchObject({ code: 'not-configured', status: 412 })
  })

  it('rejects a non-board artifact', async () => {
    const sch = write('main.kicad_sch', schematic([]))
    const service = serviceWithCli(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }))
    await expect(service.exportGlb({ artifactPath: sch, roots: [root] }))
      .rejects.toMatchObject({ code: 'unsupported-artifact', status: 415 })
  })
})

describe('bom projection', () => {
  const csv = [
    '"Reference","Value","Footprint","MPN","DNP"',
    '"R1","10k","Resistor_SMD:R_0603_1608Metric","RC0603FR-0710KL",""',
    '"R2","10k","Resistor_SMD:R_0603_1608Metric","RC0603FR-0710KL",""',
    '"R3","10k","Resistor_SMD:R_0603_1608Metric","RC0603-OTHER",""',
    '"U1","STM32F103","Package_QFP:LQFP-48_7x7mm_P0.5mm","STM32F103C8T6","DNP"',
    '"C1","100n","Capacitor_SMD:C_0603_1608Metric","GRM188R71C104KA01D",""',
  ].join('\r\n')

  function serviceWithBomCli(): HardwareArtifactService {
    const app = fakeKicad()
    return new HardwareArtifactService({
      kicadRoot: app.root,
      probeVersion: () => '10.0.7',
      cacheRoot: join(root, '.cache'),
      runCommand: async (_command, args) => {
        const output = args[args.indexOf('--output') + 1]
        if (output !== undefined) writeFileSync(output, csv)
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })
  }

  it('groups by value, footprint, MPN and DNP without merging distinct parts', () => {
    const rows = groupBomRows(parseCsv(csv))
    expect(rows).toHaveLength(4)
    const resistor = rows.find(row => row.references.includes('R1'))
    expect(resistor?.quantity).toBe(2)
    expect(resistor?.references).toEqual(['R1', 'R2'])
    expect(resistor?.fields.MPN).toBe('RC0603FR-0710KL')
    const variant = rows.find(row => row.references.includes('R3'))
    expect(variant?.quantity).toBe(1)
    expect(rows.find(row => row.dnp)?.references).toEqual(['U1'])
  })

  it('exports from the saved root schematic and caches by content revision', async () => {
    const sch = write('main.kicad_sch', schematic([]))
    const service = serviceWithBomCli()
    const first = await service.exportBom({ artifactPath: sch, roots: [root] })
    expect(first.rows).toHaveLength(4)
    expect(first.source).toBe('kicad-cli-bom')
    const second = await service.exportBom({ artifactPath: sch, roots: [root] })
    expect(second.cached).toBe(true)
    writeFileSync(sch, schematic(['sub/x.kicad_sch']))
    const third = await service.exportBom({ artifactPath: sch, roots: [root] })
    expect(third.cached).toBe(false)
  })

  it('rejects a board artifact and an unconfigured CLI', async () => {
    const board = write('main.kicad_pcb', '(kicad_pcb)')
    const service = serviceWithBomCli()
    await expect(service.exportBom({ artifactPath: board, roots: [root] }))
      .rejects.toMatchObject({ code: 'unsupported-artifact', status: 415 })
    const sch = write('main2.kicad_sch', schematic([]))
    await expect(new HardwareArtifactService({ cacheRoot: join(root, 'c') }).exportBom({ artifactPath: sch, roots: [root] }))
      .rejects.toMatchObject({ code: 'not-configured', status: 412 })
  })
})

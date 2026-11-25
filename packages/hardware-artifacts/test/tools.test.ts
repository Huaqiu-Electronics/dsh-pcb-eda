/**
 * Agent tool surface (M4).
 *
 * The tools are the file-based fabrication path: a path in, `kicad-cli` in the
 * board's directory, a structured result out. No HQ Edge, no open editor. These
 * tests run that path against a fake CLI so the contract the agent sees — the
 * shapes, the validation verdict, the workspace boundary — is pinned.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HardwareArtifactService } from '../src/service.js'
import { createHardwareTools, hardwareToolNames } from '../src/tools.js'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hw-tools-')))
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

const BOARD = `(kicad_pcb (version 20240108) (generator "pcbnew")
  (general (thickness 1.6))
  (layers
    (0 "F.Cu" signal)
    (1 "In1.Cu" signal)
    (2 "In2.Cu" signal)
    (31 "B.Cu" signal)
  )
  (gr_rect (start 100 100) (end 160 140) (stroke (width 0.05)) (fill none) (layer "Edge.Cuts"))
  (segment (start 100.5 100.5) (end 110 100.5) (width 0.25) (layer "F.Cu") (net 0))
  (via (at 120 120) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 0))
)
`

const POSITIONS = [
  'Ref,Val,Package,PosX,PosY,Rot,Side',
  'C1,100n,C_0402,10.5,20.25,90,top',
  'R1,10k,R_0603,30,40,180,bottom',
  '',
].join('\n')

const BOM_CSV = [
  '"Refs","Value","Footprint","Qty","DNP"',
  '"C1","100n","C_0402","1",""',
  '"R1","10k","R_0603","1",""',
  '',
].join('\n')

interface FakeCliOptions {
  /** Gerber layers the plotter writes; a 4-layer board needs F, In1, In2, B. */
  readonly copper?: readonly string[]
  readonly outline?: boolean
  readonly drill?: boolean
}

function serviceWithFakeCli(options: FakeCliOptions = {}): HardwareArtifactService {
  const app = join(root, 'KiCad.app')
  write('KiCad.app/Contents/MacOS/kicad-cli', '')
  write('KiCad.app/Contents/MacOS/kicad', '')
  const copper = options.copper ?? ['F_Cu', 'In1_Cu', 'In2_Cu', 'B_Cu']
  return new HardwareArtifactService({
    kicadRoot: app,
    probeVersion: () => '10.0.7',
    cacheRoot: join(root, '.cache'),
    runCommand: async (_command, args) => {
      const out = args[args.indexOf('--output') + 1] ?? ''
      if (args[1] === 'export' && args[2] === 'gerbers') {
        mkdirSync(out, { recursive: true })
        for (const layer of copper) writeFileSync(join(out, `main-${layer}.gbr`), 'G04 plot*\n')
        if (options.outline !== false) writeFileSync(join(out, 'main-Edge_Cuts.gbr'), 'G04 edge*\n')
      } else if (args[1] === 'export' && args[2] === 'drill') {
        if (options.drill !== false) writeFileSync(join(out, 'main.drl'), 'M48\n')
      } else if (args[1] === 'export' && args[2] === 'pos') {
        writeFileSync(out, POSITIONS)
      } else if (args[0] === 'sch') {
        writeFileSync(out, BOM_CSV)
      }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    },
    openExternal: url => ({ command: 'open', args: [url] }),
    spawnProcess: () => ({ pid: 1 }),
    postOrder: async () => ({ status: 200, text: JSON.stringify({ url: 'https://www.hqpcb.com/x?id=7' }) }),
  })
}

function project(): { board: string; schematic: string } {
  write('demo.kicad_pro', '{}')
  const schematic = write('demo.kicad_sch', '(kicad_sch (version 20231120))\n')
  const board = write('demo.kicad_pcb', BOARD)
  return { board, schematic }
}

/** The tools take DSH's execution context; only `signal` is read here. */
const EXEC = { signal: new AbortController().signal } as unknown as never

function toolOf(service: HardwareArtifactService, name: string) {
  const tools = createHardwareTools({ service, workspaceOf: () => root })
  const tool = tools.find(candidate => candidate.name === name)
  if (tool === undefined) throw new Error(`no such tool: ${name}`)
  return tool
}

async function run(service: HardwareArtifactService, name: string, args: unknown): Promise<Record<string, unknown>> {
  return await toolOf(service, name).execute(args, EXEC) as Record<string, unknown>
}

describe('tool registry', () => {
  it('registers the three M4 responsibilities under the hardware namespace', () => {
    expect(hardwareToolNames()).toEqual(['hardware_projects', 'hardware_bom', 'hardware_fabricate'])
    expect(createHardwareTools({ service: serviceWithFakeCli(), workspaceOf: () => root }).map(tool => tool.name))
      .toEqual(hardwareToolNames())
    // Every tool must declare the mandatory output contract.
    for (const tool of createHardwareTools({ service: serviceWithFakeCli(), workspaceOf: () => root })) {
      expect(tool.output.render).toBeTypeOf('function')
    }
  })
})

describe('hardware_projects', () => {
  it('reports the project, its board and the resolved CLI', async () => {
    project()
    const result = await run(serviceWithFakeCli(), 'hardware_projects', {})
    expect(result.ok).toBe(true)
    expect(result.cwd).toBe(root)
    const projects = result.projects as Record<string, unknown>[]
    expect(projects).toHaveLength(1)
    expect(projects[0]?.name).toBe('demo')
    expect(projects[0]?.boards).toEqual([join(root, 'demo.kicad_pcb')])
    expect(projects[0]?.schematic).toBe(join(root, 'demo.kicad_sch'))
    expect(result.kicad).toMatchObject({ configured: true, version: '10.0.7' })
    expect(result.selected).toMatchObject({ path: join(root, 'demo.kicad_pro') })
  })

  it('does not choose between two projects', async () => {
    project()
    write('other/other.kicad_pro', '{}')
    write('other/other.kicad_pcb', BOARD)
    const result = await run(serviceWithFakeCli(), 'hardware_projects', {})
    expect(result.ok).toBe(true)
    expect(result.selected).toBeUndefined()
    expect(result.issue).toMatchObject({ code: 'selection-required' })
    expect((result.projects as unknown[]).length).toBe(2)
  })

  it('reports a workspace with no project instead of failing the call', async () => {
    const result = await run(serviceWithFakeCli(), 'hardware_projects', {})
    expect(result.ok).toBe(true)
    expect(result.issue).toMatchObject({ code: 'no-project' })
    expect(result.projects).toEqual([])
  })
})

describe('hardware_bom', () => {
  it('returns the grouped BOM rows of the root schematic', async () => {
    const { schematic } = project()
    const result = await run(serviceWithFakeCli(), 'hardware_bom', { path: schematic })
    expect(result.ok).toBe(true)
    expect(result.lines).toBe(2)
    expect(result.parts).toBe(2)
    expect(result.rows).toEqual([
      expect.objectContaining({ references: ['C1'], value: '100n', footprint: 'C_0402', quantity: 1 }),
      expect.objectContaining({ references: ['R1'], value: '10k', footprint: 'R_0603', quantity: 1 }),
    ])
  })

  it('resolves a workspace-relative path', async () => {
    project()
    const result = await run(serviceWithFakeCli(), 'hardware_bom', { path: 'demo.kicad_sch' })
    expect(result.ok).toBe(true)
    expect(result.path).toBe(join(root, 'demo.kicad_sch'))
  })

  it('refuses a board path, which has no BOM of its own', async () => {
    const { board } = project()
    const result = await run(serviceWithFakeCli(), 'hardware_bom', { path: board })
    expect(result.ok).toBe(false)
    expect(result.error).toMatchObject({ code: 'unsupported-artifact' })
  })
})

describe('hardware_fabricate', () => {
  it('returns facts, the archive manifest and a passing validation', async () => {
    const { board, schematic } = project()
    const result = await run(serviceWithFakeCli(), 'hardware_fabricate', { path: board, schematic })
    expect(result.ok).toBe(true)
    expect(result.boardPath).toBe(board)
    expect(result.facts).toMatchObject({ layers: 4, widthMm: 60, heightMm: 40, thicknessMm: 1.6 })
    expect(result.archive).toMatchObject({ zipName: 'demo.zip' })
    expect(result.validation).toMatchObject({ ok: true, hasOutline: true, hasDrill: true })
    expect(result.assembly).toMatchObject({ positions: 2, bomLines: 2 })
    // The zip bytes stay in the host: an agent result must not carry them.
    expect(result).not.toHaveProperty('archiveData')
  })

  it('prepares a fabrication-only package when no schematic is given', async () => {
    const { board } = project()
    const result = await run(serviceWithFakeCli(), 'hardware_fabricate', { path: board })
    expect(result.ok).toBe(true)
    expect(result.assembly).toBeUndefined()
  })

  it('reports a failed validation as a finding, not as a tool failure', async () => {
    const { board } = project()
    const result = await run(serviceWithFakeCli({ copper: ['F_Cu', 'B_Cu'] }), 'hardware_fabricate', { path: board })
    // The export ran; the verdict is the answer.
    expect(result.ok).toBe(false)
    expect(result.error).toBeUndefined()
    expect(result.validation).toMatchObject({ ok: false, missingLayers: ['In1_Cu', 'In2_Cu'] })
    expect((result.validation as { errors: { code: string }[] }).errors.map(issue => issue.code))
      .toEqual(['missing-copper-layer'])
  })

  it('is rejected by the tool schema before the body runs when path is missing', async () => {
    // DSH validates the declared parameters inside `execute`, so a missing
    // required path never reaches the service.
    await expect(toolOf(serviceWithFakeCli(), 'hardware_fabricate').execute({}, EXEC))
      .rejects.toThrow(/missing required property "path"/u)
  })

  it('refuses a board outside the session workspace', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'hw-outside-')))
    writeFileSync(join(outside, 'elsewhere.kicad_pcb'), BOARD)
    try {
      const result = await run(serviceWithFakeCli(), 'hardware_fabricate', {
        path: join(outside, 'elsewhere.kicad_pcb'),
      })
      expect(result.ok).toBe(false)
      expect(result.error).toMatchObject({ code: 'unauthorized' })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('writes the validated package when an output directory is given', async () => {
    const { board, schematic } = project()
    const result = await run(serviceWithFakeCli(), 'hardware_fabricate', {
      path: board,
      schematic,
      output_dir: 'fab',
    })
    expect(result.ok).toBe(true)
    const directory = join(root, 'fab')
    expect(readdirSync(directory).sort()).toEqual(['demo-bom.csv', 'demo-positions.csv', 'demo.zip'])
    // A real zip, not a text file with a .zip name.
    expect(readFileSync(join(directory, 'demo.zip')).subarray(0, 2).toString()).toBe('PK')
    // The positions table keeps the BOM the assembly endpoint expects.
    expect(readFileSync(join(directory, 'demo-positions.csv'), 'utf8')).toContain('Designator,Footprint,PosX,PosY')
    expect(result.written).toMatchObject({ directory })
  })
})

describe('order gate', () => {
  it('refuses to place an order for a package that failed validation', async () => {
    const { board } = project()
    // The install must resolve, so the refusal is the package's, not KiCad's.
    write('KiCad.app/Contents/MacOS/kicad-cli', '')
    write('KiCad.app/Contents/MacOS/kicad', '')
    // A configured token, so the refusal is the package's, not the login's.
    const withToken = new HardwareArtifactService({
      kicadRoot: join(root, 'KiCad.app'),
      probeVersion: () => '10.0.7',
      cacheRoot: join(root, '.cache-2'),
      accessToken: 'tok',
      runCommand: async (_command, args) => {
        const out = args[args.indexOf('--output') + 1] ?? ''
        if (args[2] === 'gerbers') {
          mkdirSync(out, { recursive: true })
          writeFileSync(join(out, 'main-F_Cu.gbr'), 'G04 plot*\n')
          writeFileSync(join(out, 'main-B_Cu.gbr'), 'G04 plot*\n')
        } else if (args[2] === 'drill') writeFileSync(join(out, 'main.drl'), 'M48\n')
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
      openExternal: url => ({ command: 'open', args: [url] }),
      spawnProcess: () => ({ pid: 1 }),
      postOrder: async () => {
        throw new Error('an invalid package must not reach the endpoint')
      },
    })
    await expect(withToken.placeOrder({ kind: 'pcb', boardPath: board, roots: [root], launch: false }))
      .rejects.toMatchObject({ code: 'package-invalid', status: 422 })
  })
})

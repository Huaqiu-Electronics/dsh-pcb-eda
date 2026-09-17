/**
 * Tool registration + tool behaviour (task §10, §11, §23).
 *
 *   dsh-kicad -> expected KiCad tools are registered
 *
 * Execution is exercised against the fake interpreter from `./helpers.ts`, so
 * these assertions cover argv construction, timeout handling and exit-code →
 * semantic-error mapping without needing a live KiCad.
 */
import { describe, expect, it, afterEach, beforeEach } from 'vitest'

import { resolveKicadConfig } from '../src/config.js'
import { classifyRun } from '../src/ipc.js'
import {
  createKicadTools,
  kicadToolNames,
  type KicadToolEnv,
  type KicadToolResult,
} from '../src/tools.js'
import { createFakeEnv, disposeFakeEnv, recordedArgv, setControl, type FakeEnv } from './helpers.js'

let env: FakeEnv
let toolEnv: KicadToolEnv

beforeEach(() => {
  env = createFakeEnv()
  toolEnv = {
    scriptsDir: env.scriptsDir,
    pythonPath: env.pythonPath,
    config: resolveKicadConfig({
      timeoutMs: 5_000,
      diagnosticTimeoutMs: 5_000,
      // Kept tiny so the timeout path is exercised without stalling the suite.
      refillTimeoutMs: 250,
    }),
  }
})

afterEach(() => {
  disposeFakeEnv(env)
})

function toolsByName() {
  const map = new Map<string, ReturnType<typeof createKicadTools>[number]>()
  for (const tool of createKicadTools(toolEnv)) {
    // `defineTool` definitions keep their declared name on the definition.
    map.set((tool as unknown as { name: string }).name, tool)
  }
  return map
}

async function execute(name: string, args: unknown): Promise<KicadToolResult> {
  const tool = toolsByName().get(name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  const result = await (
    tool as unknown as { execute: (a: unknown, e: unknown) => Promise<KicadToolResult> }
  ).execute(args, {})
  return result
}

describe('tool registration (§23)', () => {
  it('registers exactly the ten migrated KiCad tools', () => {
    const names = [...toolsByName().keys()]
    expect(names.sort()).toEqual([...kicadToolNames()].sort())
    expect(names).toHaveLength(10)
  })

  it('uses snake_case, semantic, agent-facing names', () => {
    for (const name of kicadToolNames()) {
      expect(name).toMatch(/^kicad_(ipc|pcb)_[a-z0-9_]+$/)
      // §11: never "calls KiCad RPC method X".
      expect(name).not.toMatch(/rpc|method|proto/i)
    }
  })

  it('gives every tool a substantial description that says what it returns', () => {
    for (const [name, tool] of toolsByName()) {
      const description = (tool as unknown as { description: string }).description
      expect(description.length, `description of ${name}`).toBeGreaterThan(120)
      expect(description).toContain('error.kind')
      // Descriptions describe board-level intent, not transport mechanics.
      expect(description).not.toMatch(/\bRPC\b|\bProtobuf\b|kipy_common/)
    }
  })

  it('does not expose a tool for a script that is not bundled', () => {
    const names = [...toolsByName().keys()]
    expect(names).not.toContain('kicad_pcb_import_ses')
  })
})

describe('tool execution — argv construction', () => {
  it('builds create_track flags in millimetres and omits unset optionals', async () => {
    setControl(env, ['exit=0', 'stdout=created'])
    const result = await execute('kicad_pcb_create_track', {
      net: 'GND',
      start_x_mm: 10,
      start_y_mm: 20,
      end_x_mm: 30,
      end_y_mm: 40.5,
      width_mm: 0.25,
    })

    expect(result.ok).toBe(true)
    const argv = recordedArgv(env)
    expect(argv).toContain('--net')
    expect(argv[argv.indexOf('--net') + 1]).toBe('GND')
    expect(argv[argv.indexOf('--start') + 1]).toBe('10,20')
    expect(argv[argv.indexOf('--end') + 1]).toBe('30,40.5')
    expect(argv[argv.indexOf('--width-mm') + 1]).toBe('0.25')
    // No --layer / --save when the caller did not ask for them.
    expect(argv).not.toContain('--layer')
    expect(argv).not.toContain('--save')
  })

  it('passes --layer and --save only when requested', async () => {
    setControl(env, ['exit=0'])
    await execute('kicad_pcb_create_track', {
      net: 'GND',
      start_x_mm: 0,
      start_y_mm: 0,
      end_x_mm: 1,
      end_y_mm: 1,
      width_mm: 0.2,
      layer: 'B.Cu',
      save: true,
    })
    const argv = recordedArgv(env)
    expect(argv[argv.indexOf('--layer') + 1]).toBe('B.Cu')
    expect(argv).toContain('--save')
  })

  it('formats a copper zone polygon as x,y;x,y', async () => {
    setControl(env, ['exit=0'])
    await execute('kicad_pcb_create_copper_zone', {
      net: 'GND',
      points: [
        { x_mm: 0, y_mm: 0 },
        { x_mm: 10, y_mm: 0 },
        { x_mm: 10, y_mm: 10 },
      ],
    })
    const argv = recordedArgv(env)
    expect(argv[argv.indexOf('--points') + 1]).toBe('0,0;10,0;10,10')
  })

  it('requires an explicit confirm before deleting the selection', async () => {
    const refused = await execute('kicad_pcb_remove_selected_items', { confirm: false })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.kind).toBe('INVALID_ARGUMENT')
    // Nothing was spawned — the guard runs before any process starts.
    expect(recordedArgv(env)).toHaveLength(0)

    setControl(env, ['exit=0', 'stdout=deleted'])
    const accepted = await execute('kicad_pcb_remove_selected_items', { confirm: true })
    expect(accepted.ok).toBe(true)
    expect(recordedArgv(env)).toContain('--yes')
  })
})

describe('tool execution — pre-flight validation (board untouched)', () => {
  it('rejects a non-positive track width without spawning', async () => {
    const result = await execute('kicad_pcb_create_track', {
      net: 'GND',
      start_x_mm: 0,
      start_y_mm: 0,
      end_x_mm: 1,
      end_y_mm: 1,
      width_mm: 0,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('INVALID_ARGUMENT')
    expect(recordedArgv(env)).toHaveLength(0)
  })

  it('rejects a via whose drill is not smaller than its diameter', async () => {
    const result = await execute('kicad_pcb_create_via', {
      net: 'GND',
      x_mm: 1,
      y_mm: 1,
      diameter_mm: 0.4,
      drill_mm: 0.6,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('INVALID_ARGUMENT')
  })

  it('rejects a no-op footprint move', async () => {
    const result = await execute('kicad_pcb_move_rotate_footprint', { reference: 'R1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('INVALID_ARGUMENT')
  })

  it('rejects cloning a footprint onto its own reference', async () => {
    const result = await execute('kicad_pcb_add_footprint_from_template', {
      source_reference: 'R1',
      new_reference: 'R1',
      dx_mm: 0,
      dy_mm: 0,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('INVALID_ARGUMENT')
  })
})

describe('tool execution — semantic error mapping', () => {
  it('reports DEADLINE_EXCEEDED when KiCad does not answer in time', async () => {
    setControl(env, ['sleep=2', 'exit=0'])
    const result = await execute('kicad_pcb_refill_zones', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('DEADLINE_EXCEEDED')
      expect(result.error.message).toMatch(/KiCad may be busy/)
    }
  })

  it('reports FAILED_PRECONDITION when the interpreter is missing', async () => {
    const broken = createKicadTools({
      ...toolEnv,
      pythonPath: joinMissing(env.root),
    })
    const tool = broken.find(
      (t) => (t as unknown as { name: string }).name === 'kicad_ipc_diagnose',
    )!
    const result = (await (
      tool as unknown as { execute: (a: unknown, e: unknown) => Promise<KicadToolResult> }
    ).execute({}, {})) as KicadToolResult

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('FAILED_PRECONDITION')
      expect(result.error.message).toMatch(/Python interpreter/)
    }
  })

  it('maps diagnose exit codes to the right kinds', async () => {
    const cases: Array<[number, string]> = [
      [1, 'UNAVAILABLE'],
      [2, 'FAILED_PRECONDITION'],
      [3, 'FAILED_PRECONDITION'],
      [4, 'FAILED_PRECONDITION'],
    ]
    for (const [code, kind] of cases) {
      setControl(env, [`exit=${code}`, 'stderr=boom'])
      const result = await execute('kicad_ipc_diagnose', {})
      expect(result.ok, `exit ${code}`).toBe(false)
      if (!result.ok) expect(result.error.kind, `exit ${code}`).toBe(kind)
    }
  })

  it('maps argparse rejections to INVALID_ARGUMENT', async () => {
    setControl(env, ['exit=2', 'stderr=usage error'])
    const result = await execute('kicad_pcb_create_via', {
      net: 'GND',
      x_mm: 1,
      y_mm: 1,
      diameter_mm: 0.8,
      drill_mm: 0.4,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('INVALID_ARGUMENT')
  })

  it('maps an unexpected failure to INTERNAL and reports the dropped commit', async () => {
    setControl(env, ['exit=7', 'stdout=KiCad rejected'])
    const result = await execute('kicad_pcb_create_track', {
      net: 'GND',
      start_x_mm: 0,
      start_y_mm: 0,
      end_x_mm: 1,
      end_y_mm: 1,
      width_mm: 0.2,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('INTERNAL')
      expect(result.error.message).toContain('dropped')
      expect(result.diagnostics?.exitCode).toBe(7)
    }
  })

  it('surfaces a missing kipy module as FAILED_PRECONDITION, not INTERNAL', async () => {
    setControl(env, ['exit=1', 'stderr=ModuleNotFoundError: No module named kipy'])
    const result = await execute('kicad_pcb_create_track', {
      net: 'GND',
      start_x_mm: 0,
      start_y_mm: 0,
      end_x_mm: 1,
      end_y_mm: 1,
      width_mm: 0.2,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('FAILED_PRECONDITION')
  })
})

describe('classifyRun', () => {
  it('treats exit 0 as success', () => {
    expect(
      classifyRun({
        script: 'create_track',
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        argv: [],
        timedOut: false,
      }),
    ).toBeUndefined()
  })
})

/** A path that definitively does not exist, for the missing-interpreter case. */
function joinMissing(root: string): string {
  return `${root}/definitely-not-a-python-interpreter`
}

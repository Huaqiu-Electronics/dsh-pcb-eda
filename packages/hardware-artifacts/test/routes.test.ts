/**
 * Route-level authorization: the workspace a request is checked against comes
 * from the session it names, never from whichever session discovered last.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHardwareHandler, type WorkspaceResolver } from '../src/routes.js'
import { HardwareArtifactService } from '../src/service.js'

let workspaceA: string
let workspaceB: string

beforeEach(() => {
  // Canonicalized for the same reason as the service tests: /var is a symlink
  // to /private/var on macOS and every authorized path is a realpath.
  workspaceA = realpathSync(mkdtempSync(join(tmpdir(), 'hw-routes-a-')))
  workspaceB = realpathSync(mkdtempSync(join(tmpdir(), 'hw-routes-b-')))
  mkdirSync(workspaceA, { recursive: true })
  mkdirSync(workspaceB, { recursive: true })
})

afterEach(() => {
  rmSync(workspaceA, { recursive: true, force: true })
  rmSync(workspaceB, { recursive: true, force: true })
})

interface Reply {
  readonly status: number
  readonly body: Record<string, unknown>
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

/** Drive one handler call with a JSON body and a loopback Host header. */
async function call(handler: Handler, path: string, init: { method?: string; body?: unknown } = {}): Promise<Reply> {
  const payload = init.body === undefined ? [] : [Buffer.from(JSON.stringify(init.body))]
  const request = Object.assign(Readable.from(payload), {
    method: init.method ?? 'GET',
    url: path,
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
  }) as unknown as IncomingMessage
  return await new Promise<Reply>((resolve, reject) => {
    const response = {
      statusCode: 0,
      writeHead(status: number) {
        this.statusCode = status
      },
      end(text: string | Uint8Array) {
        try {
          const raw = typeof text === 'string' ? text : Buffer.from(text).toString('utf8')
          resolve({ status: this.statusCode, body: JSON.parse(raw) as Record<string, unknown> })
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      },
    }
    handler(request, response as unknown as ServerResponse)
  })
}

/** A service whose KiCad is deliberately absent, so export routes stop at 412. */
function harness(): { handler: Handler; resolver: WorkspaceResolver } {
  const service = new HardwareArtifactService({ kicadRoot: join(workspaceA, 'missing-kicad') })
  const resolver: WorkspaceResolver = sessionId => {
    if (sessionId === 'session-a') return workspaceA
    if (sessionId === 'session-b') return workspaceB
    return undefined
  }
  return { handler: createHardwareHandler(service, { resolveWorkspace: resolver }), resolver }
}

describe('session-scoped workspace authorization', () => {
  it('resolves each session to its own workspace instead of process.cwd()', async () => {
    const { handler } = harness()
    const a = await call(handler, '/api/v1/hardware/projects?session=session-a')
    const b = await call(handler, '/api/v1/hardware/projects?session=session-b')
    expect(a.status).toBe(200)
    expect(a.body.cwd).toBe(workspaceA)
    expect(b.body.cwd).toBe(workspaceB)
  })

  /**
   * The reported failure: session A's viewer kept answering after a switch to a
   * session in another workspace, and its read was refused because the shared
   * "last discovery" now pointed at B.
   */
  it('keeps an open viewer authorized across a workspace switch', async () => {
    const { handler } = harness()
    const sch = join(workspaceA, 'main.kicad_sch')
    writeFileSync(sch, '(kicad_sch (version 20231120))\n', 'utf8')
    expect((await call(handler, '/api/v1/hardware/projects?session=session-a')).status).toBe(200)

    // The user switches to a session in another workspace.
    expect((await call(handler, '/api/v1/hardware/projects?session=session-b')).status).toBe(200)

    const read = await call(handler, `/api/v1/hardware/source?path=${encodeURIComponent(sch)}&session=session-a`)
    expect(read.status).toBe(200)
    expect(read.body.kind).toBe('schematic')

    // A read names its session; naming the other one does not grant this path.
    const crossed = await call(handler, `/api/v1/hardware/source?path=${encodeURIComponent(sch)}&session=session-b`)
    expect(crossed.status).toBe(403)
    expect((crossed.body.error as { message?: string } | undefined)?.message).toBe('artifact is outside the authorized workspace')
  })

  it('refuses a read that names no session and no root', async () => {
    const { handler } = harness()
    const sch = join(workspaceA, 'main.kicad_sch')
    writeFileSync(sch, '(kicad_sch (version 20231120))\n', 'utf8')
    const read = await call(handler, `/api/v1/hardware/source?path=${encodeURIComponent(sch)}`)
    expect(read.status).toBe(403)
  })

  it('authorizes the write routes through the same session workspace', async () => {
    const { handler } = harness()
    const sch = join(workspaceA, 'main.kicad_sch')
    writeFileSync(sch, '(kicad_sch (version 20231120))\n', 'utf8')
    await call(handler, '/api/v1/hardware/projects?session=session-b')

    // Authorized, then refused for configuration — not for the workspace.
    const bom = await call(handler, '/api/v1/hardware/bom', {
      method: 'POST',
      body: { path: sch, session: 'session-a' },
    })
    expect(bom.status).toBe(412)
    expect((bom.body.error as { code?: string } | undefined)?.code).toBe('not-configured')

    const crossed = await call(handler, '/api/v1/hardware/bom', {
      method: 'POST',
      body: { path: sch, session: 'session-b' },
    })
    expect(crossed.status).toBe(403)
  })
})

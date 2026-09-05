import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { HuaqiuArtifactService } from '../src/service.js'
import { createArtifactsHandler, ARTIFACTS_ROUTE_PREFIX } from '../src/routes.js'
import { apply } from '../src/index.js'

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-artifacts-test-'))
}

describe('HuaqiuArtifactService', () => {
  let root: string
  let svc: HuaqiuArtifactService
  beforeEach(() => {
    root = tmpRoot()
    svc = new HuaqiuArtifactService({ baseDir: root })
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates an artifact with the expected meta shape', async () => {
    const result = await svc.create({ type: 'schematic', filename: 'board.kicad_sch', content: '(kicad_sch)' })
    expect(result.id).toMatch(/^art_[0-9a-f]+$/)
    expect(result.type).toBe('schematic')
    expect(result.filename).toBe('board.kicad_sch')
    expect(result.size).toBe('(kicad_sch)'.length)

    const meta = await svc.get(result.id)
    expect(meta).not.toBeNull()
    expect(meta!.mimeType).toBe('application/x.kicad-schematic')
    expect(meta!.createdAt).toBeTruthy()
  })

  it('round-trips utf8, base64 and binary content', async () => {
    const utf8 = await svc.create({ type: 'symbol', filename: 's.kicad_sym', content: 'sym\n文本' })
    expect(Buffer.from((await svc.readContent(utf8.id))!).toString('utf8')).toBe('sym\n文本')

    const b64 = await svc.create({ type: 'pcb', filename: 'p.kicad_pcb', content: 'aGVsbG8=', contentEncoding: 'base64' })
    expect(Buffer.from((await svc.readContent(b64.id))!).toString('utf8')).toBe('hello')

    const binary = await svc.create({ type: 'zip', filename: 'z.zip', content: new Uint8Array([1, 2, 3, 250]) })
    expect(Array.from((await svc.readContent(binary.id))!)).toEqual([1, 2, 3, 250])
  })

  it('rejects invalid ids (traversal, non-hex, wrong prefix)', async () => {
    expect(await svc.get('../etc/passwd')).toBeNull()
    expect(await svc.get('art_ZZZZ')).toBeNull()
    expect(await svc.get('not-an-artifact')).toBeNull()
    expect(await svc.readContent('/etc/passwd')).toBeNull()
    await expect(svc.delete('../x')).resolves.toBeUndefined()
  })

  it('never lets filename affect the storage path', async () => {
    const evil = await svc.create({ type: 'zip', filename: '../../escape.zip', content: 'x' })
    // content round-trips even with a path-looking filename
    expect(Buffer.from((await svc.readContent(evil.id))!).toString()).toBe('x')
    const meta = await svc.get(evil.id)
    expect(meta!.filename).toBe('../../escape.zip')
    // nothing was written outside the artifacts root
    const outside = path.resolve(root, '..', 'escape.zip')
    expect(fs.existsSync(outside)).toBe(false)
  })

  it('enforces the max-size cap', async () => {
    const small = new HuaqiuArtifactService({ baseDir: root, maxBytes: 4 })
    await expect(
      small.create({ type: 'zip', filename: 'big.zip', content: '12345' }),
    ).rejects.toThrow(/max size/)
  })

  it('expires artifacts by TTL and leaves no tmp files', async () => {
    const a = await svc.create({ type: 'schematic', filename: 'a.kicad_sch', content: 'x', ttlSeconds: 3600 })
    const dir = path.join(root, 'dsh-artifacts', a.id)
    // no partial/tmp files after create
    expect(fs.readdirSync(dir).sort()).toEqual(['content', 'meta.json'])

    // force-expire by writing an already-past expiresAt
    const metaPath = path.join(dir, 'meta.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    meta.expiresAt = new Date(Date.now() - 1000).toISOString()
    fs.writeFileSync(metaPath, JSON.stringify(meta))

    expect(await svc.get(a.id)).toBeNull()
    expect(await svc.readContent(a.id)).toBeNull()
  })

  it('deleteAll removes everything or only expired', async () => {
    const a = await svc.create({ type: 'schematic', filename: 'a.kicad_sch', content: 'a' })
    const b = await svc.create({ type: 'schematic', filename: 'b.kicad_sch', content: 'b' })
    const bDir = path.join(root, 'dsh-artifacts', b.id)
    const metaB = JSON.parse(fs.readFileSync(path.join(bDir, 'meta.json'), 'utf8'))
    metaB.expiresAt = new Date(Date.now() - 1000).toISOString()
    fs.writeFileSync(path.join(bDir, 'meta.json'), JSON.stringify(metaB))

    expect(await svc.deleteAll({ onlyExpired: true })).toBe(1)
    expect(await svc.get(a.id)).not.toBeNull()
    expect(await svc.get(b.id)).toBeNull()

    expect(await svc.deleteAll()).toBe(1)
    expect(await svc.get(a.id)).toBeNull()
  })
})

describe('apply() boot sweep', () => {
  it('removes expired artifacts at startup so storage cannot grow unbounded', async () => {
    const root = tmpRoot()
    const seed = new HuaqiuArtifactService({ baseDir: root })
    const kept = await seed.create({ type: 'zip', filename: 'keep.zip', content: 'k' })
    const exp = await seed.create({ type: 'zip', filename: 'exp.zip', content: 'e', ttlSeconds: 3600 })
    const expDir = path.join(root, 'dsh-artifacts', exp.id)
    const meta = JSON.parse(fs.readFileSync(path.join(expDir, 'meta.json'), 'utf8'))
    meta.expiresAt = new Date(Date.now() - 1000).toISOString()
    fs.writeFileSync(path.join(expDir, 'meta.json'), JSON.stringify(meta))

    // Bring the plugin up through apply(); its boot effect runs the expired sweep.
    const ctx = {
      effect: (fn: () => void | (() => void)) => { fn(); return () => {} },
      provide: () => () => {},
      webServer: { register: () => () => {} },
    } as unknown as Parameters<typeof apply>[0]
    apply(ctx, { baseDir: root })
    // the sweep is fire-and-forget; yield a microtask so it settles
    await new Promise((r) => setTimeout(r, 10))

    expect(await seed.get(exp.id)).toBeNull()
    expect(await seed.get(kept.id)).not.toBeNull()
  })
})

describe('artifacts HTTP routes', () => {
  let root: string
  let server: http.Server
  let base: string
  let svc: HuaqiuArtifactService

  beforeEach(async () => {
    root = tmpRoot()
    svc = new HuaqiuArtifactService({ baseDir: root })
    server = http.createServer(createArtifactsHandler(svc))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  async function get(p: string): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.get(base + p, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }))
      })
      req.on('error', reject)
    })
  }

  it('serves metadata and content with Content-Disposition', async () => {
    const a = await svc.create({ type: 'schematic', filename: '我的板.kicad_sch', content: '(kicad_sch)' })
    const meta = await get(`${ARTIFACTS_ROUTE_PREFIX}/${a.id}`)
    expect(meta.status).toBe(200)
    const parsed = JSON.parse(meta.body.toString('utf8'))
    expect(parsed.id).toBe(a.id)
    expect(parsed.filename).toBe('我的板.kicad_sch')
    expect(parsed.type).toBe('schematic')

    const content = await get(`${ARTIFACTS_ROUTE_PREFIX}/${a.id}/content`)
    expect(content.status).toBe(200)
    expect(content.body.toString('utf8')).toBe('(kicad_sch)')
    expect(content.headers['content-type']).toBe('application/x.kicad-schematic')
    expect(content.headers['content-disposition']).toContain(encodeURIComponent('我的板.kicad_sch'))
  })

  it('404s for unknown and invalid ids', async () => {
    expect((await get(`${ARTIFACTS_ROUTE_PREFIX}/art_deadbeef`)).status).toBe(404)
    expect((await get(`${ARTIFACTS_ROUTE_PREFIX}/art_deadbeef/content`)).status).toBe(404)
    expect((await get(`${ARTIFACTS_ROUTE_PREFIX}/..%2F..%2Fetc`)).status).toBe(404)
    expect((await get(`/api/v1/huaqiu/artifacts`)).status).toBe(404)
  })

  it('rejects paths that only share the route prefix text', async () => {
    const a = await svc.create({ type: 'schematic', filename: 'board.kicad_sch', content: '(kicad_sch)' })
    expect((await get(`${ARTIFACTS_ROUTE_PREFIX}${a.id}`)).status).toBe(404)
  })
})

describe('@huaqiu/dsh-artifacts plugin entry', () => {
  it('registers a prefix route on ctx.webServer and provides the service', () => {
    const registered: Array<{ kind: string; path: string }> = []
    const provided = new Map<string, unknown>()
    const ctx = {
      provide: (name: string, value: unknown) => {
        provided.set(name, value)
        return () => undefined
      },
      webServer: { register: (route: { kind: string; path: string }) => (registered.push(route), () => undefined) },
      // cordis semantics: effect invokes the callback now and keeps the disposer.
      effect: (cb: () => unknown) => void cb(),
    }
    apply(ctx as never)
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ kind: 'prefix', path: ARTIFACTS_ROUTE_PREFIX })
    expect(provided.has('huaqiuArtifacts')).toBe(true)
  })
})
/** Read-only HTTP surface for the Hardware Engineering client. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { ArtifactKind, DiscoveryResult, HardwareArtifactService, NativeApplication } from './service.js'

export const HARDWARE_ROUTE_PREFIX = '/api/v1/hardware'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function isTrustedRequest(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? '')
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return false
  const origin = req.headers.origin
  return origin === undefined || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(origin))
}

async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.byteLength
    if (size > maxBytes) throw Object.assign(new Error('request body too large'), { status: 413 })
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function failure(error: unknown): { status: number; body: unknown } {
  const code = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'internal'
  const status = typeof (error as { status?: unknown }).status === 'number' ? Number((error as { status: number }).status) : 500
  return { status, body: { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } } }
}

/** Roots a request may read: the caller's workspace, then the host's own. */
function rootsOf(body: unknown): string[] {
  if (body === null || typeof body !== 'object') return []
  const cwd = asString((body as Record<string, unknown>).cwd)
  const workspace = asString((body as Record<string, unknown>).workspace)
  return [cwd, workspace].filter((value): value is string => value !== undefined)
}

export function createHardwareHandler(service: HardwareArtifactService): (req: IncomingMessage, res: ServerResponse) => void {
  let lastDiscovery: DiscoveryResult | undefined
  return (req, res) => {
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      return
    }
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const p = url.pathname
        if (req.method === 'GET' && p === `${HARDWARE_ROUTE_PREFIX}/projects`) {
          const result = service.discover(asString(url.searchParams.get('cwd') ?? undefined) ?? process.cwd(), asString(url.searchParams.get('project') ?? undefined))
          lastDiscovery = result
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        if (req.method === 'GET' && p === `${HARDWARE_ROUTE_PREFIX}/installations`) {
          sendJson(res, 200, { ok: true, ...service.installations() })
          return
        }
        if (req.method === 'GET' && p === `${HARDWARE_ROUTE_PREFIX}/environment`) {
          sendJson(res, 200, { ok: true, text: service.environmentText(lastDiscovery ?? service.discovery()), childEnv: service.childEnvironment() })
          return
        }
        if (req.method === 'GET' && p === `${HARDWARE_ROUTE_PREFIX}/source`) {
          const artifactPath = asString(url.searchParams.get('path'))
          if (artifactPath === undefined) {
            sendJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'path is required' } })
            return
          }
          const cwd = asString(url.searchParams.get('cwd') ?? undefined)
          const revision = asString(url.searchParams.get('revision') ?? undefined)
          try {
            const source = await service.readSource({
              artifactPath,
              ...(revision === undefined ? {} : { expectedRevision: revision }),
              ...(cwd === undefined ? {} : { roots: [cwd] }),
            })
            sendJson(res, 200, { ok: true, ...source })
          } catch (error) {
            const { status, body } = failure(error)
            sendJson(res, status, body)
          }
          return
        }
        if (req.method === 'POST' && p === `${HARDWARE_ROUTE_PREFIX}/bom`) {
          const body = await readJson(req) as Record<string, unknown>
          const artifactPath = asString(body.path)
          if (artifactPath === undefined) {
            sendJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'path is required' } })
            return
          }
          try {
            const bom = await service.exportBom({ artifactPath, roots: rootsOf(body) })
            sendJson(res, 200, { ok: true, ...bom })
          } catch (error) {
            const { status, body } = failure(error)
            sendJson(res, status, body)
          }
          return
        }
        if (req.method === 'POST' && p === `${HARDWARE_ROUTE_PREFIX}/glb`) {
          const body = await readJson(req) as Record<string, unknown>
          const artifactPath = asString(body.path)
          if (artifactPath === undefined) {
            sendJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'path is required' } })
            return
          }
          try {
            const glb = await service.exportGlb({ artifactPath, roots: rootsOf(body) })
            const query = new URLSearchParams({ path: glb.path, revision: glb.revision })
            sendJson(res, 200, {
              ok: true,
              path: glb.path,
              revision: glb.revision,
              bytes: glb.bytes,
              generatedAt: glb.generatedAt,
              cached: glb.cached,
              url: `/api/v1/hardware/glb-file?${query.toString()}`,
            })
          } catch (error) {
            const { status, body } = failure(error)
            sendJson(res, status, body)
          }
          return
        }
        if (req.method === 'GET' && p === `${HARDWARE_ROUTE_PREFIX}/glb-file`) {
          const artifactPath = asString(url.searchParams.get('path'))
          const revision = asString(url.searchParams.get('revision'))
          if (artifactPath === undefined || revision === undefined) {
            sendJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'path and revision are required' } })
            return
          }
          try {
            const file = service.glbFile(artifactPath, revision)
            const bytes = readFileSync(file)
            res.writeHead(200, {
              'content-type': 'model/gltf-binary',
              'content-length': bytes.byteLength,
              'cache-control': 'no-store',
              'x-huaqiu-source-revision': revision,
            })
            res.end(bytes)
          } catch (error) {
            const { status, body } = failure(error)
            sendJson(res, status, body)
          }
          return
        }
        if (req.method === 'POST' && p === `${HARDWARE_ROUTE_PREFIX}/open`) {
          const body = await readJson(req) as Record<string, unknown>
          const application = asString(body.application)
          const artifactPath = asString(body.artifactPath)
          const kind = asString(body.kind)
          if (application !== 'kicad') {
            sendJson(res, 400, { error: { code: 'invalid-application', message: 'application must be kicad' }, ok: false })
            return
          }
          if (artifactPath === undefined || kind === undefined) {
            sendJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'artifactPath and kind are required' } })
            return
          }
          try {
            const opened = service.open({
              application: application as NativeApplication,
              artifactPath,
              kind: kind as ArtifactKind,
              ...(asString(body.projectPath) === undefined ? {} : { projectPath: asString(body.projectPath) as string }),
            })
            sendJson(res, 200, { ok: true, ...opened })
          } catch (error) {
            const { status, body } = failure(error)
            sendJson(res, status, body)
          }
          return
        }
        sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown hardware route' } })
      } catch (error) {
        const { status, body } = failure(error)
        sendJson(res, status, body)
      }
    })()
  }
}

/** Read-only HTTP surface for the Hardware Engineering client. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DiscoveryResult, HardwareArtifactService, NativeApplication, ArtifactKind } from './service.js'

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
          sendJson(res, 200, { ok: true, text: service.environmentText(lastDiscovery), childEnv: service.childEnvironment() })
          return
        }
        if (req.method === 'POST' && p === `${HARDWARE_ROUTE_PREFIX}/open`) {
          const body = await readJson(req) as Record<string, unknown>
          const application = asString(body.application)
          const artifactPath = asString(body.artifactPath)
          const kind = asString(body.kind)
          if (application !== 'kicad' && application !== 'solidcraft') {
            sendJson(res, 400, { ok: false, error: { code: 'invalid-application', message: 'application must be kicad or solidcraft' } })
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
            const code = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'launch-failed'
            const status = typeof (error as { status?: unknown }).status === 'number' ? Number((error as { status: number }).status) : 500
            sendJson(res, status, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } })
          }
          return
        }
        sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown hardware route' } })
      } catch (error) {
        const status = typeof (error as { status?: unknown }).status === 'number' ? Number((error as { status: number }).status) : 500
        sendJson(res, status, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
      }
    })()
  }
}

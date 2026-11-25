/** Read-only HTTP surface for the Hardware Engineering client. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { ArtifactKind, HardwareArtifactService, NativeApplication } from './service.js'

export const HARDWARE_ROUTE_PREFIX = '/api/v1/hardware'

/**
 * Resolve the workspace root of one DSH session, host-side.
 *
 * Supplied by the plugin from the `sessions` service, so the base for an
 * authorization check comes from the session header rather than from a value
 * the browser sent — and never from whichever session discovered last.
 */
export type WorkspaceResolver = (sessionId: string) => Promise<string | undefined> | string | undefined

export interface HardwareHandlerOptions {
  readonly resolveWorkspace?: WorkspaceResolver
}

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

/** The DSH session a request belongs to: a query field for reads, a body field for writes. */
function sessionOf(url: URL, body?: unknown): string | undefined {
  const fromBody = body === null || typeof body !== 'object'
    ? undefined
    : asString((body as Record<string, unknown>).session)
  return fromBody ?? asString(url.searchParams.get('session') ?? undefined)
}

/**
 * Everything one request may read: the roots it named plus the workspace of the
 * session it belongs to.
 *
 * The session's workspace is resolved here, not taken from `cwd`: the browser
 * sends whichever cwd its session hook held at render time, and a viewer that
 * stayed mounted across a workspace switch would otherwise authorize against a
 * workspace it no longer shows.
 */
async function authorizeRequest(
  options: HardwareHandlerOptions,
  url: URL,
  body?: unknown,
): Promise<{ roots: string[]; sessionId?: string }> {
  const sessionId = sessionOf(url, body)
  const roots = rootsOf(body)
  // Reads carry theirs in the query string; writes in the body. Either way they
  // only add to the session's workspace, never replace it.
  for (const key of ['cwd', 'workspace']) {
    const value = asString(url.searchParams.get(key) ?? undefined)
    if (value !== undefined && !roots.includes(value)) roots.push(value)
  }
  if (sessionId === undefined || options.resolveWorkspace === undefined) {
    return { roots }
  }
  try {
    const workspace = await options.resolveWorkspace(sessionId)
    if (workspace !== undefined && workspace !== '') roots.push(workspace)
  } catch {
    // An unresolvable session is not a reason to fail a local read: the caller's
    // own roots still apply, and they can only come from this machine.
  }
  return { roots, sessionId }
}

export function createHardwareHandler(
  service: HardwareArtifactService,
  options: HardwareHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
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
          const sessionId = asString(url.searchParams.get('session') ?? undefined)
          let workspace = asString(url.searchParams.get('cwd') ?? undefined)
          if (workspace === undefined && sessionId !== undefined && options.resolveWorkspace !== undefined) {
            try {
              workspace = await options.resolveWorkspace(sessionId)
            } catch {
              workspace = undefined
            }
          }
          // The workspace the session declares is the default; `process.cwd()`
          // is only a last resort for an embed with no session at all.
          const result = service.discover(
            workspace ?? process.cwd(),
            asString(url.searchParams.get('project') ?? undefined),
            sessionId,
          )
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        if (req.method === 'GET' && p === `${HARDWARE_ROUTE_PREFIX}/installations`) {
          sendJson(res, 200, { ok: true, ...service.installations() })
          return
        }
        if (req.method === 'GET' && p === `${HARDWARE_ROUTE_PREFIX}/environment`) {
          const sessionId = asString(url.searchParams.get('session') ?? undefined)
          sendJson(res, 200, {
            ok: true,
            text: service.environmentText(service.discovery(sessionId)),
            childEnv: service.childEnvironment(),
          })
          return
        }
        if (req.method === 'GET' && p === `${HARDWARE_ROUTE_PREFIX}/source`) {
          const artifactPath = asString(url.searchParams.get('path'))
          if (artifactPath === undefined) {
            sendJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'path is required' } })
            return
          }
          const revision = asString(url.searchParams.get('revision') ?? undefined)
          const { roots, sessionId } = await authorizeRequest(options, url)
          try {
            const source = await service.readSource({
              artifactPath,
              ...(revision === undefined ? {} : { expectedRevision: revision }),
              roots,
              ...(sessionId === undefined ? {} : { sessionId }),
            })
            sendJson(res, 200, { ok: true, ...source })
          } catch (error) {
            const { status, body } = failure(error)
            sendJson(res, status, body)
          }
          return
        }
        if (req.method === 'GET' && p === `${HARDWARE_ROUTE_PREFIX}/order`) {
          sendJson(res, 200, { ok: true, ...await service.orderConfig() })
          return
        }
        if (req.method === 'POST' && p === `${HARDWARE_ROUTE_PREFIX}/fabrication`) {
          const body = await readJson(req) as Record<string, unknown>
          const artifactPath = asString(body.path)
          if (artifactPath === undefined) {
            sendJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'path is required' } })
            return
          }
          const schematic = asString(body.schematic)
          const { roots, sessionId } = await authorizeRequest(options, url, body)
          try {
            const prepared = await service.fabricate({
              boardPath: artifactPath,
              ...(schematic === undefined ? {} : { schematicPath: schematic }),
              roots,
              ...(sessionId === undefined ? {} : { sessionId }),
            })
            sendJson(res, 200, {
              ok: true,
              boardPath: prepared.boardPath,
              revision: prepared.revision,
              generatedAt: prepared.generatedAt,
              facts: prepared.facts,
              archive: prepared.archive,
              validation: prepared.validation,
              ...(prepared.assembly === undefined ? {} : { assembly: prepared.assembly }),
            })
          } catch (error) {
            const { status, body: failureBody } = failure(error)
            sendJson(res, status, failureBody)
          }
          return
        }
        if (req.method === 'POST' && p === `${HARDWARE_ROUTE_PREFIX}/order/pcb`) {
          const body = await readJson(req) as Record<string, unknown>
          if (body.confirm !== true) {
            sendJson(res, 400, {
              ok: false,
              error: {
                code: 'confirmation-required',
                message: 'placing an order uploads the board files and requires explicit confirmation',
              },
            })
            return
          }
          const artifactPath = asString(body.path)
          if (artifactPath === undefined) {
            sendJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'path is required' } })
            return
          }
          const schematic = asString(body.schematic)
          const { roots, sessionId } = await authorizeRequest(options, url, body)
          try {
            const placed = await service.placeOrder({
              kind: 'pcb',
              boardPath: artifactPath,
              ...(schematic === undefined ? {} : { schematicPath: schematic }),
              roots,
              ...(sessionId === undefined ? {} : { sessionId }),
              ...(typeof body.quantity === 'number' ? { quantity: body.quantity } : {}),
              ...(body.launch === false ? { launch: false } : {}),
            })
            sendJson(res, 200, { ok: true, ...placed })
          } catch (error) {
            const { status, body: failureBody } = failure(error)
            sendJson(res, status, failureBody)
          }
          return
        }
        if (req.method === 'POST' && p === `${HARDWARE_ROUTE_PREFIX}/order/smt`) {
          const body = await readJson(req) as Record<string, unknown>
          if (body.confirm !== true) {
            sendJson(res, 400, {
              ok: false,
              error: {
                code: 'confirmation-required',
                message: 'placing an assembly order uploads the board, BOM and positions and requires explicit confirmation',
              },
            })
            return
          }
          const artifactPath = asString(body.path)
          if (artifactPath === undefined) {
            sendJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'path is required' } })
            return
          }
          const schematic = asString(body.schematic)
          const { roots, sessionId } = await authorizeRequest(options, url, body)
          try {
            const placed = await service.placeOrder({
              kind: 'smt',
              boardPath: artifactPath,
              ...(schematic === undefined ? {} : { schematicPath: schematic }),
              roots,
              ...(sessionId === undefined ? {} : { sessionId }),
              ...(typeof body.quantity === 'number' ? { quantity: body.quantity } : {}),
              ...(body.launch === false ? { launch: false } : {}),
            })
            sendJson(res, 200, { ok: true, ...placed })
          } catch (error) {
            const { status, body: failureBody } = failure(error)
            sendJson(res, status, failureBody)
          }
          return
        }
        if (req.method === 'POST' && p === `${HARDWARE_ROUTE_PREFIX}/order/open`) {
          const body = await readJson(req) as Record<string, unknown>
          const orderUrl = asString(body.url)
          if (orderUrl === undefined) {
            sendJson(res, 400, { ok: false, error: { code: 'invalid-request', message: 'url is required' } })
            return
          }
          try {
            const opened = service.openOrderUrl(orderUrl)
            sendJson(res, 200, { ok: true, ...opened })
          } catch (error) {
            const { status, body: failureBody } = failure(error)
            sendJson(res, status, failureBody)
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
          const { roots, sessionId } = await authorizeRequest(options, url, body)
          try {
            const bom = await service.exportBom({
              artifactPath,
              roots,
              ...(sessionId === undefined ? {} : { sessionId }),
            })
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
          const { roots, sessionId } = await authorizeRequest(options, url, body)
          try {
            const glb = await service.exportGlb({
              artifactPath,
              roots,
              ...(sessionId === undefined ? {} : { sessionId }),
            })
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

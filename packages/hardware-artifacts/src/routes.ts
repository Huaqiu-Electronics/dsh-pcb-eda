/** Read-only HTTP surface for the Hardware Engineering client. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { ArtifactKind, HardwareArtifactService, NativeApplication } from './service.js'
import type { ToolchainId, ToolchainManager } from './toolchain/index.js'

export const HARDWARE_ROUTE_PREFIX = '/api/v1/hardware'

/** Prefix owned by the toolchain capability, beside the artifact routes. */
export const TOOLCHAIN_ROUTE_PREFIX = `${HARDWARE_ROUTE_PREFIX}/toolchain`

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
  /** Toolchain status/validation/discovery/install surface, when mounted. */
  readonly toolchain?: ToolchainManager
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

/** The DSH session a request belongs to: a query field for reads, a body field for writes. */
function sessionOf(url: URL, body?: unknown): string | undefined {
  const fromBody = body === null || typeof body !== 'object'
    ? undefined
    : asString((body as Record<string, unknown>).session)
  return fromBody ?? asString(url.searchParams.get('session') ?? undefined)
}

/** Narrow one request field to a toolchain id. */
function toolOf(value: unknown): ToolchainId | undefined {
  return value === 'kicad' || value === 'solidcraft' ? value : undefined
}

/** The source vocabulary the save route accepts (`detected` is written by discovery). */
function sourceOf(value: unknown): 'manual' | 'browse' | 'download' | 'detected' | undefined {
  return value === 'manual' || value === 'browse' || value === 'download' || value === 'detected' ? value : undefined
}

/**
 * The toolchain surface: status, validate, save, browse, install, cancel,
 * discover, capabilities.
 *
 * Every handler answers a JSON envelope the client can render without guessing,
 * and every failure keeps a stable `code` so the UI can localise it (the same
 * vocabulary the installer uses, §7.2/§17). Nothing here starts work the caller
 * did not ask for: discovery and install are explicit POSTs.
 * @returns true when the request was answered.
 */
async function handleToolchain(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  manager: ToolchainManager,
): Promise<boolean> {
  const path = url.pathname
  if (!path.startsWith(TOOLCHAIN_ROUTE_PREFIX)) return false
  const route = path.slice(TOOLCHAIN_ROUTE_PREFIX.length)
  const badRequest = (message: string): true => {
    sendJson(res, 400, { ok: false, error: { code: 'invalid-request', message } })
    return true
  }

  if (req.method === 'GET' && route === '/status') {
    const jobId = asString(url.searchParams.get('job') ?? undefined)
    sendJson(res, 200, { ok: true, ...await manager.status(jobId) })
    return true
  }
  if (req.method === 'GET' && route === '/capabilities') {
    sendJson(res, 200, { ok: true, ...await manager.capabilities() })
    return true
  }
  if (req.method === 'GET' && route === '/job') {
    const id = asString(url.searchParams.get('id') ?? undefined)
    const job = id === undefined ? undefined : manager.job(id)
    if (job === undefined) {
      sendJson(res, 404, { ok: false, error: { code: 'unknown-job', message: 'no such installation job' } })
      return true
    }
    sendJson(res, 200, { ok: true, job })
    return true
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } })
    return true
  }

  const body = await readJson(req) as Record<string, unknown>
  if (route === '/validate' || route === '/save') {
    const tool = toolOf(body.tool)
    const input = asString(body.path)
    if (tool === undefined) return badRequest('tool must be kicad or solidcraft')
    if (input === undefined) return badRequest('path is required')
    const source = sourceOf(body.source) ?? 'manual'
    const outcome = route === '/save'
      ? await manager.save(tool, input, source)
      : await manager.validate(tool, input)
    sendJson(res, 200, { tool, ...outcome })
    return true
  }
  if (route === '/browse') {
    const tool = toolOf(body.tool)
    if (tool === undefined) return badRequest('tool must be kicad or solidcraft')
    const abort = new AbortController()
    const timer = setTimeout(() => { abort.abort() }, 15 * 60_000)
    timer.unref?.()
    try {
      const outcome = await manager.browse(tool, abort.signal)
      sendJson(res, 200, { ok: true, tool, ...outcome })
    } finally {
      clearTimeout(timer)
    }
    return true
  }
  if (route === '/install') {
    const tool = toolOf(body.tool)
    if (tool === undefined) return badRequest('tool must be kicad or solidcraft')
    const started = await manager.install(tool)
    if (started.error !== undefined) {
      // A manifest this host cannot install from is a state, not a crash: the
      // UI falls back to manual configuration (§14.2).
      sendJson(res, 200, { ok: false, tool, error: started.error })
      return true
    }
    sendJson(res, 200, { ok: true, tool, job: started.snapshot })
    return true
  }
  if (route === '/cancel') {
    const id = asString(body.id)
    if (id === undefined) return badRequest('id is required')
    sendJson(res, 200, { ok: true, cancelled: manager.cancel(id) })
    return true
  }
  if (route === '/discover') {
    const tool = body.tool === undefined ? undefined : toolOf(body.tool)
    if (body.tool !== undefined && tool === undefined) return badRequest('tool must be kicad or solidcraft')
    sendJson(res, 200, { ok: true, ...manager.startDiscovery(tool) })
    return true
  }
  badRequest(`unknown toolchain route ${route}`)
  return true
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
        if (options.toolchain !== undefined && await handleToolchain(req, res, url, options.toolchain)) return
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
          const sessionId = sessionOf(url)
          try {
            const source = await service.readSource({
              artifactPath,
              ...(revision === undefined ? {} : { expectedRevision: revision }),
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
          const sessionId = sessionOf(url, body)
          try {
            const prepared = await service.fabricate({
              boardPath: artifactPath,
              ...(schematic === undefined ? {} : { schematicPath: schematic }),
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
          const sessionId = sessionOf(url, body)
          try {
            const placed = await service.placeOrder({
              kind: 'pcb',
              boardPath: artifactPath,
              ...(schematic === undefined ? {} : { schematicPath: schematic }),
              ...(sessionId === undefined ? {} : { sessionId }),
              ...(typeof body.quantity === 'number' ? { quantity: body.quantity } : {}),
              ...(body.launch === true ? { launch: true } : {}),
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
          const sessionId = sessionOf(url, body)
          try {
            const placed = await service.placeOrder({
              kind: 'smt',
              boardPath: artifactPath,
              ...(schematic === undefined ? {} : { schematicPath: schematic }),
              ...(sessionId === undefined ? {} : { sessionId }),
              ...(typeof body.quantity === 'number' ? { quantity: body.quantity } : {}),
              ...(body.launch === true ? { launch: true } : {}),
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
          const sessionId = sessionOf(url, body)
          try {
            const bom = await service.exportBom({
              artifactPath,
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
          const sessionId = sessionOf(url, body)
          try {
            const glb = await service.exportGlb({
              artifactPath,
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

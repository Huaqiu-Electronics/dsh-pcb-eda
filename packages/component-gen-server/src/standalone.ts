/**
 * `@huaqiu/component-gen-server` — standalone server.
 *
 * A self-contained local server (no DSH host needed) that serves:
 *   - the `@huaqiu/component-gen-app` static bundle (dist),
 *   - the component-gen API (`/api/v1/huaqiu/component-gen/*`),
 *   - the `@huaqiu/dsh-auth` session routes (login bridge; the same
 *     `InMemoryHuaqiuAuthService` the DSH node half uses),
 *   - the `@huaqiu/dsh-artifacts` routes (preview artifact content).
 *
 * The generation backend is the plugin's own `createComponentGenBackend` —
 * same `runGenerate*` functions, no reimplementation. Auth is injected through
 * the dsh-auth public service; the backend never implements the login flow.
 *
 * Usage:
 *   hq-component-gen [--port 8787]
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { InMemoryHuaqiuAuthService, createAuthHandler, AUTH_ROUTE_PREFIX, type HuaqiuAuthService } from '@huaqiu/dsh-auth'
import { HuaqiuArtifactService, createArtifactsHandler, ARTIFACTS_ROUTE_PREFIX } from '@huaqiu/dsh-artifacts'
import { runGenerateSymbol, runGenerateFootprintFromImage, runGenerateFootprintFromDimensions, createComponentGenBackend, type SymbolFootprintEnv } from '@huaqiu/dsh-tool-symbol-footprint'
import { createComponentGenHandler } from './index.js'
import { HistoryStore } from './history.js'
import { COMPONENT_GEN_ROUTE_PREFIX } from './types.js'

const require = createRequire(import.meta.url)

export interface StandaloneServerOptions {
  port?: number
  host?: string
  /** component-gen-app dist dir (default: resolved from the package). */
  appDist?: string
  /** history dir (default `~/.dsh/component-gen/`). */
  historyDir?: string
  /** artifacts dir (default `~/.dsh/artifacts/`). */
  artifactsDir?: string
  authConfig?: Record<string, unknown> | null
  hitlLanguage?: 'zh' | 'en'
}

export interface StandaloneServer {
  server: ReturnType<typeof createServer>
  port: number
  auth: HuaqiuAuthService
  history: HistoryStore
  close(): Promise<void>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function resolveAppDist(override?: string): string {
  if (override) return resolve(override)
  try {
    const pkgPath = require.resolve('@huaqiu/component-gen-app/package.json')
    return join(pkgPath.replace(/package\.json$/, ''), 'dist')
  } catch {
    // Monorepo fallback (before publish): lib/standalone.mjs → packages/component-gen-app/dist
    // fileURLToPath (not `new URL(...).pathname`) so Windows paths do not get a
    // doubled drive prefix (`C:\C:\...`) once `resolve` roots the leading slash.
    const local = resolve(fileURLToPath(new URL('../../component-gen-app/dist', import.meta.url)))
    return local
  }
}

/** Static file responder with traversal protection. */
function serveStatic(root: string, urlPath: string, res: ServerResponse): void {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/')
  let rel = decoded === '/' ? '/index.html' : decoded
  if (rel.startsWith('/')) rel = rel.slice(1)
  const target = resolve(root, rel)
  if (!target.startsWith(resolve(root)) || !target.startsWith(root)) {
    res.writeHead(403); res.end('forbidden'); return
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    // SPA fallback: serve index.html for unknown non-asset paths.
    const idx = join(root, 'index.html')
    if (existsSync(idx)) {
      res.writeHead(200, { 'content-type': MIME['.html'] })
      res.end(readFileSync(idx))
      return
    }
    res.writeHead(404); res.end('not found'); return
  }
  res.writeHead(200, { 'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream' })
  res.end(readFileSync(target))
}

export async function createStandaloneServer(options: StandaloneServerOptions = {}): Promise<StandaloneServer> {
  const port = options.port ?? 8787
  const host = options.host ?? '127.0.0.1'
  const appDist = resolveAppDist(options.appDist)
  const history = new HistoryStore(options.historyDir ?? dshHomePath('component-gen'))

  const auth = new InMemoryHuaqiuAuthService(options.authConfig as never)
  const artifacts = new HuaqiuArtifactService({ baseDir: options.artifactsDir ?? dshHomePath('artifacts') })

  const env: SymbolFootprintEnv = {
    auth: auth.auth,
    artifacts,
    hitlLanguage: options.hitlLanguage ?? 'zh',
    deps: { processEnv: typeof process !== 'undefined' ? process.env : undefined },
    // The app is the driver: never pause on the native HIL popup.
    getUserQuestions: () => undefined,
  }
  const backend = createComponentGenBackend(env)
  const componentGen = createComponentGenHandler({
    backend,
    history,
    hostMode: auth.hostMode,
  })

  const server = createServer(async (req, res) => {
    const urlPath = req.url ?? '/'
    if (urlPath.startsWith(AUTH_ROUTE_PREFIX)) {
      await createAuthHandler(auth)(req, res)
      return
    }
    if (urlPath.startsWith(ARTIFACTS_ROUTE_PREFIX)) {
      await createArtifactsHandler(artifacts)(req, res)
      return
    }
    if (urlPath.startsWith(COMPONENT_GEN_ROUTE_PREFIX)) {
      await componentGen(req, res)
      return
    }
    serveStatic(appDist, urlPath, res)
  })

  await new Promise<void>((resolveListen) => {
    server.listen(port, host, resolveListen)
  })

  return {
    server,
    port,
    auth,
    history,
    close: async () => new Promise((resolveClose) => server.close(() => resolveClose())),
  }
}

/** CLI entry (`hq-component-gen`). */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let port = 8787
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = Number(args[i + 1])
  }
  const app = await createStandaloneServer({ port })
  const urls = [`http://localhost:${app.port}/?page=footprint`, `http://localhost:${app.port}/?page=symbol`]
  console.log(`[hq-component-gen] standalone server on ${urls[0]}`)
  console.log(`[hq-component-gen] symbol:  ${urls[1]}`)
}

if (process.argv[1] && /standalone/.test(process.argv[1])) {
  void main()
}

/**
 * Node half of `@huaqiu/dsh-hardware-ui`.
 *
 * It does exactly one thing: serve the packaged STEP reader's WebAssembly
 * module to the browser half, from this plugin's own files, over the Host's
 * existing HTTP server. Everything else this product does is browser-side.
 *
 * Why this route exists at all. The client bundle is a single classic script
 * loaded by DSH's module loader; it has no `import.meta.url` and no asset route
 * of its own, so a 7.6 MB `.wasm` beside it has no URL the renderer can fetch.
 * The alternatives were worse: base64-inlining the module into `client.js` would
 * make every DSH start parse 10 MB of text whether or not a STEP file is ever
 * opened, and fetching from a CDN is forbidden outright — the preview must work
 * with no network (`docs/tasks/…full-impl-code-spec.md` §7.4, §12.3).
 *
 * The served bytes are a build artefact of a declared dependency, not workspace
 * content: the request carries no path parameter, the file is resolved once at
 * load through Node's own module resolution, and the response is immutable. No
 * user-controlled string ever reaches a filesystem call here, which is why this
 * is not the "second filesystem server" the spec rules out.
 *
 * When the Host has no HTTP server (Electron file:// + IPC), nothing is
 * registered and the STEP body reports the reader as unavailable in-document —
 * a degraded viewer, never a broken app.
 *
 * @module @huaqiu/dsh-hardware-ui
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { OCCT_WASM_FILE, OCCT_WASM_ROUTE } from './shared/occt-asset.js'

export const name = '@huaqiu/dsh-hardware-ui'

/** The tab kind owned by this product UI. */
export const HARDWARE_TAB_KIND = 'hardware-engineering'

/**
 * Slots this product UI occupies, plus the DSH seats it depends on.
 *
 * `conversation.session.header.corner` is DSH's own expand button (we occupy
 * nothing there); it is listed because the product depends on it. The document
 * seats are contributed by the browser half through DSH's document-preview
 * registry, not by taking over the MDI.
 */
export const HARDWARE_UI_SLOTS = Object.freeze([
  'conversation.session.header.corner',
  'sidebar.right.pane.tab',
  'sidebar.right.tab.document',
  'settings.section',
  // First-run toolchain step, its transient notices, and the quiet sidebar dot.
  'settings.onboarding',
  'shell.overlay',
  'sidebar.footer.action',
] as const)

/** Structural view of the Host route seat; declared locally to keep this half dependency-free. */
interface RouteSeat {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface HostLike {
  effect?(fn: () => (() => void) | void, label?: string): void
  /**
   * Cordis's nested injection. `webServer` is a *dependency*, not a precondition:
   * reading `ctx.webServer` directly would make the whole product UI absent on a
   * Host without an HTTP server, so it is acquired here and the rest of the
   * plugin never learns whether it exists.
   */
  inject?(dependencies: readonly string[], callback: (scope: HostLike & { readonly webServer: RouteSeat }) => void): void
}

/** Resolved absolute path of the packaged reader, or undefined when the dependency is missing. */
function wasmFile(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    return path.join(path.dirname(require.resolve('occt-import-js/package.json')), 'dist', OCCT_WASM_FILE)
  } catch {
    return undefined
  }
}

/** Bytes are read once per process: the file cannot change while the app runs. */
let cached: Buffer | undefined

function wasmBytes(): Buffer | undefined {
  if (cached !== undefined) return cached
  const file = wasmFile()
  if (file === undefined) return undefined
  try {
    cached = readFileSync(file)
    return cached
  } catch {
    return undefined
  }
}

/**
 * Node half entry.
 *
 * Registers the reader route when the Host serves HTTP; on a Host without one
 * (Electron file:// + IPC) this intentionally does nothing and the STEP body
 * reports the reader as unavailable.
 * @param ctx - Host context; the web server is acquired through nested injection.
 */
export function apply(ctx: HostLike): void {
  if (ctx.inject === undefined) return
  ctx.inject(['webServer'], (scope) => {
    const server = scope.webServer
    const install = (): (() => void) | void => server.register({
      kind: 'exact',
      path: OCCT_WASM_ROUTE,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        const bytes = wasmBytes()
        if (bytes === undefined) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('occt-import-js.wasm is not installed')
          return
        }
        res.writeHead(200, {
          'content-type': 'application/wasm',
          'content-length': String(bytes.byteLength),
          // The module is versioned by the installed dependency, so a client that
          // has it may keep it for the life of the app session.
          'cache-control': 'private, max-age=86400',
        })
        if (req.method === 'HEAD') res.end()
        else res.end(bytes)
      },
    })
    if (scope.effect !== undefined) scope.effect(install, 'hardware-ui: STEP reader asset')
    else void install()
  })
}

/**
 * @huaqiu/dsh-tool-pcb-viewer — DSH host 半边。
 *
 * 职责：
 * - `pcb_preview` 工具：接收 .kicad_pcb 路径（绝对或相对会话工作目录），用
 *   @huaqiu/kicad-sexpr-parser + ./adapter.js 解析出板子统计信息，并把文件登记到
 *   一个 key 上供客户端经 webServer 路由拉取。
 * - 只读路由 /pcb-viewer/api/file?key=…：把登记的板文件文本发给浏览器半边
 *   （文件可能上百 MB，不走工具结果本体）。
 * - /pcb-viewer/view + /pcb-viewer/standalone.js：「浏览器打开」整页。
 * - systemPrompt 段：告诉模型何时调用 pcb_preview。
 *
 * 渲染全部发生在浏览器半边（lib/client.js，经 exports["./client"] + dsh.client 加载）。
 *
 * @module @huaqiu/dsh-tool-pcb-viewer
 */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { parseBoard } from './parse.js'

/** Plugin id — matches package.json. */
export const name = '@huaqiu/dsh-tool-pcb-viewer'

/**
 * Cordis services this half depends on.
 */
export const inject = ['tools', 'systemPrompt', 'webServer', 'sessions'] as const

export interface PcbViewerPluginConfig {
  /** max .kicad_pcb file size in bytes (default 120MB). */
  maxFileBytes?: number
}

// 独立页 bundle 的修订号（文件名 + mtime），改了 bundle 自动换 URL
const bundleRev = (() => {
  try {
    const f = path.join(path.dirname(fileURLToPath(import.meta.url)), 'standalone.js')
    const st = fs.statSync(f)
    return `${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}`
  } catch { return '' }
})()

const GUIDANCE = `## pcb_preview 工具
- 当用户给出 .kicad_pcb 文件路径、或要求查看/预览/渲染 PCB 板子时，调用 pcb_preview。
- path 支持绝对路径，或相对会话工作目录的路径。
- 调用成功后用户会在右侧面板看到实时的「2D 走线视图 + 3D 渲染」大屏，可点击放大到全屏。
- 不要在回复里粘贴文件内容；只需告诉用户已打开预览即可。`

// key → absolute file path（已校验）。
// 有意决策：registry 有界（32 条 FIFO 逐出最旧），key 用不可枚举的 randomUUID。
// 信任边界：DSH 本机服务（Host 必须 localhost；带 Origin 时也必须 localhost）。
const registry = new Map<string, string>()
const REGISTRY_CAP = 32
function registrySet(key: string, file: string): void {
  if (registry.size >= REGISTRY_CAP) {
    const oldest = registry.keys().next().value
    if (oldest !== undefined) registry.delete(oldest)
  }
  registry.set(key, file)
}

interface ExecWithSession {
  sessionId?: string
  session?: { id?: string }
  context?: { sessionId?: string }
}

function sessionCwdOf(ctx: Context, exec: unknown): string | null {
  const e = exec as ExecWithSession | undefined
  const sid = e?.sessionId ?? e?.session?.id ?? e?.context?.sessionId
  const sessions = ctx.sessions as unknown as { get?: (id: string) => { header?: { cwd?: unknown } } | undefined } | undefined
  const cwd = sid ? sessions?.get?.(sid)?.header?.cwd : null
  return typeof cwd === 'string' && cwd ? cwd : null
}

function resolveBoardPath(ctx: Context, exec: unknown, input: unknown): string {
  const p = String(input ?? '').trim()
  if (!p) throw Object.assign(new Error('path is required'), { status: 400 })
  if (path.isAbsolute(p)) return path.resolve(p)
  const cwd = sessionCwdOf(ctx, exec) ?? process.cwd()
  return path.resolve(cwd, p)
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
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(origin))) return false
  return true
}

export interface BoardStats {
  sizeKB: number
  comps: number
  pads: number
  traces: number
  zones: number
  vias: number
  layers: number
  widthMM: number
  heightMM: number
}

async function readStats(filePath: string, config: Required<PcbViewerPluginConfig>): Promise<BoardStats> {
  const stat = await fs.promises.stat(filePath)
  if (stat.size > config.maxFileBytes) {
    throw Object.assign(new Error(`file too large: ${(stat.size / 1048576).toFixed(1)}MB > ${(config.maxFileBytes / 1048576).toFixed(0)}MB`), { status: 413 })
  }
  // IO 异步化，不再在事件循环上等磁盘；parse 是 CPU 密集同步计算（进 Worker 另行评估）。
  const text = await fs.promises.readFile(filePath, 'utf8')
  const b = parseBoard(text)
  return {
    sizeKB: Math.round(stat.size / 1024),
    comps: b.comps.length,
    pads: b.comps.reduce((s, c) => s + c.pads.length, 0),
    traces: b.traces.length,
    zones: b.zones.length,
    vias: b.vias.length,
    layers: b.cuLayers.length,
    widthMM: +(b.bbox.x1 - b.bbox.x0).toFixed(1),
    heightMM: +(b.bbox.y1 - b.bbox.y0).toFixed(1),
  }
}

/** Shape of the tool's JSON payload — consumed by the browser half. */
interface PreviewValue {
  ok: boolean
  name?: string
  path?: string
  key?: string
  viewUrl?: string
  stats?: BoardStats
  error?: string
}

export function apply(ctx: Context, config: PcbViewerPluginConfig = {}): () => void {
  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('@huaqiu/dsh-tool-pcb-viewer requires the DSH `tools` service (ctx.tools.register).')
  }
  const cfg: Required<PcbViewerPluginConfig> = {
    maxFileBytes: config.maxFileBytes ?? 120 * 1024 * 1024,
  }

  // 只读文件路由：客户端拿 key 换板文件文本。
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/pcb-viewer',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (!isTrustedRequest(req)) {
          sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          const p = url.pathname

          // 板文件文本（面板与独立页都从这里取）
          if (p === '/pcb-viewer/api/file') {
            const key = url.searchParams.get('key') ?? ''
            const file = registry.get(key)
            if (!file) { sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown file key' } }); return }
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
            fs.createReadStream(file).pipe(res)
            return
          }

          // 独立整页（「浏览器打开」新标签页）——自包含 bundle
          if (p === '/pcb-viewer/view') {
            const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>PCB 3D</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#090b0f}#app{position:fixed;inset:0}</style>
</head><body><div id="app"></div>
<script src="/pcb-viewer/standalone.js${bundleRev ? `?rev=${bundleRev}` : ''}"></script>
</body></html>`
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            res.end(html)
            return
          }

          if (p === '/pcb-viewer/standalone.js') {
            const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'standalone.js')
            if (!fs.existsSync(file)) {
              res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('standalone bundle missing — run: pnpm build')
              return
            }
            res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
            fs.createReadStream(file).pipe(res)
            return
          }

          sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown pcb-viewer route' } })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
        }
      },
    }), 'dsh-tool-pcb-viewer: /pcb-viewer routes')
  }

  ctx.systemPrompt.section({ name: 'tool:pcb_preview', order: 107, text: GUIDANCE })

  const tool = defineTool({
    name: 'pcb_preview',
    description:
      'Render a KiCad .kicad_pcb file as an interactive 2D layout + 3D board view ' +
      'embedded in the conversation. Use whenever the user gives a .kicad_pcb path ' +
      'or asks to view/preview/render a PCB board.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path, or path relative to the session working directory',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const v = value as unknown as PreviewValue
        if (!v || v.ok !== true) return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
        const s = v.stats ?? {} as Partial<BoardStats>
        // 第一块：给模型/用户看的人话摘要；第二块：给浏览器半边解析（面板据此打开）。
        return [
          {
            type: 'text' as const,
            text: `PCB 预览已打开：${v.name}（${s.widthMM}×${s.heightMM}mm，${s.layers} 层，${s.comps} 器件 / ${s.pads} 焊盘 / ${s.traces} 走线 / ${s.vias} 过孔）。右侧面板可见 2D 走线 + 3D 渲染，点击可放大。`,
          },
          { type: 'text' as const, text: JSON.stringify(v) },
        ]
      },
    },
    // 官方即时卡片：工具事件到达就渲染（不必等回合结束）。
    // 注意：视图词汇表没有 actions 字段，交互按钮仍由浏览器半边的卡片承担。
    presentCall(args) {
      const p = typeof args?.path === 'string' ? args.path : ''
      return {
        card: 'generic' as const,
        title: p ? `PCB 预览：${path.basename(p)}` : 'PCB 预览',
        kind: 'read' as const,
        ...(p ? { locations: [{ path: p }] } : {}),
      }
    },
    presentResult(_args, result) {
      let info: PreviewValue | null = null
      for (const block of result?.content ?? []) {
        if (block?.type !== 'text') continue
        try {
          const parsed = JSON.parse(block.text) as PreviewValue
          if (parsed && parsed.ok === true && parsed.stats) { info = parsed; break }
        } catch { /* not the JSON block */ }
      }
      if (!info || !info.stats) return undefined
      const s = info.stats
      return {
        card: 'generic' as const,
        title: `PCB 预览：${info.name}`,
        content: [{
          type: 'text' as const,
          text: `${s.widthMM}×${s.heightMM}mm · ${s.layers} 层 · ${s.comps} 器件 · ${s.pads} 焊盘 · ${s.traces} 走线 · ${s.vias} 过孔`,
        }],
      }
    },
    async execute(args, exec) {
      const input = (args && typeof args === 'object' ? args : {}) as { path?: unknown }
      const filePath = resolveBoardPath(ctx, exec, input.path)
      if (!/\.kicad_pcb$/i.test(filePath)) {
        return { ok: false, error: `not a .kicad_pcb file: ${filePath}` } as unknown as JsonValue
      }
      if (!fs.existsSync(filePath)) {
        return { ok: false, error: `file not found: ${filePath}` } as unknown as JsonValue
      }
      const stats = await readStats(filePath, cfg)
      const key = `pcb-${randomUUID()}`
      registrySet(key, filePath)
      return {
        ok: true,
        name: path.basename(filePath),
        path: filePath,
        key,
        viewUrl: `/pcb-viewer/api/file?key=${key}`,
        stats,
      } as unknown as JsonValue
    },
  })
  const unregister = ctx.tools.register(tool)

  return () => { if (typeof unregister === 'function') unregister() }
}

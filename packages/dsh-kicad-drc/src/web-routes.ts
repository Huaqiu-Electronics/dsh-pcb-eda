/**
 * /drc-report Web 路由：把 DRC 报告 JSON 提供给浏览器半边（client 插件）。
 *
 * 模式与 @huaqiu/dsh-tool-pcb-viewer 一致：
 * - host 端在工具执行成功后，把 drc.json 文件路径登记到一个 key 上；
 * - 浏览器经 /drc-report/api/report?key=… 拉取报告全文（不走工具结果本体，
 *   避免大 JSON 进会话上下文）；
 * - 仅信任 localhost 来源的请求（DSH web server 只监听本机）。
 */
import { createReadStream, existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 注册表容量上限（超出淘汰最旧条目，防止长会话内存增长）。 */
const REGISTRY_CAP = 16

/** DRC 报告登记表：key → drc.json 文件绝对路径。 */
export interface ReportRegistry {
  register(key: string, reportPath: string): void
  get(key: string): string | undefined
}

export function createReportRegistry(): ReportRegistry {
  const map = new Map<string, string>()
  return {
    register(key, reportPath) {
      if (map.size >= REGISTRY_CAP) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) map.delete(oldest)
      }
      map.set(key, reportPath)
    },
    get: (key) => map.get(key),
  }
}

/** 仅接受本机（localhost/127.0.0.1/[::1]）来源的请求。 */
export function isTrustedRequest(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? '')
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return false
  const origin = req.headers.origin
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(origin))) return false
  return true
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * 创建 /drc-report 前缀路由 handler。
 *
 * GET /drc-report/api/report?key=<key> → 流式返回登记的 drc.json（application/json）。
 * key 未知或文件已删除 → 404 JSON；非本机来源 → 403 JSON。
 */
export function createDrcReportHandler(registry: ReportRegistry) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      return
    }
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      if (url.pathname === '/drc-report/api/report') {
        const key = url.searchParams.get('key') ?? ''
        const reportPath = registry.get(key)
        if (!reportPath || !existsSync(reportPath)) {
          sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown report key or file missing' } })
          return
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        createReadStream(reportPath).pipe(res)
        return
      }
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown drc-report route' } })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: { code: 'internal', message: e instanceof Error ? e.message : String(e) } })
    }
  }
}

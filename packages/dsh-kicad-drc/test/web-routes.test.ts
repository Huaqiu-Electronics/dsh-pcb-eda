import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReportRegistry, createDrcReportHandler, isTrustedRequest } from '../src/web-routes.ts'

/** 模拟 ServerResponse（Writable + writeHead/end）。 */
class MockRes extends Writable {
  status = 0
  headers: Record<string, string> = {}
  chunks: Buffer[] = []
  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status
    Object.assign(this.headers, headers ?? {})
    return this
  }
  // 不覆写 end：Writable.end(chunk) 内部会走 _write 再触发 finish，统一在此收集
  _write(chunk: Buffer, _enc: string, cb: (e?: Error) => void): void {
    this.chunks.push(chunk)
    cb()
  }
  get body(): string {
    return Buffer.concat(this.chunks).toString('utf-8')
  }
}

function mockReq(url: string, host = '127.0.0.1:60330', origin?: string): IncomingMessage {
  const headers: Record<string, string> = { host }
  if (origin) headers.origin = origin
  return { url, headers } as unknown as IncomingMessage
}

function finish(res: MockRes): Promise<void> {
  return new Promise((resolve) => res.on('finish', resolve))
}

test('ReportRegistry：登记/读取/容量淘汰', () => {
  const reg = createReportRegistry()
  reg.register('a', '/tmp/a.json')
  assert.equal(reg.get('a'), '/tmp/a.json')
  assert.equal(reg.get('missing'), undefined)
  // 容量上限 16：写入第 17 个后最旧的被淘汰
  for (let i = 0; i < 16; i++) reg.register(`k${i}`, `/tmp/k${i}.json`)
  assert.equal(reg.get('a'), undefined, '最旧条目 a 应被淘汰')
  assert.equal(reg.get('k15'), '/tmp/k15.json')
})

test('isTrustedRequest：本机放行，外部来源拒绝', () => {
  assert.ok(isTrustedRequest(mockReq('/x')))
  assert.ok(isTrustedRequest(mockReq('/x', 'localhost:3080')))
  assert.ok(!isTrustedRequest(mockReq('/x', '47.100.4.100:8080')))
  assert.ok(!isTrustedRequest(mockReq('/x', '127.0.0.1:3080', 'http://evil.example.com')))
  assert.ok(isTrustedRequest(mockReq('/x', '127.0.0.1:3080', 'http://localhost:3080')))
})

test('handler：未知 key → 404 JSON', async () => {
  const handler = createDrcReportHandler(createReportRegistry())
  const res = new MockRes()
  handler(mockReq('/drc-report/api/report?key=nope'), res as unknown as ServerResponse)
  await finish(res)
  assert.equal(res.status, 404)
  assert.match(res.body, /not-found/)
})

test('handler：已登记且文件存在 → 200 流式返回 JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drc-routes-'))
  try {
    const reportPath = join(dir, 'board_drc.json')
    writeFileSync(reportPath, '{"kicad_version":"10.0.6","violations":[]}')
    const reg = createReportRegistry()
    reg.register('abc', reportPath)
    const handler = createDrcReportHandler(reg)
    const res = new MockRes()
    handler(mockReq('/drc-report/api/report?key=abc'), res as unknown as ServerResponse)
    await finish(res)
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /application\/json/)
    assert.deepEqual(JSON.parse(res.body), { kicad_version: '10.0.6', violations: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('handler：key 已登记但文件被删 → 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drc-routes-'))
  try {
    const reportPath = join(dir, 'gone.json')
    writeFileSync(reportPath, '{}')
    rmSync(reportPath)
    const reg = createReportRegistry()
    reg.register('abc', reportPath)
    const handler = createDrcReportHandler(reg)
    const res = new MockRes()
    handler(mockReq('/drc-report/api/report?key=abc'), res as unknown as ServerResponse)
    await finish(res)
    assert.equal(res.status, 404)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('handler：非本机来源 → 403', async () => {
  const handler = createDrcReportHandler(createReportRegistry())
  const res = new MockRes()
  handler(mockReq('/drc-report/api/report?key=abc', '47.100.4.100:8080'), res as unknown as ServerResponse)
  await finish(res)
  assert.equal(res.status, 403)
})

test('handler：未知子路径 → 404', async () => {
  const handler = createDrcReportHandler(createReportRegistry())
  const res = new MockRes()
  handler(mockReq('/drc-report/whatever'), res as unknown as ServerResponse)
  await finish(res)
  assert.equal(res.status, 404)
})

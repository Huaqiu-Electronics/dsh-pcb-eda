import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteExecutor } from '../src/remote-executor.ts'

/** 构造 JSON Response。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const REPORT_BODY = { kicad_version: '9.0.0', source: 'board.kicad_pcb', clearance: [] }

/** 临时目录 + PCB 文件夹具，返回清理函数。 */
function makeFixture(): { dir: string, pcb: string, cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'kicad-drc-remote-'))
  const pcb = join(dir, 'board.kicad_pcb')
  writeFileSync(pcb, '(kicad_pcb (version 20241120))')
  return { dir, pcb, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('RemoteExecutor 共享磁盘模式：从 outputFilePaths 读报告并持久化到 PCB 同目录', async () => {
  const { dir, pcb, cleanup } = makeFixture()
  try {
    // 模拟 cli-runner 产物落在"共享磁盘"上
    const sharedReport = join(dir, 'shared-drc.json')
    writeFileSync(sharedReport, JSON.stringify(REPORT_BODY))

    let postCalls = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => {
      postCalls++
      return jsonResponse({
        exitCode: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false,
        workDir: '/data/kicad/drc/x', outputFilePaths: { 'drc.json': sharedReport }, elapsedMillis: 10,
      })
    }
    try {
      const executor = new RemoteExecutor({ baseUrl: 'http://unit-test', workDirRoot: '/data/kicad/drc', fileBaseUrl: '' })
      const result = await executor.run({ pcbPath: pcb })
      assert.equal(postCalls, 1)
      assert.equal(result.exitCode, 0)
      assert.ok(result.drcJson)
      // 持久化到 PCB 同目录，命名 <pcb名>_drc.json
      assert.ok(result.drcJsonPath?.endsWith('board_drc.json'))
      assert.ok(existsSync(result.drcJsonPath as string))
      assert.deepEqual(JSON.parse(readFileSync(result.drcJsonPath as string, 'utf-8')), REPORT_BODY)
    } finally {
      globalThis.fetch = realFetch
    }
  } finally {
    cleanup()
  }
})

test('RemoteExecutor exit 0 但报告未取回：stderr 显式标注', async () => {
  const { pcb, cleanup } = makeFixture()
  try {
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => jsonResponse({
      exitCode: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false,
      workDir: '/data/kicad/drc/x', outputFilePaths: {}, elapsedMillis: 10,
    })
    try {
      const executor = new RemoteExecutor({ baseUrl: 'http://unit-test', fileBaseUrl: '' })
      const result = await executor.run({ pcbPath: pcb })
      assert.equal(result.exitCode, 0)
      assert.equal(result.drcJson, null)
      assert.match(result.stderr, /未能取回 drc\.json/)
    } finally {
      globalThis.fetch = realFetch
    }
  } finally {
    cleanup()
  }
})

test('RemoteExecutor HTTP 500 后重试一次成功', async () => {
  const { dir, pcb, cleanup } = makeFixture()
  try {
    const sharedReport = join(dir, 'shared-drc.json')
    writeFileSync(sharedReport, JSON.stringify(REPORT_BODY))

    let calls = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => {
      calls++
      if (calls === 1) return jsonResponse({ error: 'boom' }, 500)
      return jsonResponse({
        exitCode: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false,
        workDir: '/data/kicad/drc/x', outputFilePaths: { 'drc.json': sharedReport }, elapsedMillis: 10,
      })
    }
    try {
      const executor = new RemoteExecutor({ baseUrl: 'http://unit-test', fileBaseUrl: '' })
      const result = await executor.run({ pcbPath: pcb })
      assert.equal(calls, 2, '第一次 500，第二次成功')
      assert.equal(result.exitCode, 0)
      assert.ok(result.drcJson)
    } finally {
      globalThis.fetch = realFetch
    }
  } finally {
    cleanup()
  }
})

test('RemoteExecutor HTTP 下载模式：fileBaseUrl 拼接 URL 拉取报告', async () => {
  const { pcb, cleanup } = makeFixture()
  try {
    let calls = 0
    const urls: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
      calls++
      const url = String(input)
      urls.push(url)
      if (calls === 1) {
        // POST /api/cli/run-with-file
        return jsonResponse({
          exitCode: 0, stdout: 'ok', stderr: '', truncated: false, timedOut: false,
          workDir: '/data/kicad/drc/x', outputFilePaths: { 'drc.json': '/data/kicad/drc/x/drc.json' }, elapsedMillis: 10,
        })
      }
      // GET fileBaseUrl + remotePath
      return new Response(JSON.stringify(REPORT_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    try {
      const executor = new RemoteExecutor({ baseUrl: 'http://unit-test', fileBaseUrl: 'http://files.example.com' })
      const result = await executor.run({ pcbPath: pcb })
      assert.equal(calls, 2)
      assert.equal(urls[0], 'http://unit-test/api/cli/run-with-file')
      assert.equal(urls[1], 'http://files.example.com/data/kicad/drc/x/drc.json')
      assert.ok(result.drcJson)
      assert.deepEqual(JSON.parse(result.drcJson as string), REPORT_BODY)
    } finally {
      globalThis.fetch = realFetch
    }
  } finally {
    cleanup()
  }
})

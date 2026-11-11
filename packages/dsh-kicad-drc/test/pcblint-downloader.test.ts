import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  PcblintDownloader,
  type PcblintManifest,
} from '../src/pcblint-downloader.ts'
import {
  findPcblintInstallation,
  inspectPcblintHome,
} from '../src/pcblint-installation.ts'

/** 造一个完整的 pcblint-local 组件目录。 */
function createComponent(root: string, version?: string): string {
  const home = join(root, 'pcblint-local')
  mkdirSync(join(home, 'jre25', 'bin'), { recursive: true })
  mkdirSync(join(home, 'pcblint'), { recursive: true })
  writeFileSync(join(home, 'jre25', 'bin', 'java.exe'), '')
  writeFileSync(join(home, 'pcblint', 'pcblint.jar'), '')
  if (version !== undefined) {
    writeFileSync(join(home, 'pcblint', 'version.txt'), `${version}\n`)
  }
  return home
}

/** 构造一个内存 zip：最简单的 zip，根目录一层 pcblint-local/ 组件。 */
function makeComponentZip(version: string): Buffer {
  // 用 Buffer 手动拼一个合法的 zip（只有 Central Directory + Local File Headers）
  // 内容不重要，只要能被 unzipper.Open 解析
  const files: { name: string; content: Buffer }[] = [
    { name: 'pcblint-local/jre25/bin/java.exe', content: Buffer.alloc(0x4000) },
    { name: 'pcblint-local/pcblint/pcblint.jar', content: Buffer.alloc(0x8000) },
  ]
  return zipBuffers(files)
}

/** 极简 zip 构造器（只有 Stored，无压缩；支持 Central Directory）。 */
function zipBuffers(files: { name: string; content: Buffer }[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const { name, content } of files) {
    const nameBuf = Buffer.from(name, 'utf-8')
    const crc = crc32(content) >>> 0
    const size = content.length

    // Local file header
    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0)          // signature
    lfh.writeUInt16LE(20, 4)                   // version needed
    lfh.writeUInt16LE(0, 6)                    // flags
    lfh.writeUInt16LE(0, 8)                    // method (stored)
    lfh.writeUInt16LE(0, 10)                   // mod time
    lfh.writeUInt16LE(0x21, 12)                // mod date
    lfh.writeUInt32LE(crc, 14)                 // crc
    lfh.writeUInt32LE(size, 18)                // compressed
    lfh.writeUInt32LE(size, 22)                // uncompressed
    lfh.writeUInt16LE(nameBuf.length, 26)      // name len
    lfh.writeUInt16LE(0, 28)                   // extra len
    parts.push(lfh, nameBuf, content)

    // Central directory entry
    const cde = Buffer.alloc(46)
    cde.writeUInt32LE(0x02014b50, 0)
    cde.writeUInt16LE(20, 4)
    cde.writeUInt16LE(20, 6)
    cde.writeUInt16LE(0, 8)
    cde.writeUInt16LE(0, 10)
    cde.writeUInt16LE(0, 12)
    cde.writeUInt16LE(0x21, 14)
    cde.writeUInt32LE(crc, 16)
    cde.writeUInt32LE(size, 20)
    cde.writeUInt32LE(size, 24)
    cde.writeUInt16LE(nameBuf.length, 28)
    cde.writeUInt16LE(0, 30)
    cde.writeUInt16LE(0, 32)
    cde.writeUInt16LE(0, 34)
    cde.writeUInt16LE(0, 36)
    cde.writeUInt32LE(0, 38)
    cde.writeUInt32LE(offset, 42)
    central.push(cde, nameBuf)
    offset += 30 + nameBuf.length + size
  }

  const cdOffset = offset
  const cdSize = central.reduce((sum, b) => sum + b.length, 0)

  // End of central directory
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...parts, ...central, eocd])
}

/** IEEE 802.3 CRC32（zip 要求）。 */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  const table = crc32Table()
  for (const byte of buf) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

let _table: number[] | null = null
function crc32Table(): number[] {
  if (_table) return _table
  const table: number[] = []
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[i] = c >>> 0
  }
  _table = table
  return table
}

/** 构造一个 fake Response，能被 fetch 返回且带 ReadableStream body。 */
function fakeResponse(status: number, json?: unknown, bodyBuf?: Buffer): Response {
  if (json !== undefined) {
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
  }
  if (bodyBuf !== undefined) {
    const stream = Readable.toWeb(Readable.from(bodyBuf)) as ReadableStream<Uint8Array>
    const headers = new Headers({ 'content-length': String(bodyBuf.length) })
    return new Response(stream, { status, headers })
  }
  return new Response('', { status })
}

// --- 测试：manifest 校验 ---

test('PcblintDownloader：manifest 缺 latest 时抛错', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dl-test-'))
  try {
    const dl = new PcblintDownloader({
      manifestUrl: 'https://example.com/manifest.json',
      cacheRoot: join(tmp, 'cache'),
      installationFinder: () => null,
      fetchImpl: async () => fakeResponse(200, { url: 'http://x', sha256: 'a'.repeat(64) }),
    })
    await assert.rejects(
      () => dl.fetchManifest(),
      /缺少 latest/u,
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('PcblintDownloader：manifest 缺合法 sha256 时抛错', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dl-test-'))
  try {
    const dl = new PcblintDownloader({
      manifestUrl: 'https://example.com/manifest.json',
      cacheRoot: join(tmp, 'cache'),
      installationFinder: () => null,
      fetchImpl: async () => fakeResponse(200, { latest: '1.0', url: 'http://x', sha256: 'short' }),
    })
    await assert.rejects(
      () => dl.fetchManifest(),
      /sha256/u,
    )
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('PcblintDownloader：fetchManifest 成功并落盘缓存', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dl-test-'))
  try {
    const cacheRoot = join(tmp, 'cache')
    const dl = new PcblintDownloader({
      manifestUrl: 'https://example.com/manifest.json',
      cacheRoot,
      installationFinder: () => null,
      fetchImpl: async () => fakeResponse(200, {
        latest: '1.5.0',
        url: 'https://cdn/pcblint-local-1.5.0.zip',
        sha256: 'a'.repeat(64),
        minKiCad: '10.0.0',
      }),
    })
    const manifest = await dl.fetchManifest()
    assert.equal(manifest.latest, '1.5.0')
    assert.equal(manifest.minKiCad, '10.0.0')
    assert.ok(existsSync(join(cacheRoot, 'pcblint-manifest.json')))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// --- 测试：ensure 已装版本一致跳过下载 ---

test('PcblintDownloader：ensure 已装且版本一致时跳过下载', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dl-test-'))
  try {
    const cacheRoot = join(tmp, 'cache')
    const zipBuf = makeComponentZip('1.5.0')
    const expectedSha = createHash('sha256').update(zipBuf).digest('hex')

    let fetchCalls = 0
    const dl = new PcblintDownloader({
      manifestUrl: 'https://example.com/manifest.json',
      cacheRoot,
      installationFinder: () => {
        createComponent(cacheRoot, '1.5.0')
        return inspectPcblintHome(join(cacheRoot, 'pcblint-local'), 'cache')
      },
      fetchImpl: async () => {
        fetchCalls++
        return fakeResponse(200, {
          latest: '1.5.0',
          url: 'https://cdn/x.zip',
          sha256: expectedSha,
        })
      },
    })
    const result = await dl.ensure()
    assert.equal(result.source, 'cache')
    assert.equal(result.version, '1.5.0')
    // fetch 只被调用一次（拉 manifest），没有下载 zip
    assert.equal(fetchCalls, 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// --- 测试：ensure 触发完整下载流程 ---

test('PcblintDownloader：ensure 完整下载+解压+原子替换', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dl-test-'))
  try {
    const cacheRoot = join(tmp, 'cache')
    mkdirSync(cacheRoot, { recursive: true })
    const zipBuf = makeComponentZip('1.5.0')
    const expectedSha = createHash('sha256').update(zipBuf).digest('hex')

    const dl = new PcblintDownloader({
      manifestUrl: 'https://example.com/manifest.json',
      cacheRoot,
      installationFinder: () => null,
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.includes('manifest')) {
          return fakeResponse(200, {
            latest: '1.5.0',
            url: 'https://cdn/x.zip',
            sha256: expectedSha,
          })
        }
        return fakeResponse(200, undefined, zipBuf)
      },
    })
    const result = await dl.ensure()
    assert.equal(result.source, 'cache')
    assert.equal(result.version, '1.5.0')
    assert.ok(existsSync(join(cacheRoot, 'pcblint-local', 'jre25', 'bin', 'java.exe')))
    assert.ok(existsSync(join(cacheRoot, 'pcblint-local', 'pcblint', 'pcblint.jar')))
    // 原子替换后，.tmp-* 和 .bak 不应残留
    const entries = readDir(cacheRoot)
    assert.ok(!entries.some((e) => e.startsWith('.tmp-')), '残留临时文件')
    assert.ok(!entries.some((e) => e.endsWith('.bak')), '残留备份目录')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// --- 测试：ensure sha256 校验失败 ---

test('PcblintDownloader：zip sha256 校验失败时抛错且清理临时文件', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dl-test-'))
  try {
    const cacheRoot = join(tmp, 'cache')
    mkdirSync(cacheRoot, { recursive: true })
    const zipBuf = makeComponentZip('1.5.0')

    const dl = new PcblintDownloader({
      manifestUrl: 'https://example.com/manifest.json',
      cacheRoot,
      installationFinder: () => null,
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.includes('manifest')) {
          return fakeResponse(200, {
            latest: '1.5.0',
            url: 'https://cdn/x.zip',
            sha256: '0'.repeat(64), // 故意错误
          })
        }
        return fakeResponse(200, undefined, zipBuf)
      },
    })
    await assert.rejects(() => dl.ensure(), /sha256 校验失败/u)
    // 清理后不应有 pcblint-local 或 .tmp-*
    const entries = readDir(cacheRoot)
    assert.ok(!entries.some((e) => e.startsWith('.tmp-')))
    assert.ok(!entries.includes('pcblint-local'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// --- 测试：findPcblintInstallation 新优先级 ---

test('findPcblintInstallation：缓存目录优先于 kicad-cli 同级', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'find-test-'))
  try {
    const cacheHome = createComponent(join(tmp, 'cache'), '1.5.0')
    const besideHome = createComponent(join(tmp, 'kicad', 'bin'), '1.4.0')
    const found = findPcblintInstallation({
      cacheRoot: join(tmp, 'cache'),
      kicadCliPath: join(tmp, 'kicad', 'bin', 'kicad-cli.exe'),
      env: {},
    })
    assert.ok(found)
    assert.equal(found.home, cacheHome)
    assert.equal(found.source, 'cache')
    assert.equal(found.version, '1.5.0')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('findPcblintInstallation：缓存目录不完整时回退到 kicad-cli 同级', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'find-fallback-'))
  try {
    // 缓存目录不完整：只有 java.exe 没有 jar
    mkdirSync(join(tmp, 'cache', 'pcblint-local', 'jre25', 'bin'), { recursive: true })
    writeFileSync(join(tmp, 'cache', 'pcblint-local', 'jre25', 'bin', 'java.exe'), '')
    const besideHome = createComponent(join(tmp, 'kicad', 'bin'), '1.4.0')
    const found = findPcblintInstallation({
      cacheRoot: join(tmp, 'cache'),
      kicadCliPath: join(tmp, 'kicad', 'bin', 'kicad-cli.exe'),
      env: {},
    })
    assert.ok(found)
    assert.equal(found.home, besideHome)
    assert.equal(found.source, 'kicad-cli')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('findPcblintInstallation：所有来源都没有时返回 null', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'find-none-'))
  try {
    const found = findPcblintInstallation({
      cacheRoot: join(tmp, 'cache'),
      kicadCliPath: join(tmp, 'kicad', 'bin', 'kicad-cli.exe'),
      env: {},
    })
    assert.equal(found, null)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('findPcblintInstallation：显式 config 优先级最高，即使缓存有', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'find-priority-'))
  try {
    const configHome = createComponent(join(tmp, 'config'), '2.0.0')
    createComponent(join(tmp, 'cache'), '1.5.0')
    const found = findPcblintInstallation({
      configuredHome: configHome,
      cacheRoot: join(tmp, 'cache'),
      env: {},
    })
    assert.ok(found)
    assert.equal(found.home, configHome)
    assert.equal(found.source, 'config')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

/** 列出目录一级条目名，忽略不存在情况。 */
function readDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

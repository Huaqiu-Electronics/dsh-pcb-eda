/**
 * PCBLint 本地组件的云端下载器。
 *
 * 下载流程：manifest → fetch zip（流式 sha256 校验）→ 解压到临时目录 → 原子替换。
 * 不做后台静默更新，每次 `ensure()` 时同步检查 manifest，有更新则下载并阻塞本次 DRC。
 * 并发安全：同一时刻只跑一个下载任务，后续调用共享同一个 Promise。
 *
 * 原子替换协议（防中断留下半拉子目录）：
 *   1. 下载 → `<cacheRoot>/.tmp-<random>.zip`
 *   2. 解压 → `<cacheRoot>/pcblint-local.tmp/`
 *   3. 旧版本重命名为 `<cacheRoot>/pcblint-local.bak/`
 *   4. 新版本重命名为 `<cacheRoot>/pcblint-local/`
 *   5. 删除 `.bak/` 和 `.tmp-*.zip`
 *
 * 任何一步失败都清理 `.tmp-*`，不影响当前已安装版本。
 *
 * @module
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'
import { ExecutorError } from './executor.ts'
import { inspectPcblintHome, type PcblintInstallation } from './pcblint-installation.ts'

/** manifest 拉取超时（ms）。 */
const MANIFEST_TIMEOUT_MS = 10_000
/** zip 下载超时（ms）。 */
const DOWNLOAD_TIMEOUT_MS = 120_000
/** 解压超时（ms）。 */
const EXTRACT_TIMEOUT_MS = 30_000

/** manifest JSON 结构（云端发布方定义）。 */
export interface PcblintManifest {
  latest: string
  url: string
  sha256: string
  minKiCad?: string
  maxKiCad?: string
}

export type PcblintProgressCallback = (pct: number, phase: 'fetch' | 'extract') => void

export interface PcblintDownloaderOptions {
  manifestUrl: string
  cacheRoot: string
  installationFinder: () => PcblintInstallation | null
  fetchImpl?: typeof fetch
  onProgress?: PcblintProgressCallback
}

interface CachedManifest {
  fetchedAt: number
  manifest: PcblintManifest
}

export class PcblintDownloader {
  private readonly manifestUrl: string
  private readonly cacheRoot: string
  private readonly installationFinder: () => PcblintInstallation | null
  private readonly fetchImpl: typeof fetch
  private readonly onProgress?: PcblintProgressCallback

  private inFlight: Promise<PcblintInstallation> | null = null

  constructor(options: PcblintDownloaderOptions) {
    this.manifestUrl = options.manifestUrl
    this.cacheRoot = resolve(options.cacheRoot)
    this.installationFinder = options.installationFinder
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.onProgress = options.onProgress
  }

  /** 组件最终安装目录（下载完成后的组件根目录）。未下载时用于状态说明。 */
  get installedHome(): string {
    return this.activeDir
  }

  private get manifestCachePath(): string {
    return join(this.cacheRoot, 'pcblint-manifest.json')
  }

  private get activeDir(): string {
    return join(this.cacheRoot, 'pcblint-local')
  }

  async ensure(signal?: AbortSignal): Promise<PcblintInstallation> {
    if (this.inFlight) {
      return this.inFlight
    }
    const work = this.runEnsure(signal)
    this.inFlight = work.finally(() => {
      if (this.inFlight === work) {
        this.inFlight = null
      }
    })
    return this.inFlight
  }

  private async runEnsure(signal?: AbortSignal): Promise<PcblintInstallation> {
    const existing = this.installationFinder()
    if (existing) {
      try {
        const manifest = await this.fetchManifest(signal)
        if (existing.version && existing.version === manifest.latest) {
          return existing
        }
      } catch {
        // manifest 拉取失败：不阻塞已有组件
        return existing
      }
    }
    const manifest = await this.fetchManifest(signal)
    return this.downloadAndInstall(manifest, signal)
  }

  async fetchManifest(signal?: AbortSignal): Promise<PcblintManifest> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS)
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    let response: Response
    try {
      response = await this.fetchImpl(this.manifestUrl, {
        signal: controller.signal,
        cache: 'no-store',
      })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      throw new ExecutorError(`manifest 拉取失败：HTTP ${response.status}（${this.manifestUrl}）`)
    }
    let json: unknown
    try {
      json = await response.json()
    } catch {
      throw new ExecutorError('manifest 不是合法 JSON')
    }
    const manifest = validateManifest(json)
    mkdirSync(this.cacheRoot, { recursive: true })
    writeFileSync(
      this.manifestCachePath,
      JSON.stringify({ fetchedAt: Date.now(), manifest } satisfies CachedManifest, null, 2),
      'utf-8',
    )
    return manifest
  }

  readCachedManifest(): PcblintManifest | null {
    try {
      const text = readFileSync(this.manifestCachePath, 'utf-8')
      const parsed = JSON.parse(text) as CachedManifest
      if (!parsed?.manifest) return null
      return validateManifest(parsed.manifest)
    } catch {
      return null
    }
  }

  private async downloadAndInstall(
    manifest: PcblintManifest,
    signal?: AbortSignal,
  ): Promise<PcblintInstallation> {
    mkdirSync(this.cacheRoot, { recursive: true })
    const tmpZip = join(this.cacheRoot, `.tmp-${randomUUID()}.zip`)
    try {
      await this.streamDownload(manifest.url, tmpZip, manifest.sha256, signal)
      return await this.extractAndSwap(tmpZip, manifest.latest, signal)
    } catch (err) {
      rmSync(tmpZip, { force: true })
      rmSync(join(this.cacheRoot, 'pcblint-local.tmp'), { recursive: true, force: true })
      throw err
    }
  }

  private async streamDownload(
    url: string,
    destPath: string,
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    let response: Response
    try {
      response = await this.fetchImpl(url, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      throw new ExecutorError(`zip 下载失败：HTTP ${response.status}（${url}）`)
    }
    if (!response.body) {
      throw new ExecutorError('zip 响应没有 body')
    }
    const total = response.headers.get('content-length')
      ? Number.parseInt(response.headers.get('content-length')!, 10)
      : 0
    let downloaded = 0
    const hash = createHash('sha256')

    // DOM 的 ReadableStream 与 node:stream/web 的类型不同构，在适配边界显式转换
    const body = response.body as unknown as NodeWebReadableStream<Uint8Array>
    // 逐块更新 hash 与进度；背压、错误传播和监听器清理全部交给 pipeline
    const meter = new Transform({
      transform: (chunk, _encoding, callback) => {
        hash.update(chunk)
        downloaded += chunk.length
        if (total > 0 && this.onProgress) {
          this.onProgress(Math.round(downloaded / total * 100), 'fetch')
        }
        callback(null, chunk)
      },
    })

    try {
      await pipeline(Readable.fromWeb(body), meter, createWriteStream(destPath))
    } catch (err) {
      // 外部取消时 body 流会报 AbortError，统一转成可读的业务错误
      if (signal?.aborted) {
        throw new ExecutorError('下载被取消')
      }
      throw err
    }

    const actual = hash.digest('hex')
    if (actual !== expectedSha256.toLowerCase()) {
      throw new ExecutorError(`zip sha256 校验失败：期望 ${expectedSha256}，实际 ${actual}`)
    }
  }

  private async extractAndSwap(
    zipPath: string,
    version: string,
    signal?: AbortSignal,
  ): Promise<PcblintInstallation> {
    // 动态 import：只有下载时才需要解压库
    // eslint-disable-next-line @typescript-eslint/await-thenable
    const unzipper: typeof import('unzipper') = await import('unzipper')
    const tmpDir = join(this.cacheRoot, 'pcblint-local.tmp')
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })

    if (this.onProgress) {
      this.onProgress(0, 'extract')
    }

    const timer = setTimeout(() => {
      throw new ExecutorError('解压超时')
    }, EXTRACT_TIMEOUT_MS)

    try {
      const directory = await unzipper.Open.file(zipPath)
      let extracted = 0
      const total = directory.files.length
      for (const file of directory.files) {
        if (signal?.aborted) {
          throw new ExecutorError('解压被取消')
        }
        const resolved = resolve(tmpDir, file.path)
        if (!resolved.startsWith(tmpDir + '\\') && resolved !== tmpDir) {
          throw new ExecutorError(`zip 条目路径越界：${file.path}`)
        }
        if (file.type === 'Directory') {
          mkdirSync(resolved, { recursive: true })
        } else {
          mkdirSync(join(resolved, '..'), { recursive: true })
          // eslint-disable-next-line no-await-in-loop
          const content = await file.buffer()
          writeFileSync(resolved, content)
        }
        extracted++
        if (this.onProgress) {
          this.onProgress(Math.round(extracted / total * 100), 'extract')
        }
      }
    } finally {
      clearTimeout(timer)
    }

    const componentRoot = this.findComponentRoot(tmpDir)
    if (!componentRoot) {
      throw new ExecutorError('解压后未找到有效的 PCBLint 组件结构')
    }
    writeFileSync(join(componentRoot, 'pcblint', 'version.txt'), version, 'utf-8')

    const activeDir = this.activeDir
    const backupDir = join(this.cacheRoot, 'pcblint-local.bak')
    if (existsSync(backupDir)) {
      rmSync(backupDir, { recursive: true, force: true })
    }
    if (existsSync(activeDir)) {
      renameSync(activeDir, backupDir)
    }
    renameSync(componentRoot, activeDir)
    if (existsSync(backupDir)) {
      rmSync(backupDir, { recursive: true, force: true })
    }
    rmSync(tmpDir, { recursive: true, force: true })
    this.cleanupOldVersions()

    return inspectPcblintHome(activeDir, 'cache')
  }

  private findComponentRoot(tmpDir: string): string | null {
    const javaRel = join('jre25', 'bin', 'java.exe')
    const jarRel = join('pcblint', 'pcblint.jar')
    if (existsSync(join(tmpDir, javaRel)) && existsSync(join(tmpDir, jarRel))) {
      return tmpDir
    }
    for (const entry of readdirSync(tmpDir)) {
      const sub = join(tmpDir, entry)
      if (statSync(sub).isDirectory()
        && existsSync(join(sub, javaRel))
        && existsSync(join(sub, jarRel))) {
        return sub
      }
    }
    return null
  }

  cleanupOldVersions(): void {
    if (!existsSync(this.cacheRoot)) return
    for (const name of readdirSync(this.cacheRoot)) {
      if (name === 'pcblint-local') continue
      if (name === 'pcblint-manifest.json') continue
      if (name.startsWith('.tmp-') || name.endsWith('.bak') || name === 'pcblint-local.tmp') {
        rmSync(join(this.cacheRoot, name), { recursive: true, force: true })
      }
    }
  }
}

function validateManifest(json: unknown): PcblintManifest {
  if (!json || typeof json !== 'object') {
    throw new ExecutorError('manifest 格式错误：不是对象')
  }
  const obj = json as Record<string, unknown>
  const latest = obj.latest
  const url = obj.url
  const sha256 = obj.sha256
  if (typeof latest !== 'string' || !latest) throw new ExecutorError('manifest 缺少 latest')
  if (typeof url !== 'string' || !url) throw new ExecutorError('manifest 缺少 url')
  if (typeof sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(sha256)) {
    throw new ExecutorError('manifest 缺少合法的 sha256')
  }
  return {
    latest,
    url,
    sha256: sha256.toLowerCase(),
    ...(typeof obj.minKiCad === 'string' ? { minKiCad: obj.minKiCad } : {}),
    ...(typeof obj.maxKiCad === 'string' ? { maxKiCad: obj.maxKiCad } : {}),
  }
}

/**
 * `@huaqiu/dsh-artifacts` — user-wide, flat storage for ECAD preview artifacts
 * (KiCad symbol / footprint / schematic / pcb / zip) in DSH.
 *
 * Port of `hq-edge`'s `DshPreviewArtifactService` (apps/server/src/artifacts/
 * dsh-preview-artifacts.service.ts) with zero dependency on the HQ Edge
 * monorepo:
 *   - default root = `dshHomePath('artifacts')` (`~/.dsh/artifacts/`)
 *   - `node:crypto.randomUUID` instead of `uuid`
 *   - no logger framework (minimal internal logger)
 *   - hardening: strict `^art_[0-9a-f]+$` id, filename never in the storage
 *     path, max-size cap, atomic writes, TTL expiry
 *   - `readContent(): Promise<Uint8Array | null>` (no streaming abstraction)
 *
 * Layout on disk:
 *   <baseDir>/dsh-artifacts/<artifactId>/
 *     meta.json   # id, type, filename, mimeType, size, createdAt, expiresAt?
 *     content     # raw bytes
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

// ── Public types ────────────────────────────────────────────────────────────

export type ArtifactType = 'symbol' | 'footprint' | 'schematic' | 'pcb' | 'zip'

export interface ArtifactMeta {
  id: string
  type: ArtifactType
  filename: string
  mimeType: string
  size: number
  createdAt: string
  expiresAt?: string
}

export interface CreateArtifactInput {
  type: ArtifactType
  filename: string
  /** string is UTF-8 (or base64 when `contentEncoding === 'base64'`). */
  content: string | Uint8Array
  contentEncoding?: 'utf8' | 'base64'
  /** Optional TTL seconds from now; undefined = manual cleanup only. */
  ttlSeconds?: number
}

export interface CreateArtifactResult {
  id: string
  type: ArtifactType
  filename: string
  size: number
}

export interface ArtifactsServiceOptions {
  /**
   * Base directory hosting `dsh-artifacts/`. Defaults to
   * `dshHomePath('artifacts')` (`~/.dsh/artifacts/`). Overridable for tests.
   */
  baseDir?: string
  /** Hard cap on stored artifact bytes. Default 16 MiB. */
  maxBytes?: number
}

export interface HuaqiuArtifacts {
  create(input: CreateArtifactInput): Promise<CreateArtifactResult>
  get(id: string): Promise<ArtifactMeta | null>
  readContent(id: string): Promise<Uint8Array | null>
  delete(id: string): Promise<void>
  deleteAll(opts?: { onlyExpired?: boolean }): Promise<number>
}

// ── Internal helpers ────────────────────────────────────────────────────────

const VALID_TYPES: ReadonlySet<ArtifactType> = new Set([
  'symbol', 'footprint', 'schematic', 'pcb', 'zip',
])

function isValidArtifactType(v: unknown): v is ArtifactType {
  return typeof v === 'string' && VALID_TYPES.has(v as ArtifactType)
}

/** Opaque id we mint ourselves — hardened against any path use. */
const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]+$/

function mimeTypeFor(type: ArtifactType, filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.kicad_sym')) return 'application/x.kicad-symbol'
  if (lower.endsWith('.kicad_mod')) return 'application/x.kicad-footprint'
  if (lower.endsWith('.kicad_footprint')) return 'application/x.kicad-footprint'
  if (lower.endsWith('.kicad_sch')) return 'application/x.kicad-schematic'
  if (lower.endsWith('.kicad_pcb')) return 'application/x.kicad-pcb'
  if (lower.endsWith('.kicad_pro')) return 'application/x.kicad-project'
  if (lower.endsWith('.zip')) return 'application/zip'
  switch (type) {
    case 'symbol': return 'application/x.kicad-symbol'
    case 'footprint': return 'application/x.kicad-footprint'
    case 'schematic': return 'application/x.kicad-schematic'
    case 'pcb': return 'application/x.kicad-pcb'
    case 'zip': return 'application/zip'
  }
}

function toBytes(content: string | Uint8Array, encoding: 'utf8' | 'base64' | undefined): Uint8Array {
  if (typeof content === 'string') {
    return encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8')
  }
  return content instanceof Uint8Array ? content : new Uint8Array(content)
}

export function log(level: 'debug' | 'warn', msg: string, extra?: Record<string, unknown>): void {
  // Minimal, dependency-free logger. DSH plugins should not pull a logger lib.
  if (level === 'warn' || process.env.DSH_ARTIFACTS_DEBUG) {
    const line = `[dsh-artifacts] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`
    if (level === 'warn') console.warn(line)
    else console.debug(line)
  }
}

// ── Service ─────────────────────────────────────────────────────────────────

export class HuaqiuArtifactService implements HuaqiuArtifacts {
  private readonly baseDir: string
  private readonly maxBytes: number

  constructor(options: ArtifactsServiceOptions = {}) {
    this.baseDir = options.baseDir ?? dshHomePath('artifacts')
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024
  }

  private artifactsRoot(): string {
    return path.resolve(this.baseDir, 'dsh-artifacts')
  }

  private artifactDir(artifactId: string): string {
    // Strict id-only guard: ids are minted by us, but enforce the pattern so
    // no user-derived input can ever construct a path.
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
      throw new Error(`Invalid artifactId: does not match ${String(ARTIFACT_ID_PATTERN)}`)
    }
    return path.join(this.artifactsRoot(), artifactId)
  }

  async create(input: CreateArtifactInput): Promise<CreateArtifactResult> {
    if (!isValidArtifactType(input.type)) {
      throw new Error(`Invalid artifact type: ${String(input.type)}`)
    }
    if (typeof input.filename !== 'string' || input.filename.length === 0) {
      throw new Error('filename is required')
    }
    const buf = toBytes(input.content, input.contentEncoding)
    if (buf.byteLength > this.maxBytes) {
      throw new Error(`artifact content exceeds max size (${buf.byteLength} > ${this.maxBytes})`)
    }

    const id = 'art_' + randomUUID().replace(/-/g, '').slice(0, 16)
    const now = new Date()
    const meta: ArtifactMeta = {
      id,
      type: input.type,
      filename: input.filename,
      mimeType: mimeTypeFor(input.type, input.filename),
      size: buf.byteLength,
      createdAt: now.toISOString(),
    }
    if (typeof input.ttlSeconds === 'number' && Number.isFinite(input.ttlSeconds) && input.ttlSeconds > 0) {
      meta.expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString()
    }

    const dir = this.artifactDir(id)
    await fs.promises.mkdir(dir, { recursive: true })
    // Write content FIRST so an interrupted write never leaves a "valid" meta
    // pointing at partial bytes. Both writes are atomic (tmp + rename).
    const tmpContent = path.join(dir, 'content.tmp')
    await fs.promises.writeFile(tmpContent, buf)
    await fs.promises.rename(tmpContent, path.join(dir, 'content'))
    const tmpMeta = path.join(dir, 'meta.json.tmp')
    await fs.promises.writeFile(tmpMeta, JSON.stringify(meta, null, 2), 'utf8')
    await fs.promises.rename(tmpMeta, path.join(dir, 'meta.json'))

    log('debug', 'created', { id, type: input.type, size: buf.byteLength })
    return { id, type: meta.type, filename: meta.filename, size: meta.size }
  }

  async get(id: string): Promise<ArtifactMeta | null> {
    if (typeof id !== 'string' || !ARTIFACT_ID_PATTERN.test(id)) return null
    try {
      const dir = this.artifactDir(id)
      const fp = path.join(dir, 'meta.json')
      const raw = await fs.promises.readFile(fp, 'utf8')
      const meta = JSON.parse(raw) as ArtifactMeta
      if (this.isExpired(meta)) {
        void this.delete(id) // best-effort cleanup, non-fatal
        return null
      }
      return meta
    } catch {
      return null
    }
  }

  /** Returns `null` when missing or expired (miss signal for the HTTP 404). */
  async readContent(id: string): Promise<Uint8Array | null> {
    const meta = await this.get(id)
    if (!meta) return null
    try {
      return new Uint8Array(await fs.promises.readFile(path.join(this.artifactDir(id), 'content')))
    } catch {
      return null
    }
  }

  async delete(id: string): Promise<void> {
    if (typeof id !== 'string' || !ARTIFACT_ID_PATTERN.test(id)) return
    try {
      const dir = this.artifactDir(id)
      await fs.promises.rm(dir, { recursive: true, force: true })
      log('debug', 'deleted', { id })
    } catch (err) {
      log('warn', 'delete failed', { id, err })
    }
  }

  async deleteAll(opts: { onlyExpired?: boolean } = {}): Promise<number> {
    const { onlyExpired = false } = opts
    const root = this.artifactsRoot()
    let removed = 0
    if (!fs.existsSync(root)) return 0
    try {
      const entries = await fs.promises.readdir(root, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (onlyExpired) {
          try {
            const raw = await fs.promises.readFile(path.join(root, entry.name, 'meta.json'), 'utf8')
            const meta = JSON.parse(raw) as ArtifactMeta
            if (!this.isExpired(meta)) continue
          } catch {
            continue // missing/corrupt meta — leave to admin cleanup
          }
        }
        await fs.promises.rm(path.join(root, entry.name), { recursive: true, force: true })
        removed += 1
      }
      log('debug', 'deleteAll complete', { onlyExpired, removed })
    } catch (err) {
      log('warn', 'deleteAll failed', { err })
    }
    return removed
  }

  private isExpired(meta: ArtifactMeta): boolean {
    if (!meta.expiresAt) return false
    const expiresAt = Date.parse(meta.expiresAt)
    return !Number.isFinite(expiresAt) || expiresAt <= Date.now()
  }
}

/**
 * Minimal, safe, streaming ZIP reader — the installer's only archive code.
 *
 * Three reasons this is not a dependency: the archive is ~840 MB, so a
 * load-into-memory unzip is not acceptable (§7.5); extraction must be able to
 * *refuse* an entry rather than sanitize it afterwards (§8.4); and every byte it
 * writes has to be observable so the UI can show extraction progress (§7.4).
 * Node ships the two primitives the format needs (`inflateRaw` and file
 * streams), so the reader is a small amount of code instead of a package.
 *
 * Supported: stored (method 0) and deflated (method 8) entries from a classic
 * (non-ZIP64) central directory — what the HuaQiu portable distributions are.
 * Everything else is refused rather than guessed at.
 *
 * @module @huaqiu/hardware-artifacts/toolchain/zip
 *
 * @example
 * const directory = await readZipDirectory('kicad.zip')
 * await extractZip('kicad.zip', staging, { directory, stripPrefix: commonDirectory(directory) })
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'
import { decodeLzma, readZipLzmaHeader } from './lzma.js'

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
/** ZIP compression method 14 (LZMA) — the KiCad distribution's dominant method. */
const LZMA_METHOD = 14
const EOCD_SEARCH_BYTES = 66_000
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024

/** One file (or directory) the archive declares. */
export interface ZipEntry {
  /** Archive path as written, with `\` normalised to `/`. */
  readonly name: string
  /** Bytes the entry occupies inside the archive. */
  readonly compressedSize: number
  /** Bytes the entry expands to. */
  readonly uncompressedSize: number
  /** Compression method (0 stored, 8 deflated). */
  readonly method: number
  /** Absolute byte offset of the entry's local header. */
  readonly headerOffset: number
  /** True for a directory entry. */
  readonly directory: boolean
}

/** The archive's table of contents. */
export interface ZipDirectory {
  readonly entries: readonly ZipEntry[]
  /** Sum of every entry's uncompressed size — the extraction budget. */
  readonly totalUncompressed: number
  /** Bytes the archive file itself occupies. */
  readonly archiveBytes: number
}

/** Limits that turn a hostile or corrupt archive into a refusal. */
export interface ZipLimits {
  /** Largest single extracted file. */
  readonly maxEntryBytes: number
  /** Largest total extracted size. */
  readonly maxTotalBytes: number
  /** Largest number of entries. */
  readonly maxEntries: number
}

/** Defaults sized for the real distributions (~840 MB archive, ~2 GiB extracted). */
export const DEFAULT_ZIP_LIMITS: ZipLimits = Object.freeze({
  maxEntryBytes: 3 * 1024 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
  maxEntries: 400_000,
})

/** A structural problem with the archive; never repaired, always refused. */
export class ZipError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

/** Progress of one extraction run. */
export interface ExtractProgress {
  /** Bytes written so far. */
  readonly written: number
  /** Total bytes the directory declared. */
  readonly total: number
  /** Entries completed. */
  readonly entries: number
  /** Entries declared in total. */
  readonly totalEntries: number
  /** Archive path of the file being written. */
  readonly current: string
}

/** What one extraction run produced. */
export interface ExtractionResult {
  readonly files: number
  readonly directories: number
  readonly bytes: number
}

/** Injection points so traversal, limits and cancellation are testable. */
export interface ExtractOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: ExtractProgress) => void
  /** Pre-read directory, to avoid reading it twice. */
  readonly directory?: ZipDirectory
  /** Entry path prefix to drop (`kicad-huaqiu-…/`), from {@link commonDirectory}. */
  readonly stripPrefix?: string
  readonly limits?: Partial<ZipLimits>
}

/**
 * Normalise and validate one archive path.
 *
 * Absolute paths, drive letters, `..` segments, NUL bytes, Windows alternate
 * data streams and reserved device names are all rejected: the first three
 * escape the target directory (§8.4), the rest cannot be safely created on the
 * target platform.
 * @param raw - entry name as the archive stores it.
 * @returns the safe relative path segments.
 */
export function safeEntrySegments(raw: string): string[] {
  const name = raw.replaceAll('\\', '/')
  if (name.includes('\u0000')) throw new ZipError('unsafe-entry', `archive entry contains NUL: ${raw}`)
  if (name.startsWith('/')) throw new ZipError('unsafe-entry', `archive entry is absolute: ${raw}`)
  if (/^[A-Za-z]:/u.test(name)) throw new ZipError('unsafe-entry', `archive entry has a drive prefix: ${raw}`)
  const segments = name.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.some(segment => segment === '..')) {
    throw new ZipError('unsafe-entry', `archive entry traverses upwards: ${raw}`)
  }
  if (segments.length === 0) throw new ZipError('unsafe-entry', `archive entry has no name: ${raw}`)
  for (const segment of segments) {
    if (segment.includes(':')) throw new ZipError('unsafe-entry', `archive entry has a stream separator: ${raw}`)
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/iu.test(segment)) {
      throw new ZipError('unsafe-entry', `archive entry is a reserved device name: ${raw}`)
    }
  }
  return segments
}

/** Read exactly `length` bytes at `start` into `target`. */
async function readRange(archivePath: string, start: number, length: number, target: Buffer): Promise<void> {
  if (length === 0) return
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(archivePath, { start, end: start + length - 1 })
    let filled = 0
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      filled += buffer.copy(target, filled)
    })
    stream.on('end', () => {
      if (filled === length) resolvePromise()
      else rejectPromise(new ZipError('invalid-zip', `short read at ${String(start)}`))
    })
    stream.on('error', rejectPromise)
  })
}

/** Read an unsigned 64-bit little-endian field as a JS number (exact below 2^53). */
function u64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('archive-too-large', 'archive declares an unsupported size')
  return Number(value)
}

/**
 * Resolve the end-of-central-directory values, following the ZIP64 record when
 * the classic fields are saturated.
 *
 * The HuaQiu KiCad archive is genuinely ZIP64 (its contents exceed the classic
 * 4 GiB uncompressed limit), so this is a real requirement, not a defensive
 * branch: refusing ZIP64 would refuse the primary download (§8.5).
 * @param archivePath - archive being read.
 * @param eocd - tail window containing the classic record.
 * @param eocdOffset - index of the classic record inside `eocd`.
 * @returns the entry count, directory size and directory offset.
 */
async function directoryLocation(
  archivePath: string,
  eocd: Buffer,
  eocdOffset: number,
): Promise<{ entryCount: number; directorySize: number; directoryOffset: number }> {
  const entryCount = eocd.readUInt16LE(eocdOffset + 10)
  const directorySize = eocd.readUInt32LE(eocdOffset + 12)
  const directoryOffset = eocd.readUInt32LE(eocdOffset + 16)
  const zip64 = entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff
  if (!zip64) return { entryCount, directorySize, directoryOffset }

  // The ZIP64 locator sits immediately before the classic record.
  const locatorOffset = eocdOffset - 20
  if (locatorOffset < 0 || eocd.readUInt32LE(locatorOffset) !== ZIP64_LOCATOR_SIGNATURE) {
    throw new ZipError('invalid-zip', 'ZIP64 archive without a ZIP64 locator')
  }
  const recordOffset = u64(eocd, locatorOffset + 8)
  const record = Buffer.alloc(56)
  await readRange(archivePath, recordOffset, 56, record)
  if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
    throw new ZipError('invalid-zip', 'ZIP64 end-of-central-directory record is missing')
  }
  return {
    entryCount: u64(record, 32),
    directorySize: u64(record, 40),
    directoryOffset: u64(record, 48),
  }
}

/**
 * Read one central-directory entry's ZIP64 extended sizes from its extra field.
 *
 * The extra block only carries the values the classic header saturated, in
 * declaration order (uncompressed, compressed, offset) — reading them positionally
 * is what the specification requires.
 * @param extra - the entry's extra-field bytes.
 * @param needs - which classic fields were saturated.
 * @returns the saturated values as numbers.
 */
function zip64Sizes(
  extra: Buffer,
  needs: { readonly uncompressed: boolean; readonly compressed: boolean; readonly offset: boolean },
): { uncompressedSize?: number; compressedSize?: number; headerOffset?: number } {
  if (!needs.uncompressed && !needs.compressed && !needs.offset) return {}
  let cursor = 0
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor)
    const size = extra.readUInt16LE(cursor + 2)
    const body = extra.subarray(cursor + 4, cursor + 4 + size)
    cursor += 4 + size + (size % 2)
    if (id !== 0x0001) continue
    let at = 0
    const result: { uncompressedSize?: number; compressedSize?: number; headerOffset?: number } = {}
    const next = (): number => {
      const value = u64(body, at)
      at += 8
      return value
    }
    if (needs.uncompressed) result.uncompressedSize = next()
    if (needs.compressed) result.compressedSize = next()
    if (needs.offset) result.headerOffset = next()
    return result
  }
  throw new ZipError('invalid-zip', 'ZIP64 entry is missing its extended size field')
}

/**
 * Locate and parse the central directory.
 * @param archivePath - archive to read.
 * @returns the table of contents.
 */
export async function readZipDirectory(archivePath: string): Promise<ZipDirectory> {
  const size = (await stat(archivePath)).size
  const eocdLength = Math.min(size, EOCD_SEARCH_BYTES)
  const eocd = Buffer.alloc(eocdLength)
  await readRange(archivePath, size - eocdLength, eocdLength, eocd)

  let eocdOffset = -1
  for (let index = eocdLength - 22; index >= 0; index -= 1) {
    if (eocd.readUInt32LE(index) === EOCD_SIGNATURE) {
      eocdOffset = index
      break
    }
  }
  if (eocdOffset < 0) throw new ZipError('invalid-zip', 'no end-of-central-directory record')

  const { entryCount, directorySize, directoryOffset } = await directoryLocation(archivePath, eocd, eocdOffset)
  if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new ZipError('invalid-zip', `central directory is implausibly large (${String(directorySize)} bytes)`)
  }

  const directory = Buffer.alloc(directorySize)
  await readRange(archivePath, directoryOffset, directorySize, directory)

  const entries: ZipEntry[] = []
  let cursor = 0
  let totalUncompressed = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError('invalid-zip', `central directory entry ${String(index)} is malformed`)
    }
    const method = directory.readUInt16LE(cursor + 10)
    const compressedField = directory.readUInt32LE(cursor + 20)
    const uncompressedField = directory.readUInt32LE(cursor + 24)
    const nameLength = directory.readUInt16LE(cursor + 28)
    const extraLength = directory.readUInt16LE(cursor + 30)
    const commentLength = directory.readUInt16LE(cursor + 32)
    const offsetField = directory.readUInt32LE(cursor + 42)
    const name = directory.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    const extra = directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength)
    cursor += 46 + nameLength + extraLength + commentLength

    const extended = zip64Sizes(extra, {
      uncompressed: uncompressedField === 0xffffffff,
      compressed: compressedField === 0xffffffff,
      offset: offsetField === 0xffffffff,
    })
    const compressedSize = extended.compressedSize ?? compressedField
    const uncompressedSize = extended.uncompressedSize ?? uncompressedField
    const headerOffset = extended.headerOffset ?? offsetField
    entries.push({
      name: name.replaceAll('\\', '/'),
      compressedSize,
      uncompressedSize,
      method,
      headerOffset,
      directory: name.replaceAll('\\', '/').endsWith('/'),
    })
    totalUncompressed += uncompressedSize
  }
  return { entries, totalUncompressed, archiveBytes: size }
}

/**
 * The single wrapper directory an archive extracts into, when it has one.
 *
 * Both HuaQiu distributions ship one (`kicad-huaqiu-…/`, `solidcraft-…/`), and
 * the spec installs the *contents* into a versioned directory (§8.2/§8.3). Only
 * a genuine single root qualifies; an archive with two top-level names keeps
 * its own layout, because guessing would lose files.
 * @param directory - the archive's table of contents.
 * @returns the prefix to strip (with its trailing `/`), or undefined.
 */
export function commonDirectory(directory: ZipDirectory): string | undefined {
  const prefixes = new Set<string>()
  for (const entry of directory.entries) {
    const first = entry.name.split('/')[0]
    if (first === undefined || first === '') return undefined
    prefixes.add(first)
    if (prefixes.size > 1) return undefined
  }
  const [prefix] = [...prefixes]
  return prefix === undefined ? undefined : `${prefix}/`
}

/** Resolve one entry's data offset by reading its local header. */
async function dataOffsetOf(archivePath: string, entry: ZipEntry): Promise<number> {
  const header = Buffer.alloc(30)
  await readRange(archivePath, entry.headerOffset, 30, header)
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new ZipError('invalid-zip', `local header missing for ${entry.name}`)
  }
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  return entry.headerOffset + 30 + nameLength + extraLength
}

/**
 * Read one entry's bytes without extracting it — the seam diagnostics and
 * targeted verification use.
 * @param archivePath - archive to read.
 * @param entry - entry from {@link readZipDirectory}.
 * @returns the uncompressed entry bytes.
 */
export async function readZipEntry(archivePath: string, entry: ZipEntry): Promise<Buffer> {
  const offset = await dataOffsetOf(archivePath, entry)
  const raw = Buffer.alloc(entry.compressedSize)
  await readRange(archivePath, offset, entry.compressedSize, raw)
  if (entry.method === 0) return raw
  if (entry.method === LZMA_METHOD) {
    const { properties, consumed } = readZipLzmaHeader(raw)
    return decodeLzma(raw.subarray(consumed), properties, entry.uncompressedSize)
  }
  if (entry.method === 8) {
    const expanded = await new Promise<Buffer>((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = []
      const inflate = createInflateRaw()
      inflate.on('data', (chunk: Buffer) => chunks.push(chunk))
      inflate.on('end', () => resolvePromise(Buffer.concat(chunks)))
      inflate.on('error', rejectPromise)
      inflate.end(raw)
    })
    return expanded
  }
  throw new ZipError('unsupported-compression', `archive entry ${entry.name} uses compression method ${String(entry.method)}`)
}

/**
 * Extract one archive into a directory that must already be staging.
 *
 * Every entry is validated before its file is created, so a refused archive
 * never leaves a tree that could be mistaken for an installation (§8.4). Writes
 * are streamed, so memory stays bounded regardless of entry size.
 * @param archivePath - archive to read.
 * @param targetDir - staging directory to fill; the caller owns its lifetime.
 * @param options - progress/cancellation/prefix/limits.
 * @returns counts of what was written.
 */
export async function extractZip(
  archivePath: string,
  targetDir: string,
  options: ExtractOptions = {},
): Promise<ExtractionResult> {
  const directory = options.directory ?? await readZipDirectory(archivePath)
  const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...options.limits }
  const total = directory.totalUncompressed
  if (directory.entries.length > limits.maxEntries) {
    throw new ZipError('archive-too-large', `archive declares ${String(directory.entries.length)} entries`)
  }
  if (total > limits.maxTotalBytes) {
    throw new ZipError('archive-too-large', `archive expands to ${String(total)} bytes`)
  }

  const prefix = options.stripPrefix ?? ''
  const seen = new Set<string>()
  const root = resolve(targetDir)
  let written = 0
  let files = 0
  let directories = 0
  let completed = 0

  for (const entry of directory.entries) {
    if (options.signal?.aborted === true) throw new ZipError('cancelled', 'extraction was cancelled')
    const raw = prefix !== '' && entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : entry.name
    if (raw === '') continue
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      throw new ZipError('archive-too-large', `archive entry ${entry.name} expands to ${String(entry.uncompressedSize)} bytes`)
    }
    const relative = safeEntrySegments(raw).join(sep)
    if (seen.has(relative)) throw new ZipError('duplicate-entry', `archive repeats the entry ${raw}`)
    seen.add(relative)
    const destination = join(root, relative)
    if (!destination.startsWith(`${root}${sep}`)) {
      throw new ZipError('unsafe-entry', `archive entry escapes the target directory: ${raw}`)
    }

    if (entry.directory) {
      await mkdir(destination, { recursive: true })
      directories += 1
      completed += 1
      continue
    }
    if (entry.method !== 0 && entry.method !== 8 && entry.method !== LZMA_METHOD) {
      throw new ZipError('unsupported-compression', `archive entry ${entry.name} uses compression method ${String(entry.method)}`)
    }
    await mkdir(dirname(destination), { recursive: true })

    const offset = await dataOffsetOf(archivePath, entry)
    if (entry.method === LZMA_METHOD) {
      // LZMA is decoded whole-entry by design (the format's dictionary is
      // self-referential); every other method streams.
      const raw = Buffer.alloc(entry.compressedSize)
      await readRange(archivePath, offset, entry.compressedSize, raw)
      const { properties, consumed } = readZipLzmaHeader(raw)
      const expanded = decodeLzma(raw.subarray(consumed), properties, entry.uncompressedSize)
      await writeFile(destination, expanded)
      written += expanded.length
      options.onProgress?.({
        written, total, entries: completed, totalEntries: directory.entries.length, current: entry.name,
      })
    } else if (entry.compressedSize === 0) {
      // A zero-length stream has no valid `{start, end}` pair — the real KiCad
      // archive contains such entries (empty files, method 8), and asking Node to
      // read `end < start` aborts the whole extraction.
      await writeFile(destination, '')
    } else {
      const counter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          written += chunk.length
          options.onProgress?.({
            written, total, entries: completed, totalEntries: directory.entries.length, current: entry.name,
          })
          callback(null, chunk)
        },
      })
      const source = createReadStream(archivePath, { start: offset, end: offset + entry.compressedSize - 1 })
      const sink = createWriteStream(destination)
      const abort = (): void => { source.destroy(new ZipError('cancelled', 'extraction was cancelled')) }
      options.signal?.addEventListener('abort', abort)
      try {
        if (entry.method === 8) await pipeline(source, createInflateRaw(), counter, sink)
        else await pipeline(source, counter, sink)
      } finally {
        options.signal?.removeEventListener('abort', abort)
      }
    }
    const writtenBytes = await stat(destination).then(value => value.size).catch(() => -1)
    if (writtenBytes !== entry.uncompressedSize) {
      throw new ZipError(
        'invalid-zip',
        `archive entry ${entry.name} expanded to ${String(writtenBytes)} bytes, expected ${String(entry.uncompressedSize)}`,
      )
    }
    files += 1
    completed += 1
  }
  options.onProgress?.({ written, total, entries: completed, totalEntries: directory.entries.length, current: '' })
  return { files, directories, bytes: written }
}

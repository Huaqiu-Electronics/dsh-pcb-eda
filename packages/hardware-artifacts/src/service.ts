/**
 * Hardware Engineering artifact model and host operations.
 *
 * This module deliberately has no Cordis dependency: it is the testable core
 * behind `hardwareArtifacts`. Native project files remain authoritative; the
 * objects here are path pointers, verified installation facts and disposable
 * derived outputs, never a shadow project database.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_ORDER_BASE_URL, DEFAULT_ORDER_PAGE_BASE, multipartBody,
  ORDER_PATHS, orderBomCsv, orderBomRows, orderIdsFromUrl, packageName, parsePositions,
  pcbOrderForm, pcbOrderUrl, positionsCsv, readBoardFacts, readExportDirectory, smtOrderForm,
  smtOrderUrl, smtOrderUrlFromBackend, zipPackage,
  type BoardFacts,
} from './order.js'
import { validateFabricationPackage, validationSummary, type PackageValidation } from './package.js'
import { resolveToolchain } from './toolchain/resolve.js'

export type ArtifactKind = 'schematic' | 'pcb' | 'pcb-3d' | 'bom' | 'mechanical-3d'
/** Native handoff is KiCad-only in this POC; SolidCraft stays agent context. */
export type NativeApplication = 'kicad'

export interface HardwareArtifact {
  readonly id: string
  readonly kind: ArtifactKind
  readonly path: string
  readonly projectPath?: string
  /** BOM keeps its schematic; PCB 3D keeps its board; sheets keep their root. */
  readonly sourcePath?: string
  readonly title: string
  readonly format: string
  /** Content hash of the saved source, filled when the source is read. */
  readonly revision?: string
}

/** What one manufacturing operation needs from a project, and whether it has it. */
export interface OrderReadiness {
  readonly ready: boolean
  /** Why the operation is unavailable; absent when `ready`. */
  readonly reason?: string
}

export interface HardwareProject {
  readonly path: string
  readonly name: string
  /** Root schematic: the authoritative project entry point. */
  readonly rootSheet?: HardwareArtifact
  readonly schematic?: HardwareArtifact
  /** Semantic views; both keep the identity of their source artifact. */
  readonly bom?: HardwareArtifact
  readonly pcb3d?: HardwareArtifact
  readonly sheets: readonly HardwareArtifact[]
  /** Deterministic default board, only when ownership is unambiguous. */
  readonly defaultBoard?: string
  readonly boards: readonly HardwareArtifact[]
  readonly mechanical: readonly HardwareArtifact[]
  readonly selectionRequired: boolean
  /**
   * Static order readiness, derived from the artifacts the project already has.
   *
   * Deliberately conservative: PCB needs a saved board; assembly needs a board
   * *and* the project schematic, because the positions and the BOM are exported
   * from it. Neither says anything about KiCad being installed or the user being
   * signed in — those live in the order config, and the panel asks the Host for
   * them separately rather than guessing here.
   */
  readonly order: {
    readonly pcb: OrderReadiness
    readonly pcba: OrderReadiness
  }
}

export interface DiscoveryResult {
  readonly cwd: string
  readonly manifestPath?: string
  readonly projects: readonly HardwareProject[]
  readonly selected?: HardwareProject
  readonly issue?: { readonly code: string; readonly message: string }
}

export interface InstallationInfo {
  readonly configured: boolean
  readonly root?: string
  readonly cli?: string
  readonly projectManager?: string
  readonly pcbEditor?: string
  readonly schematicEditor?: string
  readonly executable?: string
  readonly version?: string
  readonly error?: string
}

export interface Installations {
  readonly kicad: InstallationInfo
  readonly solidcraft: InstallationInfo
}

export interface OpenArtifactRequest {
  readonly application: NativeApplication
  readonly artifactPath: string
  readonly kind: ArtifactKind
  readonly projectPath?: string
}

export interface OpenArtifactResult {
  readonly launched: true
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly pid?: number
}

export interface SourceRequest {
  readonly artifactPath: string
  readonly expectedRevision?: string
  /** DSH session the read belongs to, used only to scope the discovery cache. */
  readonly sessionId?: string
}

export interface SourceResult {
  readonly path: string
  readonly kind: 'schematic' | 'pcb'
  readonly revision: string
  readonly bytes: number
  readonly mtimeMs: number
  readonly text: string
}

export interface GlbRequest {
  readonly artifactPath: string
  readonly sessionId?: string
  readonly signal?: AbortSignal
}

export interface GlbResult {
  readonly path: string
  readonly revision: string
  readonly bytes: number
  readonly generatedAt: string
  readonly cached: boolean
  readonly file: string
}

/** One grouped BOM line, as KiCad's own BOM export groups it. */
export interface BomRow {
  readonly references: readonly string[]
  readonly quantity: number
  readonly value: string
  readonly footprint: string
  readonly dnp: boolean
  readonly fields: Readonly<Record<string, string>>
}

export interface BomResult {
  readonly path: string
  readonly revision: string
  readonly generatedAt: string
  readonly cached: boolean
  readonly rows: readonly BomRow[]
  readonly source: 'kicad-cli-bom'
}

export interface OrderPackageSummary {
  readonly zipName: string
  readonly zipBytes: number
  readonly files: readonly { readonly name: string; readonly bytes: number }[]
}

/** A prepared fabrication package: what would be uploaded, nothing sent yet. */
export interface FabricationResult {
  readonly boardPath: string
  readonly revision: string
  readonly generatedAt: string
  readonly facts: BoardFacts
  readonly archive: OrderPackageSummary
  /**
   * Whether the archive is actually fabricable. Present on every result: a
   * package can be prepared and refused, and the caller needs the reason.
   */
  readonly validation: PackageValidation
  /** Assembly inputs, present when a schematic was supplied. */
  readonly assembly?: {
    readonly positions: number
    readonly bomLines: number
    readonly positionsBytes: number
    readonly bomBytes: number
  }
}

export interface OrderConfigInfo {
  readonly configured: boolean
  readonly baseUrl: string
  /** True when a signed-in session or a configured token can sign the page. */
  readonly hasToken: boolean
  readonly provider: 'huaqiu'
}

export interface PlaceOrderRequest {
  readonly kind: 'pcb' | 'smt'
  readonly boardPath: string
  readonly schematicPath?: string
  readonly sessionId?: string
  readonly quantity?: number
  readonly signal?: AbortSignal
  /**
   * Hand the resulting page to the OS default browser.
   *
   * Off by default: a DSH client opens the page in its own Browser tab, and
   * opening both would leave the user with two copies of the same page. Only a
   * caller with no client (a script, a foreign MCP host) wants this on.
   */
  readonly launch?: boolean
}

export interface PlaceOrderResult {
  readonly kind: 'pcb' | 'smt'
  /** The exact URL KiCad's own action loads into its order webview. */
  readonly orderUrl: string
  /** The backend's raw URL, before KiCad's own query parameters were added. */
  readonly responseUrl: string
  /** True when the host handed `orderUrl` to the OS default browser. */
  readonly launched: boolean
  readonly launcher?: string
  readonly status: 'launched' | 'ready'
  readonly message: string
  readonly endpoint: string
  readonly facts: BoardFacts
  readonly archive: OrderPackageSummary
  /** The package judgement the order was placed with. */
  readonly validation: PackageValidation
  readonly assembly?: FabricationResult['assembly']
}

export interface HardwareArtifactsOptions {
  readonly kicadRoot?: string
  readonly solidcraftRoot?: string
  /** Origin for the place-order endpoints; defaults to the Huaqiu host. */
  readonly orderBaseUrl?: string
  readonly orderPageBase?: string
  /** Huaqiu access token; only ever sent to the order endpoint. */
  readonly accessToken?: string
  /**
   * Resolves the signed-in Huaqiu token when no explicit token is configured.
   *
   * hqpcb is a Huaqiu business, so the login that feeds the eda.cn API is also
   * the token the order page expects — there is no second credential.
   */
  readonly authToken?: () => Promise<string | null>
  /** Injectable transport for tests; defaults to global fetch. */
  readonly postOrder?: (url: string, init: {
    readonly body: Buffer
    readonly contentType: string
    readonly headers?: Readonly<Record<string, string>>
    readonly signal?: AbortSignal
  }) => Promise<{ readonly status: number; readonly text: string }>
  /**
   * Live accessor for the user-configured roots.
   *
   * The plugin passes the profile config reference, so a settings write that
   * replaces a volatile field is visible on the next validation without the
   * service caching a start-time snapshot.
   */
  readonly settings?: () => {
    readonly kicadRoot?: string
    readonly solidcraftRoot?: string
    readonly orderBaseUrl?: string
    readonly accessToken?: string
  }
  readonly probeVersion?: (executable: string, tool?: 'kicad' | 'solidcraft') => string | undefined
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { cwd: string; detached: boolean; stdio: 'ignore'; windowsHide: boolean; shell: false },
  ) => Pick<ChildProcess, 'pid'>
  /**
   * Command used to hand a URL to the OS. Defaults to `open` on macOS,
   * `rundll32 url.dll,FileProtocolHandler` on Windows and `xdg-open` elsewhere.
   */
  readonly openExternal?: (url: string) => { readonly command: string; readonly args: readonly string[] }
  /** Runs one short-lived CLI command and returns its exit facts. */
  readonly runCommand?: (
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
  ) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>
  /** Cache directory for derived outputs; defaults to a temp subdirectory. */
  readonly cacheRoot?: string
  readonly glbTimeoutMs?: number
  /** Source text limit; protects the host from pathological files. */
  readonly maxSourceBytes?: number
}

interface ProjectManifest {
  project?: string
  schematic?: string
  boards?: readonly { id?: string; path: string }[]
  mechanical?: readonly { id?: string; path: string }[]
}

const EXCLUDED_DIRS = new Set([
  '.git', '.cache', 'node_modules', 'dist', 'build', 'out', 'tmp', 'temp',
  'archive', 'archives', 'backup', 'backups', 'export', 'exports',
])
const MECHANICAL_EXTENSIONS = new Set(['.step', '.stp', '.glb'])
const SOURCE_EXTENSIONS: Readonly<Record<string, 'schematic' | 'pcb'>> = {
  '.kicad_sch': 'schematic',
  '.kicad_pcb': 'pcb',
}
const MAX_DEPTH = 5
/** KiCad writes each child sheet as `(property "Sheetfile" "child.kicad_sch")`. */
const SHEET_FILE_PATTERN = /\(property\s+"Sheetfile"\s+"((?:[^"\\]|\\.)*)"/gu

function canonical(path: string): string {
  return resolve(path)
}

function isExcluded(name: string): boolean {
  return EXCLUDED_DIRS.has(name.toLowerCase())
}

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * Identity of one authorization scope. DSH sessions are the scope; an embed
 * without sessions (tests, a bare host) shares the default entry.
 */
function scopeKey(sessionId?: string): string {
  return sessionId === undefined || sessionId === '' ? '' : sessionId
}

function errorWithCode(message: string, code: string, status: number): Error {
  return Object.assign(new Error(message), { code, status })
}

/**
 * POST one multipart order payload.
 *
 * Kept out of the class so tests can inject their own transport; the default
 * has a hard timeout and never logs the body (it carries the access token).
 */
async function defaultPostOrder(url: string, init: {
  readonly body: Buffer
  readonly contentType: string
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}): Promise<{ readonly status: number; readonly text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, 90_000)
  const forward = (): void => { controller.abort() }
  init.signal?.addEventListener('abort', forward, { once: true })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...init.headers,
        'content-type': init.contentType,
        'content-length': String(init.body.byteLength),
      },
      // Node's fetch accepts a Buffer body; the DOM lib's BodyInit typing only
      // names ArrayBuffer views backed by a non-shared buffer.
      body: init.body as unknown as BodyInit,
      signal: controller.signal,
    })
    return { status: response.status, text: await response.text() }
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', forward)
  }
}

/**
 * Command that opens one URL in the OS default browser.
 *
 * A URL argument is passed to a fixed executable with `shell: false`, so the
 * page can never become a shell command.
 */
function defaultOpenExternal(url: string): { command: string; args: readonly string[] } {
  if (process.platform === 'darwin') return { command: 'open', args: [url] }
  if (process.platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  return { command: 'xdg-open', args: [url] }
}

/**
 * Validate an order page URL before handing it to the OS.
 *
 * The backend owns this URL, so the check is deliberately about *shape*, not
 * about a specific host: HTTPS anywhere, plain HTTP only on loopback (local
 * stubs), and never a URL with embedded credentials or a non-web scheme.
 */
function externalUrlTarget(raw: string): string {
  if (raw.length === 0 || raw.length > 4096) {
    throw errorWithCode('the order URL is empty or too long', 'invalid-order-url', 400)
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw errorWithCode('the order URL is not a valid absolute URL', 'invalid-order-url', 400)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw errorWithCode(`refusing to open a ${parsed.protocol} URL`, 'invalid-order-url', 400)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw errorWithCode('refusing to open a URL with embedded credentials', 'invalid-order-url', 400)
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, '')
  const loopback = host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.')
  if (parsed.protocol === 'http:' && !loopback) {
    throw errorWithCode('refusing to open a plain-HTTP order URL outside loopback', 'invalid-order-url', 400)
  }
  return parsed.toString()
}

/** First backend-owned order URL in a place-order response. */
function orderUrlOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  for (const key of ['url', 'redirect', 'data']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
    if (value !== null && typeof value === 'object') {
      const nested = orderUrlOf(value)
      if (nested !== undefined) return nested
    }
  }
  const result = record.result
  return result === undefined ? undefined : orderUrlOf(result)
}

function walkFiles(root: string, predicate: (name: string) => boolean): string[] {
  const found: string[] = []
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || !existsSync(dir)) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!isExcluded(entry.name)) visit(full, depth + 1)
      } else if (entry.isFile() && predicate(entry.name)) {
        found.push(canonical(full))
      }
    }
  }
  visit(root, 0)
  return found.sort()
}

/** Child schematics declared by sheet references in one saved schematic. */
function childSheetFiles(path: string): string[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const dir = dirname(path)
  const children: string[] = []
  for (const match of text.matchAll(SHEET_FILE_PATTERN)) {
    const raw = match[1]
    if (raw === undefined || raw === '') continue
    const declared = raw.replace(/\\(["\\])/gu, '$1')
    const target = isAbsolute(declared) ? canonical(declared) : resolve(dir, declared)
    children.push(target)
  }
  return children.sort()
}

function artifact(kind: ArtifactKind, path: string, projectPath?: string, sourcePath?: string): HardwareArtifact {
  const full = canonical(path)
  return {
    id: `${kind}:${full}`,
    kind,
    path: full,
    ...(projectPath === undefined ? {} : { projectPath: canonical(projectPath) }),
    ...(sourcePath === undefined ? {} : { sourcePath: canonical(sourcePath) }),
    title: basename(full),
    format: extname(full).toLowerCase().replace(/^\./, '') || kind,
  }
}

/** Is this path an existing regular file? Small helper shared by resolution. */
function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function defaultVersionProbe(executable: string, tool: 'kicad' | 'solidcraft' = 'kicad'): string | undefined {
  if (!existsSync(executable)) return undefined
  try {
    // The two tools do not share a version interface: KiCad answers its `version`
    // subcommand, SolidCraft only its `--version` flag.
    const args = tool === 'kicad' ? ['version'] : ['--version']
    return execFileSync(executable, args, {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n')[0] || undefined
  } catch {
    return undefined
  }
}

function defaultRunCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, [...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolvePromise({ exitCode: 0, stdout: String(stdout), stderr: String(stderr), timedOut: false })
        return
      }
      const killed = (error as { killed?: boolean }).killed === true
      const signal = (error as { signal?: string | null }).signal
      if (killed || signal !== null && signal !== undefined) {
        resolvePromise({ exitCode: null, stdout: String(stdout), stderr: String(stderr), timedOut: true })
        return
      }
      const code = typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code: number }).code) : null
      if (code === null) {
        reject(error)
        return
      }
      resolvePromise({ exitCode: code, stdout: String(stdout), stderr: String(stderr), timedOut: false })
    })
  })
}


/** Small, immutable host capability implementation. */
export class HardwareArtifactService {
  private readonly options: Required<Pick<
    HardwareArtifactsOptions,
    'spawnProcess' | 'probeVersion' | 'runCommand' | 'openExternal'
  >>
  private readonly cacheRoot: string
  private readonly glbTimeoutMs: number
  private readonly maxSourceBytes: number
  /**
   * Last discovery per scope — one entry per DSH session, plus the unscoped
   * default used by tests and non-DSH embeds.
   *
   * It is a map rather than one field on purpose: a single "most recent
   * discovery" is shared by every open viewer, so switching to a session in
   * another workspace silently revoked the authorization of the viewer that
   * stayed open. Authorization must never depend on who asked last.
   */
  private readonly discoveries = new Map<string, DiscoveryResult>()
  /** Completed GLB exports keyed by `sourcePath:revision`. */
  private readonly glbCache = new Map<string, GlbResult>()
  /** In-flight GLB exports keyed by the same key, so concurrent callers share one run. */
  private readonly glbPending = new Map<string, Promise<GlbResult>>()
  /** BOM projections keyed by `sourcePath:revision`. */
  private readonly bomCache = new Map<string, BomResult>()
  /** Prepared fabrication packages keyed by board, revision and schematic. */
  private readonly packageCache = new Map<string, FabricationResult & {
    readonly archiveData: Uint8Array
    readonly assemblyFiles?: { readonly positions: string; readonly bom: string }
  }>()

  constructor(private readonly config: HardwareArtifactsOptions = {}) {
    this.options = {
      probeVersion: config.probeVersion ?? defaultVersionProbe,
      spawnProcess: config.spawnProcess ?? ((command, args, settings) => spawn(command, [...args], settings)),
      runCommand: config.runCommand ?? defaultRunCommand,
      openExternal: config.openExternal ?? defaultOpenExternal,
    }
    this.cacheRoot = canonical(config.cacheRoot ?? join(tmpdir(), 'huaqiu-hardware-artifacts'))
    this.glbTimeoutMs = config.glbTimeoutMs ?? 120_000
    this.maxSourceBytes = config.maxSourceBytes ?? 32 * 1024 * 1024
  }

  /** Configured roots, read live so a settings write is visible immediately. */
  private roots(): { kicadRoot?: string; solidcraftRoot?: string } {
    const live = this.config.settings?.()
    const kicadRoot = live?.kicadRoot ?? this.config.kicadRoot
    const solidcraftRoot = live?.solidcraftRoot ?? this.config.solidcraftRoot
    return {
      ...(kicadRoot === undefined ? {} : { kicadRoot }),
      ...(solidcraftRoot === undefined ? {} : { solidcraftRoot }),
    }
  }

  /**
   * Resolve configured installations from validated absolute paths only.
   *
   * Resolution is delegated to the toolchain capability's one resolver
   * (`./toolchain/resolve.ts`) so the settings panel, background discovery and
   * the export path cannot disagree about what "configured" means.
   */
  installations(): Installations {
    const roots = this.roots()
    const kicadResolution = resolveToolchain('kicad', roots.kicadRoot, {
      exists: path => isFile(path),
      probeVersion: executable => this.options.probeVersion(executable, 'kicad'),
    })
    const kicad: InstallationInfo = kicadResolution.configured
      ? {
          configured: true,
          ...(roots.kicadRoot === undefined ? {} : { root: canonical(roots.kicadRoot) }),
          ...(kicadResolution.cli === undefined ? {} : { cli: kicadResolution.cli }),
          ...(kicadResolution.version === undefined ? {} : { version: kicadResolution.version }),
          ...(kicadResolution.projectManager === undefined ? {} : { projectManager: kicadResolution.projectManager }),
          ...(kicadResolution.pcbEditor === undefined ? {} : { pcbEditor: kicadResolution.pcbEditor }),
          ...(kicadResolution.schematicEditor === undefined ? {} : { schematicEditor: kicadResolution.schematicEditor }),
        }
      : {
          configured: false,
          ...(roots.kicadRoot === undefined ? {} : { root: canonical(roots.kicadRoot) }),
          ...(kicadResolution.cli === undefined ? {} : { cli: kicadResolution.cli }),
          ...(kicadResolution.error === undefined ? {} : { error: kicadResolution.error }),
        }

    const solidResolution = resolveToolchain('solidcraft', roots.solidcraftRoot, {
      exists: path => isFile(path),
      probeVersion: executable => this.options.probeVersion(executable, 'solidcraft'),
    })
    // The GUI executable keeps its historical field name (`executable`) so the
    // launch path and the agent prompt are unchanged; the CLI is additive.
    const solidcraft: InstallationInfo = solidResolution.configured
      ? {
          configured: true,
          ...(roots.solidcraftRoot === undefined ? {} : { root: canonical(roots.solidcraftRoot) }),
          ...(solidResolution.app === undefined ? {} : { executable: solidResolution.app }),
          ...(solidResolution.cli === undefined ? {} : { cli: solidResolution.cli }),
          ...(solidResolution.version === undefined ? {} : { version: solidResolution.version }),
        }
      : {
          configured: false,
          ...(roots.solidcraftRoot === undefined ? {} : { root: canonical(roots.solidcraftRoot) }),
          ...(solidResolution.error === undefined ? {} : { error: solidResolution.error }),
        }
    return { kicad, solidcraft }
  }

  /** Paths passed to agent child processes. Never assign these globally. */
  childEnvironment(): Record<string, string> {
    const installed = this.installations()
    const env: Record<string, string> = {}
    if (installed.kicad.cli !== undefined) env.HUAQIU_KICAD_CLI = installed.kicad.cli
    if (installed.kicad.pcbEditor !== undefined) env.HUAQIU_KICAD_PCBNEW = installed.kicad.pcbEditor
    if (installed.kicad.schematicEditor !== undefined) env.HUAQIU_KICAD_EESCHEMA = installed.kicad.schematicEditor
    if (installed.solidcraft.executable !== undefined) env.HUAQIU_SOLIDCRAFT = installed.solidcraft.executable
    return env
  }

  /** Compact agent context: validated paths only, no project inventory dump. */
  environmentText(current?: DiscoveryResult): string {
    const installed = this.installations()
    // The prompt has no session of its own; speaking for the only scope that
    // ever discovered is honest, and with several open workspaces it says
    // nothing rather than naming another session's project.
    const scope = current ?? this.soleDiscovery()
    const lines = ['<hardware_environment>']
    lines.push('KiCad:')
    lines.push(`  configured: ${String(installed.kicad.configured)}`)
    for (const key of ['version', 'cli', 'pcbEditor', 'schematicEditor'] as const) {
      const value = installed.kicad[key]
      if (value !== undefined) lines.push(`  ${key}: ${value}`)
    }
    if (installed.kicad.error !== undefined) lines.push(`  error: ${installed.kicad.error}`)
    lines.push('SolidCraft:')
    lines.push(`  configured: ${String(installed.solidcraft.configured)}`)
    for (const key of ['version', 'executable', 'cli'] as const) {
      const value = installed.solidcraft[key]
      if (value !== undefined) lines.push(`  ${key}: ${value}`)
    }
    if (installed.solidcraft.error !== undefined) lines.push(`  error: ${installed.solidcraft.error}`)
    // §12.2: an agent must be able to tell the user *what to do* about a missing
    // toolchain without guessing at product navigation.
    const missing = [!installed.kicad.configured ? 'KiCad' : undefined, !installed.solidcraft.configured ? 'SolidCraft' : undefined]
      .filter((entry): entry is string => entry !== undefined)
    if (missing.length > 0) {
      lines.push('setup:')
      lines.push(`  missing: ${missing.join(', ')}`)
      lines.push('  remediation: Settings → Hardware Engineering (browse an existing installation, download the HuaQiu build, or skip)')
    }
    if (scope?.selected !== undefined) {
      lines.push('Current project:')
      lines.push(`  root: ${scope.cwd}`)
      lines.push(`  project: ${scope.selected.path}`)
      if (scope.selected.schematic !== undefined) lines.push(`  schematic: ${scope.selected.schematic.path}`)
      const board = scope.selected.boards[0]
      if (board !== undefined) lines.push(`  selected_pcb: ${board.path}`)
    }
    lines.push('</hardware_environment>')
    return lines.join('\n')
  }

  /**
   * Deterministic discovery. An explicit project or manifest wins; otherwise
   * exactly one `.kicad_pro` may be selected automatically. Ambiguity is
   * returned as a selection requirement, never resolved by taking the first.
   *
   * @param cwdInput - workspace directory to walk.
   * @param explicitProject - project chosen by the user, absolute or cwd-relative.
   * @param sessionId - DSH session the discovery belongs to. Recording it per
   *   session is what keeps one open viewer from revoking another's roots.
   */
  discover(cwdInput: string, explicitProject?: string, sessionId?: string): DiscoveryResult {
    const cwd = canonical(cwdInput)
    const manifestPath = join(cwd, '.hardware-engineering.json')
    let manifest: ProjectManifest | undefined
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProjectManifest
      } catch (error) {
        return this.remember({
          cwd,
          manifestPath,
          projects: [],
          issue: { code: 'bad-manifest', message: `invalid .hardware-engineering.json: ${String(error)}` },
        }, sessionId)
      }
    }

    const projectPaths = new Set<string>()
    if (explicitProject !== undefined && explicitProject.trim() !== '') {
      const requested = isAbsolute(explicitProject) ? canonical(explicitProject) : resolve(cwd, explicitProject)
      if (!existsSync(requested)) {
        return this.remember({
          cwd,
          ...(manifest === undefined ? {} : { manifestPath }),
          projects: [],
          issue: { code: 'missing-project', message: `${requested} does not exist` },
        }, sessionId)
      }
      projectPaths.add(requested)
    } else if (manifest?.project !== undefined && manifest.project.trim() !== '') {
      projectPaths.add(isAbsolute(manifest.project) ? canonical(manifest.project) : resolve(cwd, manifest.project))
    } else {
      for (const path of walkFiles(cwd, name => name.toLowerCase().endsWith('.kicad_pro'))) projectPaths.add(path)
    }

    const projects: HardwareProject[] = [...projectPaths].sort().map(path => this.projectFrom(path, cwd, manifest))
    if (projects.length === 0) {
      return this.remember({
        cwd,
        ...(manifest === undefined ? {} : { manifestPath }),
        projects,
        issue: { code: 'no-project', message: `no .kicad_pro found under ${cwd}` },
      }, sessionId)
    }
    if (projects.length > 1) {
      return this.remember({
        cwd,
        ...(manifest === undefined ? {} : { manifestPath }),
        projects,
        issue: { code: 'selection-required', message: `${projects.length} projects found; select one explicitly` },
      }, sessionId)
    }
    const selected = projects[0] as HardwareProject
    return this.remember({
      cwd,
      ...(manifest === undefined ? {} : { manifestPath }),
      projects,
      selected,
      ...(selected.selectionRequired
        ? { issue: { code: 'selection-required', message: 'select an artifact explicitly' } }
        : {}),
    }, sessionId)
  }

  /** Last discovery for one scope, never another session's. */
  discovery(sessionId?: string): DiscoveryResult | undefined {
    return this.discoveries.get(scopeKey(sessionId))
  }

  /** The only discovery the host can speak for without being told a session. */
  private soleDiscovery(): DiscoveryResult | undefined {
    if (this.discoveries.size !== 1) return undefined
    return [...this.discoveries.values()][0]
  }

  private remember(result: DiscoveryResult, sessionId?: string): DiscoveryResult {
    this.discoveries.set(scopeKey(sessionId), result)
    return result
  }

  private projectFrom(projectPath: string, cwd: string, manifest?: ProjectManifest): HardwareProject {
    const dir = dirname(projectPath)
    const name = basename(projectPath, extname(projectPath))
    const resolvePath = (value: string): string =>
      isAbsolute(value) ? canonical(value) : resolve(dir, value)

    // The root schematic is authoritative: an explicit manifest entry, then the
    // project-named file, then a single unambiguous candidate. Unrelated
    // sibling `.kicad_sch` files are never promoted to sheets.
    const explicitSchematic = manifest?.schematic === undefined ? undefined : resolvePath(manifest.schematic)
    let schematicPath = explicitSchematic !== undefined && existsSync(explicitSchematic) ? explicitSchematic : undefined
    if (schematicPath === undefined) {
      const named = join(dir, `${name}.kicad_sch`)
      if (existsSync(named)) schematicPath = named
      else {
        const candidates = readdirSync(dir, { withFileTypes: true })
          .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.kicad_sch'))
          .map(entry => join(dir, entry.name))
          .sort()
        if (candidates.length === 1) schematicPath = candidates[0]
      }
    }

    // Hierarchy comes from sheet references only, resolved recursively with a
    // cycle guard: parsing the root must never advertise unrelated files.
    const sheets: HardwareArtifact[] = []
    if (schematicPath !== undefined) {
      const visited = new Set<string>([canonical(schematicPath)])
      const queue = childSheetFiles(canonical(schematicPath))
      while (queue.length > 0) {
        const next = queue.shift() as string
        const canonicalNext = canonical(next)
        if (visited.has(canonicalNext)) continue
        visited.add(canonicalNext)
        if (!existsSync(canonicalNext) || extname(canonicalNext).toLowerCase() !== '.kicad_sch') continue
        sheets.push(artifact('schematic', canonicalNext, projectPath, canonical(schematicPath)))
        queue.push(...childSheetFiles(canonicalNext))
      }
    }

    // Board ranking: manifest ownership first, then the project-named board, then
    // the only candidate. Multiple unowned boards stay ambiguous on purpose.
    const manifestBoards = manifest?.boards === undefined
      ? []
      : manifest.boards
        .filter(entry => existsSync(resolvePath(entry.path)))
        .map(entry => artifact('pcb', resolvePath(entry.path), projectPath))
    const scannedBoards = walkFiles(dir, file => file.toLowerCase().endsWith('.kicad_pcb'))
      .map(path => artifact('pcb', path, projectPath))
    const boards = manifestBoards.length > 0
      ? manifestBoards
      : [...scannedBoards].sort((left, right) => boardRank(left, right, name))
    const owned = boards.find(board => basename(board.path, '.kicad_pcb') === name) ?? boards[0]
    const ownershipAmbiguous = manifestBoards.length === 0 && boards.length > 1
      && basename(owned?.path ?? '', '.kicad_pcb') !== name

    const mechanical = manifest?.mechanical !== undefined
      ? manifest.mechanical.map(model => artifact('mechanical-3d', resolvePath(model.path), projectPath))
      : walkFiles(dir, file => MECHANICAL_EXTENSIONS.has(extname(file).toLowerCase()))
        .map(path => artifact('mechanical-3d', path, projectPath))

    const sourceSchematic = schematicPath === undefined ? undefined : artifact('schematic', schematicPath, projectPath)
    const sourceBoard = ownershipAmbiguous ? undefined : owned
    // Order readiness is a statement about the files, not about the toolchain:
    // a board can be packaged whatever KiCad's state is, and assembly additionally
    // needs the schematic the positions and BOM are exported from.
    const order = {
      pcb: boards.length === 0 ? { ready: false, reason: 'no-board' } : { ready: true },
      pcba: boards.length === 0
        ? { ready: false, reason: 'no-board' }
        : sourceSchematic === undefined
          ? { ready: false, reason: 'no-schematic' }
          : { ready: true },
    } as const
    return {
      path: projectPath,
      name,
      ...(sourceSchematic === undefined ? {} : { rootSheet: sourceSchematic, schematic: sourceSchematic }),
      ...(sourceSchematic === undefined ? {} : {
        bom: { ...artifact('bom', sourceSchematic.path, projectPath, sourceSchematic.path), title: `BOM — ${sourceSchematic.title}` },
      }),
      ...(sourceBoard === undefined ? {} : {
        pcb3d: { ...artifact('pcb-3d', sourceBoard.path, projectPath, sourceBoard.path), title: `3D — ${sourceBoard.title}` },
        defaultBoard: sourceBoard.path,
      }),
      sheets,
      boards,
      mechanical,
      selectionRequired: boards.length > 1 && ownershipAmbiguous,
      order,
    }
  }

  /** Validate and launch a native application without a shell. */
  open(request: OpenArtifactRequest): OpenArtifactResult {
    const path = canonical(request.artifactPath)
    if (!existsSync(path)) {
      throw errorWithCode(`artifact does not exist: ${path}`, 'missing-artifact', 404)
    }
    const installed = this.installations()
    const ext = extname(path).toLowerCase()
    let command: string | undefined
    if (ext === '.kicad_sch') command = installed.kicad.schematicEditor
    else if (ext === '.kicad_pcb') command = installed.kicad.pcbEditor
    else if (ext === '.kicad_pro') command = installed.kicad.projectManager
    else throw errorWithCode(`unsupported KiCad artifact: ${ext}`, 'unsupported-artifact', 415)
    if (command === undefined) {
      throw errorWithCode('the configured KiCad installation has no editor for this artifact', 'missing-executable', 412)
    }
    const settings = { cwd: dirname(path), detached: true, stdio: 'ignore' as const, windowsHide: true, shell: false as const }
    const child = this.options.spawnProcess(command, [path], settings)
    return { launched: true, command, args: [path], cwd: settings.cwd, ...(child.pid === undefined ? {} : { pid: child.pid }) }
  }

  /**
   * Resolve one artifact path: canonical, real, of an expected type.
   *
   * There is deliberately **no workspace fence**. This service only runs on the
   * machine whose files it reads, under the same authority as the user's own
   * editor, so a root check never protected anything the user could not already
   * open — it only produced `403 artifact is outside the authorized workspace`
   * whenever a panel and an agent call disagreed about a root, which is a
   * configuration puzzle disguised as a security boundary.
   *
   * What remains is what makes the answer trustworthy rather than merely
   * permitted: the path must be absolute, exist, be a regular file, be of a type
   * this service renders, and be resolved through symlinks before anything
   * reads it.
   * @param artifactPath - absolute path supplied by a client or an agent tool.
   */
  private authorize(artifactPath: string): { path: string; kind: 'schematic' | 'pcb' } {
    if (!isAbsolute(artifactPath)) {
      throw errorWithCode('artifact identity must be an absolute path', 'invalid-identity', 400)
    }
    const requested = canonical(artifactPath)
    const kind = SOURCE_EXTENSIONS[extname(requested).toLowerCase()]
    if (kind === undefined) {
      throw errorWithCode(`unsupported artifact type: ${extname(requested)}`, 'unsupported-artifact', 415)
    }
    if (!existsSync(requested)) {
      throw errorWithCode(`artifact does not exist: ${requested}`, 'missing-artifact', 404)
    }
    const real = realOrUndefined(requested)
    if (real === undefined) {
      throw errorWithCode(`artifact cannot be resolved: ${requested}`, 'invalid-identity', 400)
    }
    const info = statSync(real)
    if (!info.isFile()) {
      throw errorWithCode(`artifact is not a regular file: ${requested}`, 'invalid-identity', 400)
    }
    const resolvedKind = SOURCE_EXTENSIONS[extname(real).toLowerCase()]
    if (resolvedKind === undefined) {
      throw errorWithCode('artifact type changed during resolution', 'unsupported-artifact', 415)
    }
    return { path: real, kind: resolvedKind as 'schematic' | 'pcb' }
  }

  /** Saved source text plus a content-addressed revision. */
  async readSource(request: SourceRequest): Promise<SourceResult> {
    const { path, kind } = this.authorize(request.artifactPath)
    const info = statSync(path)
    if (info.size > this.maxSourceBytes) {
      throw errorWithCode(`artifact is larger than ${this.maxSourceBytes} bytes`, 'too-large', 413)
    }
    const body = await readFile(path)
    const revision = createHash('sha256').update(body).digest('hex')
    if (request.expectedRevision !== undefined && request.expectedRevision !== ''
      && request.expectedRevision !== revision) {
      throw errorWithCode(
        `source changed since it was selected (expected ${request.expectedRevision}, found ${revision})`,
        'stale-revision',
        409,
      )
    }
    return {
      path,
      kind,
      revision,
      bytes: body.byteLength,
      mtimeMs: info.mtimeMs,
      text: body.toString('utf8'),
    }
  }

  private sourceRevision(path: string): string {
    const info = statSync(path)
    if (info.size > this.maxSourceBytes) {
      throw errorWithCode(`artifact is larger than ${this.maxSourceBytes} bytes`, 'too-large', 413)
    }
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  }

  /** Cache directory for one board's derived outputs. */
  private glbDirectory(boardPath: string): string {
    const digest = createHash('sha256').update(boardPath).digest('hex').slice(0, 16)
    return join(this.cacheRoot, 'glb', digest)
  }

  /**
   * Generate (or reuse) the GLB for one board.
   *
   * - cache key includes the source content hash, so same-size/same-mtime edits invalidate
   * - one in-flight export is shared by concurrent callers for the same revision
   * - output is written to a temp file and renamed only after it validates
   * - a timeout or abort leaves no partial file behind
   */
  async exportGlb(request: GlbRequest): Promise<GlbResult> {
    const { path } = this.authorize(request.artifactPath)
    if (extname(path).toLowerCase() !== '.kicad_pcb') {
      throw errorWithCode('GLB export requires a .kicad_pcb artifact', 'unsupported-artifact', 415)
    }
    const installed = this.installations()
    if (!installed.kicad.configured || installed.kicad.cli === undefined) {
      throw errorWithCode(
        installed.kicad.error ?? 'the configured KiCad installation has no kicad-cli',
        'not-configured',
        412,
      )
    }
    const cli = installed.kicad.cli
    const revision = this.sourceRevision(path)
    const key = `${path}:${revision}`
    const cached = this.glbCache.get(key)
    if (cached !== undefined && existsSync(cached.file)) {
      const info = statSync(cached.file)
      return { ...cached, bytes: info.size, cached: true }
    }
    const pending = this.glbPending.get(key)
    if (pending !== undefined) return pending

    const directory = this.glbDirectory(path)
    const target = join(directory, `board-${revision.slice(0, 16)}.glb`)
    const running = (async (): Promise<GlbResult> => {
      mkdirSync(directory, { recursive: true })
      const tempDirectory = join(directory, `tmp-${process.pid}-${String(Date.now())}`)
      mkdirSync(tempDirectory, { recursive: true })
      const tempFile = join(tempDirectory, 'board.glb')
      try {
        const result = await this.options.runCommand(
          cli,
          ['pcb', 'export', 'glb', '--output', tempFile, path],
          { cwd: dirname(path), timeoutMs: this.glbTimeoutMs, ...(request.signal === undefined ? {} : { signal: request.signal }) },
        )
        if (result.timedOut) {
          throw errorWithCode(`kicad-cli pcb export glb timed out after ${this.glbTimeoutMs} ms`, 'export-timeout', 504)
        }
        if (result.exitCode !== 0) {
          const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`).slice(0, 800)
          throw errorWithCode(`kicad-cli pcb export glb failed: ${detail}`, 'export-failed', 502)
        }
        if (!existsSync(tempFile)) {
          throw errorWithCode('kicad-cli pcb export glb produced no output', 'export-failed', 502)
        }
        const bytes = statSync(tempFile).size
        if (bytes === 0 || readFileSync(tempFile).subarray(0, 4).toString('ascii') !== 'glTF') {
          throw errorWithCode('kicad-cli wrote an invalid GLB', 'export-failed', 502)
        }
        renameSync(tempFile, target)
        const generated = {
          path,
          revision,
          bytes,
          generatedAt: new Date().toISOString(),
          cached: false,
          file: target,
        } satisfies GlbResult
        this.glbCache.set(key, generated)
        return generated
      } finally {
        rmSync(tempDirectory, { recursive: true, force: true })
      }
    })()

    this.glbPending.set(key, running)
    try {
      return await running
    } finally {
      this.glbPending.delete(key)
    }
  }

  /**
   * Grouped BOM for one saved root schematic.
   *
   * Reuses KiCad's own BOM extraction (`kicad-cli sch export bom`), the same
   * authoritative source `analyze_kicad_module` consumes, rather than building a
   * second component analyser. Grouping key is every non-reference column, so
   * different MPNs never merge and DNP stays explicit.
   */
  async exportBom(request: {
    readonly artifactPath: string
    readonly sessionId?: string
    readonly signal?: AbortSignal
  }): Promise<BomResult> {
    const { path, kind } = this.authorize(request.artifactPath)
    if (kind !== 'schematic') {
      throw errorWithCode('BOM export requires a .kicad_sch artifact', 'unsupported-artifact', 415)
    }
    const installed = this.installations()
    if (!installed.kicad.configured || installed.kicad.cli === undefined) {
      throw errorWithCode(installed.kicad.error ?? 'the configured KiCad installation has no kicad-cli', 'not-configured', 412)
    }
    const revision = this.sourceRevision(path)
    const key = `${path}:${revision}`
    const cached = this.bomCache.get(key)
    if (cached !== undefined) return { ...cached, cached: true }

    const directory = join(this.cacheRoot, 'bom', createHash('sha256').update(path).digest('hex').slice(0, 16))
    const tempDirectory = join(directory, `tmp-${process.pid}-${String(Date.now())}`)
    mkdirSync(tempDirectory, { recursive: true })
    const tempFile = join(tempDirectory, 'bom.csv')
    try {
      const result = await this.options.runCommand(
        installed.kicad.cli,
        ['sch', 'export', 'bom', '--output', tempFile, path],
        { cwd: dirname(path), timeoutMs: 60_000, ...(request.signal === undefined ? {} : { signal: request.signal }) },
      )
      if (result.timedOut) throw errorWithCode('kicad-cli sch export bom timed out', 'export-timeout', 504)
      if (result.exitCode !== 0) {
        const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`).slice(0, 800)
        throw errorWithCode(`kicad-cli sch export bom failed: ${detail}`, 'export-failed', 502)
      }
      if (!existsSync(tempFile)) throw errorWithCode('kicad-cli produced no BOM output', 'export-failed', 502)
      const rows = groupBomRows(parseCsv(readFileSync(tempFile, 'utf8')))
      const generated: BomResult = {
        path,
        revision,
        generatedAt: new Date().toISOString(),
        cached: false,
        rows,
        source: 'kicad-cli-bom',
      }
      this.bomCache.set(key, generated)
      return generated
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true })
    }
  }

  // -------------------------------------------------------------------------
  // Fabrication packaging and order submission
  // -------------------------------------------------------------------------

  /** Live order settings, read at call time so a settings write is immediate. */
  private orderSettings(): { baseUrl: string; pageBase: string; accessToken?: string } {
    const live = this.config.settings?.()
    const configured = [live?.orderBaseUrl, this.config.orderBaseUrl, process.env.HUAQIU_ORDER_BASE_URL]
      .find(value => value !== undefined && value.trim() !== '')
    const baseUrl = (configured ?? DEFAULT_ORDER_BASE_URL).replace(/\/+$/u, '')
    const pageBase = (this.config.orderPageBase ?? DEFAULT_ORDER_PAGE_BASE).replace(/\/+$/u, '')
    const token = live?.accessToken ?? this.config.accessToken ?? process.env.HUAQIU_ACCESS_TOKEN
    return {
      baseUrl,
      pageBase,
      ...(token === undefined || token.trim() === '' ? {} : { accessToken: token.trim() }),
    }
  }

  /** What the Order destination may do right now, without contacting anything. */
  async orderConfig(): Promise<OrderConfigInfo> {
    const installed = this.installations()
    const settings = this.orderSettings()
    return {
      configured: installed.kicad.configured,
      baseUrl: settings.baseUrl,
      hasToken: (await this.orderToken()) !== undefined,
      provider: 'huaqiu',
    }
  }

  /**
   * The token the order page must carry.
   *
   * An explicitly configured token wins (it makes a scripted run possible);
   * otherwise the signed-in Huaqiu session is used, which is the same token the
   * eda.cn API accepts. Absent both, ordering is refused before anything is
   * uploaded — the page would render signed out otherwise.
   */
  private async orderToken(): Promise<string | undefined> {
    const settings = this.orderSettings()
    if (settings.accessToken !== undefined) return settings.accessToken
    if (this.config.authToken === undefined) return undefined
    try {
      const token = await this.config.authToken()
      return token === null || token.trim() === '' ? undefined : token.trim()
    } catch {
      return undefined
    }
  }

  /**
   * Build the fabrication archive and the assembly inputs for one board.
   *
   * The gerber/drill export is `kicad-cli`'s own plotter, so the archive is the
   * same set of files a KiCad "Place order" would upload. Cached by source
   * revision: reopening the panel must not re-run the exporter.
   */
  async fabricate(request: {
    readonly boardPath: string
    readonly schematicPath?: string
    readonly sessionId?: string
    readonly signal?: AbortSignal
  }): Promise<FabricationResult & { readonly archiveData: Uint8Array; readonly assemblyFiles?: {
    readonly positions: string
    readonly bom: string
  } }> {
    const { path } = this.authorize(request.boardPath)
    if (extname(path).toLowerCase() !== '.kicad_pcb') {
      throw errorWithCode('Fabrication packaging requires a .kicad_pcb artifact', 'unsupported-artifact', 415)
    }
    const installed = this.installations()
    if (!installed.kicad.configured || installed.kicad.cli === undefined) {
      throw errorWithCode(installed.kicad.error ?? 'the configured KiCad installation has no kicad-cli', 'not-configured', 412)
    }
    const cli = installed.kicad.cli
    const revision = this.sourceRevision(path)
    const schematicPath = request.schematicPath === undefined
      ? undefined
      : this.authorize(request.schematicPath).path
    const key = `${path}:${revision}:${schematicPath ?? ''}`
    const cached = this.packageCache.get(key)
    if (cached !== undefined) return cached

    const directory = join(this.cacheRoot, 'fabrication', createHash('sha256').update(path).digest('hex').slice(0, 16))
    const work = join(directory, `tmp-${process.pid}-${String(Date.now())}`)
    const plots = join(work, 'plots')
    const positionsFile = join(work, 'positions.raw.csv')
    mkdirSync(plots, { recursive: true })

    const signal = request.signal
    const run = async (args: readonly string[], what: string, timeoutMs = 120_000): Promise<void> => {
      const result = await this.options.runCommand(cli, args, {
        cwd: dirname(path),
        timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      })
      if (result.timedOut) throw errorWithCode(`kicad-cli ${what} timed out`, 'export-timeout', 504)
      if (result.exitCode !== 0) {
        const detail = (result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`).slice(0, 800)
        throw errorWithCode(`kicad-cli ${what} failed: ${detail}`, 'export-failed', 502)
      }
    }

    try {
      await run(['pcb', 'export', 'gerbers', '--output', plots, path], 'pcb export gerbers')
      await run(['pcb', 'export', 'drill', '--output', plots, '--format', 'excellon',
        '--excellon-units', 'mm', '--drill-origin', 'absolute', path], 'pcb export drill')
      const plotNames = readdirSync(plots).filter(name => statSync(join(plots, name)).isFile()).sort()
      if (plotNames.length === 0) throw errorWithCode('kicad-cli wrote no fabrication files', 'export-failed', 502)
      const plotted = readExportDirectory(plots, plotNames)
      const archiveData = zipPackage(plotted)
      const facts = readBoardFacts(readFileSync(path, 'utf8'))
      // Validated here, not at the call sites: the UI, the HTTP route and the
      // agent tool all consume this one result, so the archive they show and
      // the package they would upload have to carry the same judgement.
      const validation = validateFabricationPackage(
        plotted.map(file => ({ name: file.name, bytes: file.data.byteLength })),
        facts,
      )

      let assembly: FabricationResult['assembly']
      let assemblyFiles: { positions: string; bom: string } | undefined
      if (schematicPath !== undefined) {
        await run(['pcb', 'export', 'pos', '--format', 'csv', '--units', 'mm', '--side', 'both',
          '--output', positionsFile, path], 'pcb export pos')
        const positions = parsePositions(readFileSync(positionsFile, 'utf8'))
        const bom = await this.exportBom({
          artifactPath: schematicPath,
          ...(signal === undefined ? {} : { signal }),
        })
        const bomRows = orderBomRows(positions, bom.rows)
        const positionsText = positionsCsv(positions)
        const bomText = orderBomCsv(bomRows)
        assemblyFiles = { positions: positionsText, bom: bomText }
        assembly = {
          positions: positions.length,
          bomLines: bomRows.length,
          positionsBytes: Buffer.byteLength(positionsText, 'utf8'),
          bomBytes: Buffer.byteLength(bomText, 'utf8'),
        }
      }

      const result: FabricationResult & { archiveData: Uint8Array; assemblyFiles?: { positions: string; bom: string } } = {
        boardPath: path,
        revision,
        generatedAt: new Date().toISOString(),
        facts,
        archive: {
          zipName: `${packageName(path)}.zip`,
          zipBytes: archiveData.byteLength,
          files: plotted.map(file => ({ name: file.name, bytes: file.data.byteLength })),
        },
        validation,
        archiveData,
        ...(assembly === undefined ? {} : { assembly }),
        ...(assemblyFiles === undefined ? {} : { assemblyFiles }),
      }
      this.packageCache.set(key, result)
      return result
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  /**
   * Write one prepared package into a directory.
   *
   * The package is normally kept in memory: the order panel shows it, the
   * submit uploads it, and neither needs a file. A caller that has to hand the
   * archive to someone else does — and re-running the plotter for that would
   * produce a different revision than the one already validated. This writes
   * exactly the bytes that were validated.
   *
   * Files are overwritten by design: the directory holds derived output, and a
   * rebuild of the same board replaces the previous export rather than
   * accumulating copies beside it. Nothing outside `directory` is touched.
   *
   * @param prepared - the value `fabricate` returned, archive bytes included.
   * @param directory - target directory, created when missing.
   */
  writePackage(
    prepared: FabricationResult & {
      readonly archiveData: Uint8Array
      readonly assemblyFiles?: { readonly positions: string; readonly bom: string }
    },
    directory: string,
  ): { directory: string; files: readonly { name: string; path: string; bytes: number }[] } {
    const target = canonical(directory)
    mkdirSync(target, { recursive: true })
    const files: { name: string; path: string; bytes: number }[] = []
    const write = (name: string, data: Uint8Array | string): void => {
      const path = join(target, name)
      const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data
      writeFileSync(path, payload)
      files.push({ name, path, bytes: payload.byteLength })
    }
    write(prepared.archive.zipName, prepared.archiveData)
    if (prepared.assemblyFiles !== undefined) {
      const stem = packageName(prepared.boardPath)
      write(`${stem}-positions.csv`, prepared.assemblyFiles.positions)
      write(`${stem}-bom.csv`, prepared.assemblyFiles.bom)
    }
    return { directory: target, files }
  }

  /**
   * Submit one order to the Huaqiu openapi, exactly as the KiCad action does.
   * PCB: every `PCB_FORM` field plus the gerber/drill archive as `file`.
   * SMT: `pcbFile` + `coordFile` + `bomFile` and `reqParseVO`, with the caller's
   * access token in `authorization`. The backend owns the order; this method
   * forwards the files and composes the final page URL from the returned id the
   * way the reference does.
   */
  async placeOrder(request: PlaceOrderRequest): Promise<PlaceOrderResult> {
    const settings = this.orderSettings()
    const bundle = await this.fabricate({
      boardPath: request.boardPath,
      ...(request.schematicPath === undefined ? {} : { schematicPath: request.schematicPath }),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    // Checked after the install gate so a missing KiCad is reported as such,
    // but before any upload: the page would open signed out without a token.
    const token = await this.orderToken()
    if (token === undefined) {
      throw errorWithCode(
        'placing an order requires a signed-in Huaqiu account (or HUAQIU_ACCESS_TOKEN)',
        'unauthorized',
        401,
      )
    }
    // A package that failed validation is refused here rather than at the
    // backend: an order is a real purchase, and uploading a gerber set missing
    // a layer produces a real, wrong board. Warnings do not block.
    if (!bundle.validation.ok) {
      throw errorWithCode(
        `the fabrication package cannot be ordered: ${validationSummary(bundle.validation) ?? 'validation failed'}`,
        'package-invalid',
        422,
      )
    }
    const facts = bundle.facts
    const endpoint = `${settings.baseUrl}${ORDER_PATHS[request.kind]}`

    let parts: { name: string; value: string }[]
    let files: { field: string; name: string; type: string; data: Uint8Array }[]
    let headers: Record<string, string> | undefined

    if (request.kind === 'pcb') {
      const form = pcbOrderForm(facts, request.quantity === undefined ? {} : { quantity: request.quantity })
      parts = Object.entries(form).map(([name, value]) => ({ name, value }))
      files = [{ field: 'file', name: bundle.archive.zipName, type: 'application/zip', data: bundle.archiveData }]
    } else {
      if (bundle.assemblyFiles === undefined) {
        throw errorWithCode('SMT order placement requires the project root schematic', 'invalid-request', 400)
      }
      const smt = smtOrderForm(facts, {
        bomFileName: `${packageName(bundle.boardPath)}-bom.csv`,
        coordFileName: `${packageName(bundle.boardPath)}-positions.csv`,
        materialTypes: bundle.assembly?.bomLines ?? 0,
        ...(request.quantity === undefined ? {} : { quantity: request.quantity }),
      })
      parts = [{
        name: 'reqParseVO',
        value: JSON.stringify({
          pcb_order: pcbOrderForm(facts, request.quantity === undefined ? {} : { quantity: request.quantity }),
          smt_order: smt,
        }),
      }]
      files = [
        { field: 'pcbFile', name: bundle.archive.zipName, type: 'application/zip', data: bundle.archiveData },
        {
          field: 'coordFile', name: String(smt.coord_file_name), type: 'application/octet-stream',
          data: new TextEncoder().encode(bundle.assemblyFiles.positions),
        },
        {
          field: 'bomFile', name: String(smt.bom_file_name), type: 'application/octet-stream',
          data: new TextEncoder().encode(bundle.assemblyFiles.bom),
        },
      ]
      headers = { authorization: token }
    }

    const boundary = `----huaqiu${createHash('sha256').update(`${endpoint}:${String(Date.now())}`).digest('hex').slice(0, 24)}`
    const payload = multipartBody(parts, files, boundary)
    const post = this.config.postOrder ?? defaultPostOrder

    let response: { status: number; text: string }
    try {
      response = await post(endpoint, {
        body: payload.body,
        contentType: payload.contentType,
        ...(headers === undefined ? {} : { headers }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw errorWithCode(`the order endpoint could not be reached: ${detail}`, 'order-unreachable', 502)
    }
    if (response.status < 200 || response.status >= 300) {
      throw errorWithCode(
        `the order endpoint rejected the request (HTTP ${String(response.status)}): ${response.text.slice(0, 400)}`,
        'order-rejected',
        502,
      )
    }

    let json: unknown
    try {
      json = JSON.parse(response.text)
    } catch {
      throw errorWithCode('the order endpoint returned an unreadable response', 'order-rejected', 502)
    }
    const responseUrl = orderUrlOf(json)
    if (responseUrl === undefined) {
      throw errorWithCode('the order endpoint returned no order URL', 'order-rejected', 502)
    }

    // Reproduce the URL KiCad's own action loads in its webview, including the
    // exact query the hqpcb page expects. For PCB that is a page composed
    // around the returned id/guid; for assembly the same kind of page, composed
    // from the returned id with `source=bom` (BOM matching). The backend's own
    // string is kept as `responseUrl` for diagnostics.
    const ids = orderIdsFromUrl(responseUrl)
    const orderUrl = request.kind === 'pcb'
      ? pcbOrderUrl(settings.pageBase, ids, token)
      : smtOrderUrl(settings.pageBase, ids, token) ?? smtOrderUrlFromBackend(responseUrl, token)
    if (orderUrl === undefined) {
      throw errorWithCode('the order endpoint returned an order id that cannot form a page URL', 'order-rejected', 502)
    }

    // The page must be shown, but the *client* shows it: a DSH panel opens it in
    // its own Browser tab, so the host opening the OS browser too would leave two
    // copies of the same order. Only a caller with no client asks for `launch`,
    // and even then a browser that will not start never discards the order.
    const launch = request.launch === true
    let opened: { launched: boolean; launcher?: string } = { launched: false }
    if (launch) {
      try {
        const result = this.openOrderUrl(orderUrl)
        opened = { launched: true, launcher: result.command }
      } catch {
        opened = { launched: false }
      }
    }

    return {
      kind: request.kind,
      orderUrl,
      responseUrl,
      ...opened,
      status: opened.launched ? 'launched' : 'ready',
      message: opened.launched
        ? `Opened the ${request.kind === 'pcb' ? 'PCB' : 'assembly'} order page in the default browser.`
        : `The ${request.kind === 'pcb' ? 'PCB' : 'assembly'} order page is ready at orderUrl.`,
      endpoint,
      facts,
      archive: bundle.archive,
      validation: bundle.validation,
      ...(bundle.assembly === undefined ? {} : { assembly: bundle.assembly }),
    }
  }

  /**
   * Open one order page in the OS default browser.
   *
   * This is the only place a URL reaches an external program; the URL is
   * validated by shape first and passed as a plain argument.
   */
  openOrderUrl(raw: string): { launched: true; command: string; url: string } {
    const url = externalUrlTarget(raw)
    const spec = this.options.openExternal(url)
    this.options.spawnProcess(spec.command, spec.args, {
      cwd: tmpdir(), detached: true, stdio: 'ignore', windowsHide: true, shell: false,
    })
    return { launched: true, command: spec.command, url }
  }

  /** Serve a generated GLB file, re-validating the cache entry first. */
  glbFile(boardPath: string, revision: string): string {
    const key = `${canonical(boardPath)}:${revision}`
    const entry = this.glbCache.get(key)
    if (entry === undefined || !existsSync(entry.file)) {
      throw errorWithCode('generated GLB is not available for this revision', 'stale-revision', 409)
    }
    return entry.file
  }

  /** Drop cached derived outputs for one board (or all of them). */
  clearCache(boardPath?: string): void {
    this.packageCache.clear()
    if (boardPath === undefined) {
      this.glbCache.clear()
      rmSync(this.cacheRoot, { recursive: true, force: true })
      return
    }
    const prefix = `${canonical(boardPath)}:`
    for (const key of [...this.glbCache.keys()]) {
      if (key.startsWith(prefix)) this.glbCache.delete(key)
    }
    rmSync(this.glbDirectory(canonical(boardPath)), { recursive: true, force: true })
  }
}

/** Ownership order: project-named board first, then shallower, then alphabetical. */
function boardRank(left: HardwareArtifact, right: HardwareArtifact, projectName: string): number {  const leftNamed = basename(left.path, '.kicad_pcb') === projectName ? 0 : 1
  const rightNamed = basename(right.path, '.kicad_pcb') === projectName ? 0 : 1
  if (leftNamed !== rightNamed) return leftNamed - rightNamed
  const leftDepth = left.path.split(sep).length
  const rightDepth = right.path.split(sep).length
  if (leftDepth !== rightDepth) return leftDepth - rightDepth
  return left.path.localeCompare(right.path)
}

/** RFC4180-style CSV reader: quoted fields, doubled quotes, CRLF rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const source = text.replace(/^\uFEFF/u, '')
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\r') {
      continue
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter(cells => cells.some(cell => cell.trim() !== ''))
}

/**
 * Group KiCad's per-reference BOM rows.
 *
 * Identity is every column except the reference and quantity columns, so a
 * different MPN or a DNP flag always produces a separate line; ordering follows
 * the first reference seen, which keeps the table stable between reads.
 *
 * Column names follow `kicad-cli sch export bom`'s default field set, which is
 * `Refs,Value,Footprint,Qty,DNP`; a customized `--fields` header may spell the
 * same columns out in full, and a grouped export may pack several references
 * into one cell, so both spellings and both shapes are accepted.
 */
export function groupBomRows(table: readonly string[][]): BomRow[] {
  const [header, ...body] = table
  if (header === undefined) return []
  const columns = header.map(cell => cell.trim())
  const find = (...aliases: readonly RegExp[]): number =>
    columns.findIndex(cell => aliases.some(alias => alias.test(cell)))
  const referenceIndex = find(/^refs?$/iu, /^references?$/iu)
  const quantityIndex = find(/^qty$/iu, /^quantity$/iu)
  const valueIndex = find(/^value$/iu)
  const footprintIndex = find(/^footprint$/iu)
  const dnpIndex = find(/^dnp$/iu)
  const groups = new Map<string, { references: string[]; fields: Record<string, string>; dnp: boolean }>()
  for (const cells of body) {
    const references = referenceIndex === -1
      ? []
      : (cells[referenceIndex] ?? '').split(/[,;\s]+/u).map(reference => reference.trim()).filter(reference => reference !== '')
    if (references.length === 0) continue
    const fields: Record<string, string> = {}
    columns.forEach((column, index) => {
      if (index === referenceIndex || index === quantityIndex || index === valueIndex
        || index === footprintIndex || index === dnpIndex) return
      const text = (cells[index] ?? '').trim()
      if (text !== '') fields[column] = text
    })
    const dnpText = dnpIndex === -1 ? '' : (cells[dnpIndex] ?? '').trim()
    const dnp = /^(1|true|yes|dnp|x)$/iu.test(dnpText)
    const identity = JSON.stringify([
      valueIndex === -1 ? '' : (cells[valueIndex] ?? '').trim(),
      footprintIndex === -1 ? '' : (cells[footprintIndex] ?? '').trim(),
      dnp,
      Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))),
    ])
    const group = groups.get(identity) ?? { references: [], fields, dnp }
    group.references.push(...references)
    groups.set(identity, group)
  }
  return [...groups.entries()].map(([identity, group]) => {
    const [value, footprint, dnp] = JSON.parse(identity) as [string, string, boolean]
    return {
      references: group.references,
      quantity: group.references.length,
      value,
      footprint,
      dnp,
      fields: group.fields,
    } satisfies BomRow
  })
}

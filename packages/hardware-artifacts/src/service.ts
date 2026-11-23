/**
 * Hardware Engineering artifact model and host operations.
 *
 * This module deliberately has no Cordis dependency: it is the testable core
 * behind `hardwareArtifacts`. Native project files remain authoritative; the
 * objects here are path pointers and verified installation facts, never a
 * shadow project database.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type ArtifactKind = 'schematic' | 'pcb' | 'pcb-3d' | 'bom' | 'mechanical-3d'
export type NativeApplication = 'kicad' | 'solidcraft'

export interface HardwareArtifact {
  readonly id: string
  readonly kind: ArtifactKind
  readonly path: string
  readonly projectPath?: string
  /** BOM keeps its schematic; PCB 3D keeps its board; sheets keep their root. */
  readonly sourcePath?: string
  readonly title: string
  readonly format: string
}

export interface HardwareProject {
  readonly path: string
  readonly name: string
  readonly schematic?: HardwareArtifact
  /** Semantic views; both keep the identity of their source artifact. */
  readonly bom?: HardwareArtifact
  readonly pcb3d?: HardwareArtifact
  readonly sheets: readonly HardwareArtifact[]
  readonly boards: readonly HardwareArtifact[]
  readonly mechanical: readonly HardwareArtifact[]
  readonly selectionRequired: boolean
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

export interface HardwareArtifactsOptions {
  readonly kicadRoot?: string
  readonly solidcraftRoot?: string
  readonly probeVersion?: (executable: string) => string | undefined
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { cwd: string; detached: boolean; stdio: 'ignore'; windowsHide: boolean; shell: false },
  ) => Pick<ChildProcess, 'pid'>
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
const MAX_DEPTH = 5

function canonical(path: string): string {
  return resolve(path)
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isExcluded(name: string): boolean {
  return EXCLUDED_DIRS.has(name.toLowerCase())
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

function defaultVersionProbe(executable: string): string | undefined {
  if (!existsSync(executable)) return undefined
  try {
    return execFileSync(executable, ['version'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n')[0] || undefined
  } catch {
    return undefined
  }
}

function existing(paths: readonly string[]): string | undefined {
  return paths.find((candidate) => {
    try {
      return existsSync(candidate) && statSync(candidate).isFile()
    } catch {
      return false
    }
  })
}

function kicadCandidates(root: string): { cli: string[]; kicad: string[]; eeschema: string[]; pcbnew: string[] } {
  const app = basename(root).toLowerCase().endsWith('.app')
  if (app || process.platform === 'darwin') {
    const base = app ? root : join(root, 'KiCad.app')
    return {
      cli: [join(base, 'Contents/MacOS/kicad-cli')],
      kicad: [join(base, 'Contents/MacOS/kicad')],
      eeschema: [join(base, 'Contents/Applications/eeschema.app/Contents/MacOS/eeschema')],
      pcbnew: [join(base, 'Contents/Applications/pcbnew.app/Contents/MacOS/pcbnew')],
    }
  }
  const exe = process.platform === 'win32' ? '.exe' : ''
  const bin = app ? root : basename(root).toLowerCase() === 'bin' ? root : join(root, 'bin')
  return {
    cli: [join(bin, `kicad-cli${exe}`), join(root, `kicad-cli${exe}`)],
    kicad: [join(bin, `kicad${exe}`)],
    eeschema: [join(bin, `eeschema${exe}`)],
    pcbnew: [join(bin, `pcbnew${exe}`)],
  }
}

function solidcraftCandidates(root: string): string[] {
  const exe = process.platform === 'win32' ? '.exe' : ''
  const app = basename(root).toLowerCase().endsWith('.app')
  if (app || process.platform === 'darwin') {
    const base = app ? root : join(root, 'SolidCraft.app')
    return [
      join(base, `Contents/MacOS/SolidCraft`),
      join(base, `Contents/MacOS/solidcraft`),
    ]
  }
  return [
    root,
    join(root, `SolidCraft${exe}`),
    join(root, `solidcraft${exe}`),
    join(root, 'bin', `SolidCraft${exe}`),
    join(root, 'bin', `solidcraft${exe}`),
  ]
}

/** Small, immutable host capability implementation. */
export class HardwareArtifactService {
  private readonly options: Required<Pick<HardwareArtifactsOptions, 'spawnProcess' | 'probeVersion'>>

  constructor(private readonly config: HardwareArtifactsOptions = {}) {
    this.options = {
      probeVersion: config.probeVersion ?? defaultVersionProbe,
      spawnProcess: config.spawnProcess ?? ((command, args, settings) => spawn(command, [...args], settings)),
    }
  }

  /** Resolve configured installations from validated absolute paths only. */
  installations(): Installations {
    const kicadRoot = this.config.kicadRoot ? canonical(this.config.kicadRoot) : undefined
    let kicadCli: string | undefined
    if (kicadRoot !== undefined) {
      const cliPaths = basename(kicadRoot).toLowerCase().startsWith('kicad-cli')
        ? [kicadRoot]
        : kicadCandidates(kicadRoot).cli
      kicadCli = existing(cliPaths)
    }
    const candidates = kicadRoot === undefined
      ? { cli: [], kicad: [], eeschema: [], pcbnew: [] }
      : kicadCandidates(kicadCli && basename(kicadCli).toLowerCase().startsWith('kicad-cli') ? dirname(dirname(dirname(kicadCli))) : kicadRoot)
    const pcbEditor = existing(candidates.pcbnew)
    const schematicEditor = existing(candidates.eeschema)
    const projectManager = existing(candidates.kicad)
    const kicad: InstallationInfo = kicadCli === undefined
      ? { configured: false, error: 'KiCad installation is not configured' }
      : {
          configured: true,
          root: kicadRoot,
          cli: kicadCli,
          ...(projectManager === undefined ? {} : { projectManager }),
          ...(pcbEditor === undefined ? {} : { pcbEditor }),
          ...(schematicEditor === undefined ? {} : { schematicEditor }),
          ...(this.options.probeVersion(kicadCli) === undefined ? {} : { version: this.options.probeVersion(kicadCli) }),
        }

    const solidRoot = this.config.solidcraftRoot ? canonical(this.config.solidcraftRoot) : undefined
    const solidExecutable = solidRoot === undefined ? undefined : existing(solidcraftCandidates(solidRoot))
    const solidcraft: InstallationInfo = solidExecutable === undefined
      ? { configured: false, error: 'SolidCraft installation is not configured' }
      : { configured: true, root: solidRoot, executable: solidExecutable }
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
    if (installed.solidcraft.executable !== undefined) lines.push(`  executable: ${installed.solidcraft.executable}`)
    if (installed.solidcraft.error !== undefined) lines.push(`  error: ${installed.solidcraft.error}`)
    if (current?.selected !== undefined) {
      lines.push('Current project:')
      lines.push(`  root: ${current.cwd}`)
      lines.push(`  project: ${current.selected.path}`)
      if (current.selected.schematic !== undefined) lines.push(`  schematic: ${current.selected.schematic.path}`)
      const board = current.selected.boards[0]
      if (board !== undefined) lines.push(`  selected_pcb: ${board.path}`)
    }
    lines.push('</hardware_environment>')
    return lines.join('\n')
  }

  /**
   * Deterministic discovery. An explicit project or manifest wins; otherwise
   * exactly one `.kicad_pro` may be selected automatically. Ambiguity is
   * returned as a selection requirement, never resolved by taking the first.
   */
  discover(cwdInput: string, explicitProject?: string): DiscoveryResult {
    const cwd = canonical(cwdInput)
    const manifestPath = join(cwd, '.hardware-engineering.json')
    let manifest: ProjectManifest | undefined
    if (existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProjectManifest
      } catch (error) {
        return { cwd, manifestPath, projects: [], issue: { code: 'bad-manifest', message: `invalid .hardware-engineering.json: ${String(error)}` } }
      }
    }

    const projectPaths = new Set<string>()
    if (explicitProject !== undefined && explicitProject.trim() !== '') {
      const requested = isAbsolute(explicitProject) ? canonical(explicitProject) : resolve(cwd, explicitProject)
      if (!existsSync(requested)) {
        return { cwd, ...(manifest === undefined ? {} : { manifestPath }), projects: [], issue: { code: 'missing-project', message: `${requested} does not exist` } }
      }
      projectPaths.add(requested)
    } else if (manifest?.project !== undefined && manifest.project.trim() !== '') {
      projectPaths.add(isAbsolute(manifest.project) ? canonical(manifest.project) : resolve(cwd, manifest.project))
    } else {
      for (const path of walkFiles(cwd, name => name.toLowerCase().endsWith('.kicad_pro'))) projectPaths.add(path)
    }

    const projects: HardwareProject[] = [...projectPaths].sort().map(path => this.projectFrom(path, cwd, manifest))
    if (projects.length === 0) {
      return { cwd, ...(manifest === undefined ? {} : { manifestPath }), projects, issue: { code: 'no-project', message: `no .kicad_pro found under ${cwd}` } }
    }
    if (projects.length > 1) {
      return { cwd, ...(manifest === undefined ? {} : { manifestPath }), projects, issue: { code: 'selection-required', message: `${projects.length} projects found; select one explicitly` } }
    }
    const selected = projects[0] as HardwareProject
    return {
      cwd,
      ...(manifest === undefined ? {} : { manifestPath }),
      projects,
      selected,
      ...(selected.selectionRequired
        ? { issue: { code: 'selection-required', message: 'select an artifact explicitly' } }
        : {}),
    }
  }

  private projectFrom(projectPath: string, cwd: string, manifest?: ProjectManifest): HardwareProject {
    const dir = dirname(projectPath)
    const name = basename(projectPath, extname(projectPath))
    const resolvePath = (value: string): string =>
      isAbsolute(value) ? canonical(value) : resolve(dir, value)

    const schematicPath = manifest?.schematic !== undefined
      ? resolvePath(manifest.schematic)
      : existing([join(dir, `${name}.kicad_sch`), ...walkFiles(dir, file => file.toLowerCase().endsWith('.kicad_sch'))])
    const boards = manifest?.boards !== undefined
      ? manifest.boards.map(board => artifact('pcb', resolvePath(board.path), projectPath))
      : walkFiles(dir, file => file.toLowerCase().endsWith('.kicad_pcb')).map(path => artifact('pcb', path, projectPath))
    const mechanical = manifest?.mechanical !== undefined
      ? manifest.mechanical.map(model => artifact('mechanical-3d', resolvePath(model.path), projectPath))
      : walkFiles(dir, file => MECHANICAL_EXTENSIONS.has(extname(file).toLowerCase()))
        .map(path => artifact('mechanical-3d', path, projectPath))
    const sheets = schematicPath === undefined
      ? []
      : walkFiles(dir, file => file.toLowerCase().endsWith('.kicad_sch'))
        .filter(path => path !== schematicPath && isInside(path, dir))
        .map(path => artifact('schematic', path, projectPath, schematicPath))

    const sourceSchematic = schematicPath === undefined ? undefined : artifact('schematic', schematicPath, projectPath)
    const sourceBoard = boards[0]
    return {
      path: projectPath,
      name,
      ...(sourceSchematic === undefined ? {} : { schematic: sourceSchematic }),
      ...(sourceSchematic === undefined ? {} : {
        bom: { ...artifact('bom', sourceSchematic.path, projectPath, sourceSchematic.path), title: `BOM — ${sourceSchematic.title}` },
      }),
      ...(sourceBoard === undefined ? {} : {
        pcb3d: { ...artifact('pcb-3d', sourceBoard.path, projectPath, sourceBoard.path), title: `3D — ${sourceBoard.title}` },
      }),
      sheets,
      boards,
      mechanical,
      selectionRequired: boards.length > 1 || sheets.length > 1,
    }
  }

  /** Validate and launch a native application without a shell. */
  open(request: OpenArtifactRequest): OpenArtifactResult {
    const path = canonical(request.artifactPath)
    if (!existsSync(path)) {
      throw Object.assign(new Error(`artifact does not exist: ${path}`), { code: 'missing-artifact', status: 404 })
    }
    const installed = this.installations()
    const isKicad = request.application === 'kicad'
    let command: string | undefined
    if (isKicad) {
      const ext = extname(path).toLowerCase()
      if (ext === '.kicad_sch') command = installed.kicad.schematicEditor
      else if (ext === '.kicad_pcb') command = installed.kicad.pcbEditor
      else if (ext === '.kicad_pro') command = installed.kicad.projectManager
      else throw Object.assign(new Error(`unsupported KiCad artifact: ${ext}`), { code: 'unsupported-artifact', status: 415 })
      if (command === undefined) {
        throw Object.assign(new Error('the configured KiCad installation has no editor for this artifact'), { code: 'missing-executable', status: 412 })
      }
    } else {
      command = installed.solidcraft.executable
      if (command === undefined) {
        throw Object.assign(new Error('SolidCraft is not configured'), { code: 'not-configured', status: 412 })
      }
      if (!MECHANICAL_EXTENSIONS.has(extname(path).toLowerCase())) {
        throw Object.assign(new Error(`unsupported SolidCraft artifact: ${extname(path)}`), { code: 'unsupported-artifact', status: 415 })
      }
    }
    const settings = { cwd: dirname(path), detached: true, stdio: 'ignore' as const, windowsHide: true, shell: false as const }
    const child = this.options.spawnProcess(command, [path], settings)
    return { launched: true, command, args: [path], cwd: settings.cwd, ...(child.pid === undefined ? {} : { pid: child.pid }) }
  }
}

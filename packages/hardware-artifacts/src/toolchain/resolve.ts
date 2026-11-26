/**
 * One resolver for both external toolchains.
 *
 * Every consumer — the export/launch service, the settings panel, background
 * discovery, the installer's post-extraction validation and the agent prompt —
 * must agree on what "configured" means, or the product grows the two
 * independent validation systems `hardware-engineering-toolchain-onboarding…`
 * §10.5 rules out. This module is that agreement: pure functions from a
 * *configured path* to the executables it owns, plus one version normaliser.
 *
 * The configured value stays the user's object (an installation root), and the
 * executables are derived from it, because that is what the spec requires
 * (§3.1): a user who pastes `…\KiCad\10.0\bin` or `…\bin\kicad-cli.exe` keeps
 * whatever they pasted, while the product resolves around it.
 *
 * @module @huaqiu/hardware-artifacts/toolchain/resolve
 */
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** The two tools this product configures. */
export type ToolchainId = 'kicad' | 'solidcraft'

/** How a configured path was obtained; persisted for display only. */
export type ToolchainSource = 'manual' | 'browse' | 'download' | 'detected'

/** Everything one tool's configuration resolves to. */
export interface ToolchainResolution {
  /** True only when the primary executable exists *and* answered a version probe. */
  readonly configured: boolean
  /** Installation root the executables are resolved from. */
  readonly installPath?: string
  /** Primary CLI the product runs (`kicad-cli` / `solidcraft-cli`). */
  readonly cli?: string
  /** CLI version normalised from the tool's own report. */
  readonly version?: string
  /** GUI application, when the distribution ships one. */
  readonly app?: string
  /** KiCad project manager (`kicad`). */
  readonly projectManager?: string
  /** KiCad schematic editor (`eeschema`). */
  readonly schematicEditor?: string
  /** KiCad board editor (`pcbnew`). */
  readonly pcbEditor?: string
  /** Operator-facing reason the tool is not configured. */
  readonly error?: string
}

/** Candidates one configured root can resolve to, by executable name. */
export interface ExecutableCandidates {
  /** Primary command-line executable(s), in resolution order. */
  readonly cli: readonly string[]
  /** GUI application executable(s), in resolution order. */
  readonly app: readonly string[]
  /** Named secondary executables (KiCad's editors). */
  readonly named: Readonly<Partial<Record<'projectManager' | 'schematicEditor' | 'pcbEditor', readonly string[]>>>
}

/** Injectable facts so resolution is testable off the target platform. */
export interface ResolveInternals {
  readonly platform?: NodeJS.Platform
  /** Version probe; `undefined` means the executable did not answer. */
  readonly probeVersion?: (executable: string, tool: ToolchainId) => string | undefined
  readonly exists?: (path: string) => boolean
}

/** Canonical absolute form used for every persisted path. */
export function canonicalPath(path: string): string {
  return resolve(path)
}

function platformOf(internals: ResolveInternals): NodeJS.Platform {
  return internals.platform ?? process.platform
}

function existing(paths: readonly string[], internals: ResolveInternals): string | undefined {
  const exists = internals.exists ?? ((candidate: string) => {
    try {
      return existsSync(candidate) && statSync(candidate).isFile()
    } catch {
      return false
    }
  })
  return paths.find(path => exists(path))
}

/**
 * Normalise a version report to the version itself.
 *
 * `kicad-cli version` prints `10.0.7`; `solidcraft-cli --version` prints
 * `solidcraft-cli 0.49.1`. The product needs one comparable token from both so
 * a manifest version can be matched against an installed one. A report with no
 * version-shaped token is not a version (§5.3 "unsupported version output").
 * @param output - raw first line of the tool's version command.
 * @returns the dotted version, or undefined when the output carries none.
 */
export function normalizeVersion(output: string | undefined): string | undefined {
  if (output === undefined) return undefined
  const match = /\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/u.exec(output)
  return match?.[0]
}

/**
 * Executable layout candidates for one configured path.
 *
 * The Windows portable distributions this product downloads put the CLI in
 * `bin/` (KiCad) or beside the app (SolidCraft); a system installation uses the
 * same shape under a versioned folder, and macOS wraps both in an app bundle.
 * @param tool - which toolchain the root belongs to.
 * @param root - configured root, a `bin` directory, or an installation root.
 * @param internals - platform injection.
 * @returns candidate paths in resolution order.
 */
export function executableCandidates(
  tool: ToolchainId,
  root: string,
  internals: ResolveInternals = {},
): ExecutableCandidates {
  const platform = platformOf(internals)
  const exe = platform === 'win32' ? '.exe' : ''
  const lower = basename(root).toLowerCase()
  const isAppBundle = lower.endsWith('.app')
  const mac = isAppBundle || platform === 'darwin'

  if (tool === 'kicad') {
    if (mac) {
      const base = isAppBundle ? root : join(root, 'KiCad.app')
      return {
        cli: [join(base, 'Contents/MacOS/kicad-cli')],
        app: [join(base, 'Contents/MacOS/kicad')],
        named: {
          projectManager: [join(base, 'Contents/MacOS/kicad')],
          schematicEditor: [join(base, 'Contents/Applications/eeschema.app/Contents/MacOS/eeschema')],
          pcbEditor: [join(base, 'Contents/Applications/pcbnew.app/Contents/MacOS/pcbnew')],
        },
      }
    }
    // A configured `bin` directory is itself the bin; anything else owns one.
    const bin = lower === 'bin' ? root : join(root, 'bin')
    return {
      cli: [join(bin, `kicad-cli${exe}`), join(root, `kicad-cli${exe}`)],
      app: [join(bin, `kicad${exe}`)],
      named: {
        projectManager: [join(bin, `kicad${exe}`)],
        schematicEditor: [join(bin, `eeschema${exe}`)],
        pcbEditor: [join(bin, `pcbnew${exe}`)],
      },
    }
  }

  if (mac) {
    const base = isAppBundle ? root : join(root, 'SolidCraft.app')
    return {
      cli: [join(base, 'Contents/MacOS/solidcraft-cli')],
      app: [join(base, 'Contents/MacOS/SolidCraft'), join(base, 'Contents/MacOS/solidcraft')],
      named: {},
    }
  }
  return {
    cli: [join(root, `solidcraft-cli${exe}`), join(root, 'bin', `solidcraft-cli${exe}`)],
    app: [
      join(root, `SolidCraft${exe}`),
      join(root, `solidcraft${exe}`),
      join(root, 'bin', `SolidCraft${exe}`),
      join(root, 'bin', `solidcraft${exe}`),
    ],
    named: {},
  }
}

/** Installation root that owns one resolved executable, per layout convention. */
export function installRootFromExecutable(executable: string): string {
  const segments = executable.split(sep)
  const macIndex = segments.indexOf('Contents')
  if (macIndex > 0) return segments.slice(0, macIndex).join(sep) || sep
  if (segments[segments.length - 2]?.toLowerCase() === 'bin') return segments.slice(0, -2).join(sep) || sep
  return dirname(executable)
}

/** Executable stems the product accepts as a pasted executable path. */
const KICAD_STEMS = ['kicad-cli', 'kicad', 'eeschema', 'pcbnew', 'cvpcb', 'gerbview']
const SOLIDCRAFT_STEMS = ['solidcraft-cli', 'solidcraft']

/**
 * Normalise what the user typed into the installation root the product stores.
 *
 * Accepts an installation root, a `bin` directory or a direct executable path
 * (§3.1/§6.1). An already-correct root is returned unchanged — the product must
 * never silently retarget a path the user chose (§6.1).
 * @param tool - which toolchain the path belongs to.
 * @param input - the raw user input or native-dialog selection.
 * @returns the installation root to persist, or undefined for blank input.
 */
export function installationRootOf(tool: ToolchainId, input: string): string | undefined {
  const trimmed = input.trim()
  if (trimmed === '') return undefined
  const full = canonicalPath(trimmed)
  const name = basename(full).toLowerCase()
  const stem = name.replace(/\.(exe|app|command|bat|cmd)$/u, '')
  const stems = tool === 'kicad' ? KICAD_STEMS : SOLIDCRAFT_STEMS
  // A `bin` directory is not an installation root, whatever else it is called.
  if (name === 'bin') return dirname(full)
  // An existing directory is the answer. This is the case that used to break real
  // installations: `C:\Program Files\SolidCraft` and `…\KiCad\8.0` were read as
  // executables because their *folder* name matched the CLI stem, and the
  // configured root silently became the parent directory (§6.1).
  if (isDirectory(full)) return full
  const isExecutable = name.endsWith('.app')
    ? true
    : stems.some(candidate => stem === candidate)
  if (isExecutable) return installRootFromExecutable(full)
  return full
}

/** True when the path exists and is a directory; a missing path is not a directory. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve one configured root into its executables and validated state.
 *
 * A candidate is configured only after its primary CLI exists *and* answers a
 * version probe (§5.3). An executable that exists but reports nothing stays
 * unconfigured, with the probe failure as its reason. SolidCraft additionally
 * tolerates a distribution whose CLI is missing while its app is present —
 * that is a usable installation with no version, not an error (§3.1).
 * @param tool - which toolchain to resolve.
 * @param root - configured installation root.
 * @param internals - platform/probe injection.
 * @returns the resolution, including the operator-facing failure reason.
 */
export function resolveToolchain(
  tool: ToolchainId,
  root: string | undefined,
  internals: ResolveInternals = {},
): ToolchainResolution {
  if (root === undefined || root.trim() === '') {
    return { configured: false, error: `${label(tool)} installation is not configured` }
  }
  const installPath = canonicalPath(root)
  const candidates = executableCandidates(tool, installPath, internals)
  const cli = existing(candidates.cli, internals)
  const app = existing(candidates.app, internals)
  const pcbEditor = existing(candidates.named.pcbEditor ?? [], internals)
  const schematicEditor = existing(candidates.named.schematicEditor ?? [], internals)
  const projectManager = existing(candidates.named.projectManager ?? [], internals)
  const editors: Partial<ToolchainResolution> = {
    ...(projectManager === undefined ? {} : { projectManager }),
    ...(schematicEditor === undefined ? {} : { schematicEditor }),
    ...(pcbEditor === undefined ? {} : { pcbEditor }),
  }

  if (tool === 'kicad') {
    if (cli === undefined) {
      return {
        configured: false,
        installPath,
        ...(app === undefined ? {} : { app }),
        ...editors,
        error: `no kicad-cli executable under ${installPath}`,
      }
    }
    const version = internals.probeVersion?.(cli, tool)
    if (version === undefined) {
      return {
        configured: false,
        installPath,
        cli,
        ...(app === undefined ? {} : { app }),
        ...editors,
        error: `${cli} did not answer a version probe`,
      }
    }
    return {
      configured: true,
      installPath,
      cli,
      version,
      ...(app === undefined ? {} : { app }),
      ...editors,
    }
  }

  if (cli === undefined && app === undefined) {
    return { configured: false, installPath, error: `no solidcraft executable under ${installPath}` }
  }
  const probeTarget = cli ?? app
  const version = probeTarget === undefined ? undefined : internals.probeVersion?.(probeTarget, tool)
  return {
    configured: true,
    installPath,
    ...(cli === undefined ? {} : { cli }),
    ...(app === undefined ? {} : { app }),
    ...(version === undefined ? {} : { version }),
  }
}

/** Display name of one toolchain, used in operator-facing messages. */
export function label(tool: ToolchainId): string {
  return tool === 'kicad' ? 'KiCad' : 'SolidCraft'
}

/**
 * Whether a manifest version and an installed version describe one release.
 *
 * The Huaqiu KiCad archive is packaged as `10.0.7-2` while `kicad-cli` reports
 * `10.0.7`, so a strict comparison would refuse to reuse an installation that
 * is exactly the requested one (§8.6). The packaging revision therefore
 * compares as a prefix, not as a different version.
 * @param manifestVersion - version from the toolchain manifest.
 * @param installedVersion - version the installed executable reports.
 * @returns true when they name the same release.
 */
export function sameRelease(manifestVersion: string, installedVersion: string | undefined): boolean {
  if (installedVersion === undefined) return false
  const a = manifestVersion.trim().toLowerCase()
  const b = installedVersion.trim().toLowerCase()
  if (a === b) return true
  return a.startsWith(`${b}-`) || a.startsWith(`${b}+`) || b.startsWith(`${a}-`) || b.startsWith(`${a}+`)
}

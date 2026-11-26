/**
 * A real native file chooser, owned by this plugin.
 *
 * The spec requires an actual OS dialog, not a simulated one (§4.5/§6.2), and
 * the Host's own `directoryPicker` seam can only choose *directories* while this
 * feature must also accept an executable. Rather than change a shared Host
 * capability for one caller, the plugin drives the platform's own dialog in a
 * child process: `IFileOpenDialog` through the Windows PowerShell host, an
 * `NSOpenPanel` through the system JXA host, and `zenity`/`kdialog` on Linux.
 * Nothing is rendered by the browser, and nothing is fabricated: a cancelled
 * dialog reports cancellation.
 *
 * The directory-only case stays on the Host's seam (see the plugin's
 * `browse` route), so a machine where this picker is unavailable still offers a
 * native chooser backed by DSH itself.
 *
 * @module @huaqiu/hardware-artifacts/toolchain/dialog
 */
import { execFile } from 'node:child_process'

/** One file-type filter row. */
export interface FileFilter {
  readonly name: string
  /** Glob patterns, e.g. `['kicad-cli.exe']`. */
  readonly patterns: readonly string[]
}

/** What to ask the operator for. */
export interface PickFileRequest {
  readonly title: string
  readonly filters?: readonly FileFilter[]
  readonly initialDirectory?: string
}

/** How the chooser ended. */
export type PickFileResult =
  | { readonly kind: 'picked'; readonly path: string; readonly mechanism: string }
  | { readonly kind: 'cancelled'; readonly mechanism: string }
  | { readonly kind: 'unsupported'; readonly message: string }

/** Injectable command runner so every platform branch is testable. */
export type DialogRunner = (
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }>

/** Default runner: a child process, never a shell (§6.2 of the runtime constraints). */
const defaultRunner: DialogRunner = (command, args, options) => new Promise((resolvePromise, reject) => {
  execFile(command, [...args], {
    timeout: options.timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }, (error, stdout, stderr) => {
    if (error === null) {
      resolvePromise({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 })
      return
    }
    const code = (error as { code?: unknown }).code
    if (typeof code === 'number') {
      resolvePromise({ stdout: String(stdout), stderr: String(stderr), exitCode: code })
      return
    }
    reject(error)
  })
})

/** PowerShell single-quoted literal: only `'` needs doubling. */
function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** One platform's filter string (`Windows` requires `name|pattern|name|pattern`). */
function windowsFilter(filters: readonly FileFilter[]): string {
  const rows = filters.map(filter => `${filter.name}|${filter.patterns.join(';')}`)
  rows.push('All files (*.*)|*.*')
  return rows.join('|')
}

/** Windows dialog script; the whole conversation runs in one child process. */
function windowsScript(request: PickFileRequest): string {
  return [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    `$dialog.Title = ${quotePowerShell(request.title)}`,
    `$dialog.Filter = ${quotePowerShell(windowsFilter(request.filters ?? []))}`,
    '$dialog.CheckFileExists = $true',
    '$dialog.Multiselect = $false',
    ...(request.initialDirectory === undefined || request.initialDirectory === ''
      ? []
      : [
          'try {',
          `  $dialog.InitialDirectory = ${quotePowerShell(request.initialDirectory)}`,
          '} catch { }',
        ]),
    // A process spawned by a background host cannot take the foreground; an
    // invisible topmost owner is what makes the dialog appear in front of it.
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
    '$owner.Opacity = 0',
    'try {',
    '  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
    '    [Console]::Out.WriteLine($dialog.FileName)',
    '  } else {',
    '    exit 2',
    '  }',
    '} finally {',
    '  $owner.Dispose()',
    '}',
  ].join('\n')
}

/** macOS `NSOpenPanel` source (JXA), with the copy encoded as JSON literals. */
function macPanelScript(request: PickFileRequest): string {
  const title = JSON.stringify(request.title)
  const directory = JSON.stringify(request.initialDirectory ?? '')
  return `ObjC.import('AppKit');
function run() {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var panel = $.NSOpenPanel.openPanel;
  panel.canChooseFiles = true;
  panel.canChooseDirectories = false;
  panel.allowsMultipleSelection = false;
  panel.message = ${title};
  var start = ${directory};
  if (start !== '') panel.directoryURL = $.NSURL.fileURLWithPath(start);
  $.NSOperationQueue.mainQueue.addOperationWithBlock(function() {
    app.activateIgnoringOtherApps(true);
  });
  if (panel.runModal !== $.NSModalResponseOK) return '';
  var urls = panel.URLs;
  if (urls.count < 1) return '';
  return ObjC.unwrap(urls.objectAtIndex(0).path);
}`
}

function firstLine(text: string): string {
  return text.replace(/[\r\n]+$/u, '').split(/\r?\n/u)[0] ?? ''
}

/** Map a missing binary into the "unsupported" verdict instead of a crash. */
function isMissingBinary(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

/**
 * Show the platform's file chooser and wait for the operator.
 * @param request - title, filters and starting directory.
 * @param internals - platform/runner/timeout injection.
 * @returns the picked path, a cancellation, or an unsupported-platform notice.
 */
export async function pickFile(
  request: PickFileRequest,
  internals: {
    readonly platform?: NodeJS.Platform
    readonly run?: DialogRunner
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
  } = {},
): Promise<PickFileResult> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? defaultRunner
  const timeoutMs = internals.timeoutMs ?? 15 * 60_000
  const options = { timeoutMs, ...(internals.signal === undefined ? {} : { signal: internals.signal }) }

  if (platform === 'win32') {
    const encoded = Buffer.from(windowsScript(request), 'utf16le').toString('base64')
    const result = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
    ], options)
    if (result.exitCode === 2) return { kind: 'cancelled', mechanism: 'win32' }
    if (result.exitCode !== 0) {
      return { kind: 'unsupported', message: result.stderr.trim() === '' ? `dialog exited with ${String(result.exitCode)}` : result.stderr.trim() }
    }
    const path = firstLine(result.stdout)
    return path === '' ? { kind: 'cancelled', mechanism: 'win32' } : { kind: 'picked', path, mechanism: 'win32' }
  }

  if (platform === 'darwin') {
    try {
      const result = await run('osascript', ['-l', 'JavaScript', '-e', macPanelScript(request)], options)
      const path = firstLine(result.stdout)
      return path === '' ? { kind: 'cancelled', mechanism: 'darwin' } : { kind: 'picked', path, mechanism: 'darwin' }
    } catch (error) {
      if (isMissingBinary(error)) return { kind: 'unsupported', message: 'osascript is unavailable' }
      throw error
    }
  }

  if (platform === 'linux') {
    const filters = (request.filters ?? []).flatMap(filter =>
      filter.patterns.map(pattern => `--file-filter=${filter.name} | ${pattern}`))
    try {
      const result = await run('zenity', [
        '--file-selection', `--title=${request.title}`,
        ...(request.initialDirectory === undefined || request.initialDirectory === ''
          ? []
          : [`--filename=${request.initialDirectory}`]),
        ...filters,
      ], options)
      if (result.exitCode === 1) return { kind: 'cancelled', mechanism: 'zenity' }
      const path = firstLine(result.stdout)
      return path === '' ? { kind: 'cancelled', mechanism: 'zenity' } : { kind: 'picked', path, mechanism: 'zenity' }
    } catch (error) {
      if (!isMissingBinary(error)) throw error
    }
    try {
      const result = await run('kdialog', [
        '--title', request.title,
        ...(request.initialDirectory === undefined || request.initialDirectory === ''
          ? []
          : [request.initialDirectory]),
        ...(request.filters ?? []).flatMap(filter => filter.patterns),
      ], options)
      if (result.exitCode === 1) return { kind: 'cancelled', mechanism: 'kdialog' }
      const path = firstLine(result.stdout)
      return path === '' ? { kind: 'cancelled', mechanism: 'kdialog' } : { kind: 'picked', path, mechanism: 'kdialog' }
    } catch (error) {
      if (isMissingBinary(error)) return { kind: 'unsupported', message: 'no native file chooser is installed (zenity or kdialog)' }
      throw error
    }
  }

  return { kind: 'unsupported', message: `no native file chooser on ${platform}` }
}

/** Filters the two toolchains accept, per §6.2's suggested list. */
export const TOOLCHAIN_FILTERS: Readonly<Record<'kicad' | 'solidcraft', readonly FileFilter[]>> = Object.freeze({
  kicad: Object.freeze([{ name: 'KiCad CLI (kicad-cli.exe)', patterns: Object.freeze(['kicad-cli.exe', 'kicad-cli']) }]),
  solidcraft: Object.freeze([
    { name: 'SolidCraft (solidcraft*.exe)', patterns: Object.freeze(['solidcraft.exe', 'solidcraft-cli.exe', 'solidcraft']) },
  ]),
})

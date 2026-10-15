/**
 * 本地 subprocess 执行器：在当前机器上直接调用 kicad-cli。
 */
import { spawn, execSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { tmpdir, platform, homedir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { ExecutorError, type DrcExecutor, type DrcRunOptions, type DrcRunResult } from './executor.ts'

const IS_WIN = platform() === 'win32'

/** 探测 kicad-cli 路径（多级降级策略）。 */
export function resolveKicadCli(explicit?: string): string {
  // 1. 用户显式指定 → 直接用
  if (explicit) {
    if (existsSync(explicit)) return explicit
    throw new ExecutorError(`指定的 kicad-cli 不存在: ${explicit}`)
  }

  // 2. 环境变量 KICAD_CLI_PATH / KICAD_PATH
  const envPath = process.env.KICAD_CLI_PATH || process.env.KICAD_PATH
  if (envPath) {
    const candidate = envPath.endsWith('kicad-cli' + (IS_WIN ? '.exe' : ''))
      ? envPath
      : join(envPath, IS_WIN ? 'kicad-cli.exe' : 'kicad-cli')
    if (existsSync(candidate)) return candidate
  }

  // 3. 从 PATH 搜索（Windows 用 where，Unix 用 which）
  const inPath = IS_WIN ? searchPathWindows() : searchPathUnix()
  if (inPath) return inPath

  // 4. Windows 注册表查询 KiCad 安装路径
  if (IS_WIN) {
    const regPath = searchRegistryKicad()
    if (regPath) return regPath
  }

  // 5. 扫描常见安装目录的所有版本子目录
  const scanned = scanCommonInstallDirs()
  if (scanned) return scanned

  // 6. 兜底：用 PowerShell 在所有盘符下浅层搜索 kicad-cli.exe（最大深度 4 层）
  if (IS_WIN) {
    const psFound = searchKicadCliByPowerShell()
    if (psFound) return psFound
  }

  // 7. 兜底：抛出带详细排查步骤的错误
  throw new ExecutorError(
    '找不到 kicad-cli。请尝试以下任一方法：\n' +
    '  1) 在插件配置里设置 kicadCliPath 为 kicad-cli 的绝对路径\n' +
    '  2) 设置环境变量 KICAD_CLI_PATH 指向 kicad-cli.exe\n' +
    '  3) 安装 KiCad 后重启（安装程序会把 kicad-cli 加入 PATH）\n' +
    '  4) 确认 KiCad 安装目录下的 bin/ 子目录里有 kicad-cli.exe',
  )
}

/** Windows: 用 PowerShell 在所有盘符下浅层搜索 kicad-cli.exe。
 *  最大深度 4 层，跳过系统目录（Windows、$Recycle.Bin、System Volume Information 等）。
 *  对中文路径友好（PowerShell 原生支持 UTF-8）。 */
function searchKicadCliByPowerShell(): string | null {
  const psScript = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $ErrorActionPreference = 'SilentlyContinue'
    $exclude = @('Windows', '$Recycle.Bin', 'System Volume Information', 'WinSxS', 'Installer', 'Microsoft', 'ProgramData', 'Boot', 'Recovery', 'PerfLogs')
    $found = $null
    $drives = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -gt 0 } | Select-Object -ExpandProperty Root
    foreach ($drive in $drives) {
      if ($found) { break }
      # 先直接看根目录下有没有 kicad-cli.exe
      $direct = Join-Path $drive 'kicad-cli.exe'
      if (Test-Path $direct) { $found = $direct; break }
      # 再看根目录\bin\kicad-cli.exe
      $directBin = Join-Path $drive 'bin\kicad-cli.exe'
      if (Test-Path $directBin) { $found = $directBin; break }
      # 递归搜索最大深度 4
      Get-ChildItem -Path $drive -Directory -Depth 3 -ErrorAction SilentlyContinue | ForEach-Object {
        if ($found) { return }
        $name = $_.Name
        if ($exclude -contains $name) { return }
        $candidate = Join-Path $_.FullName 'kicad-cli.exe'
        if (Test-Path $candidate) { $found = $candidate; return }
        $candidateBin = Join-Path $_.FullName 'bin\kicad-cli.exe'
        if (Test-Path $candidateBin) { $found = $candidateBin; return }
      }
    }
    if ($found) { Write-Output $found }
  `

  try {
    const out = execSync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000, // 30 秒超时
    }).trim()
    if (out && existsSync(out)) return out
  } catch { /* ignore */ }
  return null
}

/** Windows: 用 where 命令搜 PATH。 */
function searchPathWindows(): string | null {
  try {
    const out = execSync('where kicad-cli', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    // where 可能输出多行（.exe / .cmd 等），取第一个
    const line = out.split(/\r?\n/)[0]?.trim()
    if (line && existsSync(line)) return line
  } catch { /* not found in PATH */ }
  return null
}

/** Unix: 用 which 命令搜 PATH。 */
function searchPathUnix(): string | null {
  try {
    const out = execSync('which kicad-cli 2>/dev/null', { encoding: 'utf-8', shell: '/bin/bash' }).trim()
    if (out && existsSync(out)) return out
  } catch { /* not found */ }
  return null
}

/** Windows: 从注册表读 KiCad 安装目录。
 *  注意：reg query 输出是系统默认编码（中文 Windows 为 GBK），用 utf-8 解码会乱码。
 *  改用 PowerShell Get-ItemProperty 读取，输出编码强制 UTF-8。 */
function searchRegistryKicad(): string | null {
  // 注册表键列表定义在下面的 PowerShell 脚本里（$keys / $uninstPaths），这里不再重复维护
  const psScript = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $ErrorActionPreference = 'SilentlyContinue'
    $keys = @(
      'HKLM:\\SOFTWARE\\KiCad',
      'HKLM:\\SOFTWARE\\WOW6432Node\\KiCad',
      'HKCU:\\SOFTWARE\\KiCad'
    )
    foreach ($k in $keys) {
      $p = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
      if ($p) {
        if ($p.InstallDir) { Write-Output $p.InstallDir; exit }
        if ($p.'Install Directory') { Write-Output $p.'Install Directory'; exit }
        if ($p.'(default)') { Write-Output $p.'(default)'; exit }
      }
    }
    # 检查 Uninstall 项
    $uninstPaths = @(
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    )
    foreach ($base in $uninstPaths) {
      Get-ChildItem -Path $base -ErrorAction SilentlyContinue | ForEach-Object {
        $p = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
        if ($p.DisplayName -match 'KiCad' -and $p.InstallLocation) {
          Write-Output $p.InstallLocation
          exit
        }
      }
    }
  `

  try {
    const out = execSync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (out) {
      // PowerShell 输出可能有多行，取第一行非空
      const dir = out.split(/\r?\n/).find(l => l.trim())?.trim()
      if (dir) {
        const candidate = join(dir, 'bin', 'kicad-cli.exe')
        if (existsSync(candidate)) return candidate
        // 有些 InstallLocation 直接指向 bin 目录
        if (existsSync(join(dir, 'kicad-cli.exe'))) return join(dir, 'kicad-cli.exe')
      }
    }
  } catch { /* ignore */ }
  return null
}

/**
 * 扫描常见安装目录下的所有版本子目录。
 * 策略：
 *  1. 枚举所有可用盘符（C: ~ Z:）
 *  2. 在每个盘符下尝试常见安装根目录名（Program Files, software, tools, apps, 等）
 *  3. 每个根目录下尝试直接 bin/kicad-cli.exe，或遍历子目录找版本号目录
 */
function scanCommonInstallDirs(): string | null {
  const EXE = IS_WIN ? 'kicad-cli.exe' : 'kicad-cli'

  const tryPath = (p: string): string | null => {
    try {
      if (existsSync(p)) {
        const st = statSync(p)
        if (st.isFile()) return p
        // 如果是目录，检查其下 bin/EXE
        const bin = join(p, 'bin', EXE)
        if (existsSync(bin)) return bin
      }
    } catch { /* ignore */ }
    return null
  }

  if (IS_WIN) {
    // 枚举可用盘符
    const drives: string[] = []
    for (let i = 2; i <= 25; i++) { // C(2) ~ Z(25)
      const drive = String.fromCharCode(65 + i) + ':\\'
      try { if (existsSync(drive)) drives.push(drive) } catch { /* ignore */ }
    }

    // 每个盘符下的常见安装根目录（含中英文目录名）
    const rootNames = [
      'Program Files\\KiCad',
      'Program Files (x86)\\KiCad',
      'Program Files\\KiCad EDA',
      'software',
      'software\\KiCad',
      'tools',
      'tools\\KiCad',
      'apps',
      'apps\\KiCad',
      'dev',
      'dev\\KiCad',
      'KiCad',
      // 中文目录名
      '软件',
      '软件\\KiCad',
      '工具',
      '工具\\KiCad',
      '应用',
      '应用\\KiCad',
      '程序',
      '程序\\KiCad',
      '开发',
      '开发\\KiCad',
    ]

    for (const drive of drives) {
      for (const name of rootNames) {
        const root = join(drive, name)
        const found = tryPath(root)
        if (found) return found

        // 遍历根目录下的子目录（版本号目录，如 10.0 / 9.0 / kicad10 / kicad-10.0 等）
        if (existsSync(root)) {
          try {
            const entries = readdirSync(root, { withFileTypes: true })
            for (const entry of entries) {
              if (!entry.isDirectory()) continue
              // 只查一层子目录
              const sub = join(root, entry.name)
              const found2 = tryPath(sub)
              if (found2) return found2
            }
          } catch { /* ignore read errors */ }
        }
      }
    }

    // 用户目录下的 portable 安装
    const userRoots = [
      join(homedir(), 'KiCad'),
      join(homedir(), 'AppData', 'Local', 'Programs', 'KiCad'),
      join(homedir(), 'AppData', 'Local', 'KiCad'),
      join(homedir(), 'scoop', 'apps', 'kicad'),
    ]
    for (const root of userRoots) {
      const found = tryPath(root)
      if (found) return found
      if (existsSync(root)) {
        try {
          const entries = readdirSync(root, { withFileTypes: true })
          for (const entry of entries) {
            if (!entry.isDirectory()) continue
            const found2 = tryPath(join(root, entry.name))
            if (found2) return found2
          }
        } catch { /* ignore */ }
      }
    }
  } else {
    // Unix 常见路径
    const candidates = [
      '/usr/bin/kicad-cli',
      '/usr/local/bin/kicad-cli',
      '/opt/kicad/bin/kicad-cli',
      '/opt/KiCad/bin/kicad-cli',
      '/snap/bin/kicad-cli',
      '/Applications/KiCad.app/Contents/MacOS/kicad-cli',
      join(homedir(), '.local', 'bin', 'kicad-cli'),
      join(homedir(), 'Applications', 'KiCad.app', 'Contents', 'MacOS', 'kicad-cli'),
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
  }
  return null
}

export class LocalExecutor implements DrcExecutor {
  private readonly explicitPath?: string
  /** 解析成功的 kicad-cli 路径缓存（懒解析；失败不缓存，下次重新探测）。 */
  private resolvedPath: string | null = null

  constructor(kicadCliPath?: string) {
    this.explicitPath = kicadCliPath
  }

  /** 解析 kicad-cli 路径。首次 run() 时才调用，避免本机没装 KiCad 就拖垮插件启动。 */
  private resolveCli(): string {
    if (this.resolvedPath) return this.resolvedPath
    const p = resolveKicadCli(this.explicitPath)
    this.resolvedPath = p
    return p
  }

  async run(options: DrcRunOptions): Promise<DrcRunResult> {
    const start = performance.now()
    const pcbPath = resolve(options.pcbPath)
    if (!existsSync(pcbPath)) {
      throw new ExecutorError(`PCB 文件不存在: ${pcbPath}`)
    }

    // 懒解析：真正调用工具时才探测 kicad-cli
    const kicadCliPath = this.resolveCli()

    // 创建临时工作目录（kicad-cli 的 --output 用相对路径时会写到 cwd）
    const workDir = mkdtempSync(join(tmpdir(), 'kicad-drc-'))
    const outputPath = join(workDir, 'drc.json')

    // 组装命令参数
    const args = [
      'pcb', 'drc',
      '--format', 'json',
      '--output', outputPath,
    ]
    if (options.severityAll !== false) args.push('--severity-all')
    if (options.refillZones !== false) args.push('--refill-zones')
    if (options.allTrackErrors) args.push('--all-track-errors')
    args.push(pcbPath)

    const timeoutMs = (options.timeoutSeconds ?? 600) * 1000

    try {
      const { exitCode, stdout, stderr, timedOut } = await execProcess(
        kicadCliPath, args, workDir, timeoutMs,
      )

      // 读取 drc.json
      let drcJson: string | null = null
      let drcJsonPath: string | null = null
      if (existsSync(outputPath)) {
        try {
          const raw = readFileSync(outputPath, 'utf-8')
          JSON.parse(raw) // 验证 JSON 合法
          drcJson = raw

          // 把 drc.json 持久化保存到 PCB 文件同目录（命名为 <pcb名>_drc.json）
          const pcbDir = dirname(pcbPath)
          const pcbStem = basename(pcbPath).replace(/\.kicad_pcb$/i, '')
          const persistentPath = join(pcbDir, `${pcbStem}_drc.json`)
          copyFileSync(outputPath, persistentPath)
          drcJsonPath = persistentPath
        } catch { /* ignore parse/copy errors */ }
      }

      const elapsedMs = Math.round(performance.now() - start)

      // 构造实际执行的命令行字符串（用于日志/输出展示）
      const command = [kicadCliPath, ...args].map(quoteIfNeeded).join(' ')

      return { exitCode, stdout, stderr, drcJson, elapsedMs, timedOut, kicadCliPath: kicadCliPath, command, drcJsonPath }
    } finally {
      // 清理临时目录
      try { rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}

/** 参数含空格或特殊字符时加引号（仅用于命令行展示）。 */
function quoteIfNeeded(arg: string): string {
  if (/[\s"]/.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`
  }
  return arg
}

/** 启动子进程并等待结束，超时强杀。 */
function execProcess(
  cmd: string, args: string[], cwd: string, timeoutMs: number,
): Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8') })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf-8') })

    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolvePromise({
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
      })
    })

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      resolvePromise({
        exitCode: -1,
        stdout,
        stderr: stderr + '\n' + err.message,
        timedOut,
      })
    })
  })
}

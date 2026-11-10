/**
 * PCBLint 本地组件的安装位置解析。
 *
 * 组件随 KiCad 安装包分发到 `bin\pcblint-local\`，与 `freerouting.exe` 同级：
 *
 * ```text
 * bin\pcblint-local\
 *   pcblint\pcblint.jar
 *   pcblint\version.txt   # 可选，安装包写入的版本号
 *   jre25\bin\java.exe
 * ```
 *
 * 解析顺序：插件配置 `pcblintHome` → 环境变量 `DSH_PCBLINT_HOME` →
 * kicad-cli 同级的 `pcblint-local`。只使用自带 JRE，不回退 `JAVA_HOME`/PATH：
 * 系统 Java 17/21 与组件要求的 25 混用会报错，现场很难定位。
 *
 * 本模块只做路径解析与存在性校验，不启动进程，也不创建目录。
 *
 * @module
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ExecutorError } from './executor.ts'

/** 安装目录覆盖点的环境变量名。 */
export const PCBLINT_HOME_ENV = 'DSH_PCBLINT_HOME'

/** 随 KiCad 分发的组件目录名。 */
export const PCBLINT_DIR_NAME = 'pcblint-local'

/** 组件内 JRE 的相对路径（Windows x64 安装包固定为 jre25）。 */
const JAVA_RELATIVE = join('jre25', 'bin', 'java.exe')

/** 组件内 jar 的相对路径。 */
const JAR_RELATIVE = join('pcblint', 'pcblint.jar')

/** 组件内版本文件的相对路径。 */
const VERSION_RELATIVE = join('pcblint', 'version.txt')

export interface PcblintInstallation {
  /** 组件根目录（`...\bin\pcblint-local`）。 */
  home: string
  /** 自带 JRE 的 java.exe 绝对路径。 */
  javaPath: string
  /** pcblint.jar 绝对路径。 */
  jarPath: string
  /** 安装包写入的版本号；没有该文件时为空。 */
  version?: string
}

export interface ResolvePcblintInstallationInput {
  /** 插件配置 `pcblintHome`，优先级最高。 */
  configuredHome?: string
  /** 已解析的 kicad-cli 路径，用于推导同级的 `pcblint-local`。 */
  kicadCliPath?: string
  /** 环境变量来源，便于单测。 */
  env?: NodeJS.ProcessEnv
}

/** 读取安装包写入的版本号；文件缺失或为空视为未知。 */
function readInstalledVersion(home: string): string | undefined {
  try {
    const text = readFileSync(join(home, VERSION_RELATIVE), 'utf-8').trim()
    return text || undefined
  } catch {
    return undefined
  }
}

/**
 * 校验一个已经确定的组件目录。
 *
 * 缺文件时一次性列出两个期望路径，避免用户改完一个又撞下一个。
 */
export function inspectPcblintHome(home: string): PcblintInstallation {
  const root = resolve(home)
  const javaPath = join(root, JAVA_RELATIVE)
  const jarPath = join(root, JAR_RELATIVE)
  const missing: string[] = []
  if (!existsSync(javaPath)) missing.push(`JRE: ${javaPath}`)
  if (!existsSync(jarPath)) missing.push(`jar: ${jarPath}`)
  if (missing.length > 0) {
    throw new ExecutorError(
      `PCBLint 本地组件不完整，缺少 ${missing.join('；')}。`
      + `请安装随 KiCad 分发的 PCBLint 组件（目录 ${root}），`
      + '或用 pcblintHome / DSH_PCBLINT_HOME 指向正确位置。',
    )
  }
  const version = readInstalledVersion(root)
  return { home: root, javaPath, jarPath, ...(version ? { version } : {}) }
}

/**
 * 按配置 → 环境变量 → kicad-cli 同级目录的顺序解析组件位置。
 *
 * `kicadCliPath` 由调用方惰性提供：定位 kicad-cli 可能触发全盘搜索，
 * 不能在插件加载的同步路径里调用。
 */
export function resolvePcblintInstallation(input: ResolvePcblintInstallationInput): PcblintInstallation {
  const env = input.env ?? process.env
  const configured = input.configuredHome?.trim()
  const fromEnv = env[PCBLINT_HOME_ENV]?.trim()
  const kicadCli = input.kicadCliPath?.trim()
  const besideKicad = kicadCli ? join(dirname(kicadCli), PCBLINT_DIR_NAME) : ''
  const home = configured || fromEnv || besideKicad
  if (!home) {
    throw new ExecutorError(
      '找不到 PCBLint 本地组件：没有配置 pcblintHome，也没有设置 DSH_PCBLINT_HOME，'
      + '且无法从 kicad-cli 安装目录推导。请确认 KiCad 安装包包含 bin\\pcblint-local\\，'
      + '或在插件配置里设置 pcblintHome。',
    )
  }
  return inspectPcblintHome(home)
}

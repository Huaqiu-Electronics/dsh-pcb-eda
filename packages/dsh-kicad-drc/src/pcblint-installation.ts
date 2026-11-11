/**
 * PCBLint 本地组件的安装位置解析。
 *
 * 组件来源有三种可能（优先级从高到低）：
 *   1. 插件配置 `pcblintHome`（用户显式指定）
 *   2. 环境变量 `DSH_PCBLINT_HOME`
 *   3. 下载缓存（插件自下载的组件，位于 `cacheRoot/pcblint-local/`）
 *   4. kicad-cli 同级的 `pcblint-local`（随 KiCad 安装包分发）
 *
 * 每个来源都使用同一套目录结构：
 *
 * ```text
 * pcblint-local\
 *   pcblint\pcblint.jar
 *   pcblint\version.txt   # 可选
 *   jre25\bin\java.exe
 * ```
 *
 * 只使用自带 JRE，不回退 `JAVA_HOME`/PATH：系统 Java 17/21 与组件要求
 * 的 25 混用会报错，现场很难定位。
 *
 * 本模块只做路径解析与存在性校验，不启动进程，也不创建目录。
 * 下载逻辑由 `pcblint-downloader.ts` 负责，找到 null 时触发。
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
  /** 来源：用于诊断。 */
  source: 'config' | 'env' | 'cache' | 'kicad-cli'
}

export interface FindPcblintInstallationInput {
  /** 插件配置 `pcblintHome`，优先级最高。 */
  configuredHome?: string
  /** 下载缓存根目录（检查 `<cacheRoot>/pcblint-local`）。 */
  cacheRoot?: string
  /** 已解析的 kicad-cli 路径，用于推导同级的 `pcblint-local`。 */
  kicadCliPath?: string
  /** 环境变量来源，便于单测。 */
  env?: NodeJS.ProcessEnv
}

/** 旧接口兼容（不传入 cacheRoot）。 */
export interface ResolvePcblintInstallationInput extends FindPcblintInstallationInput {}

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
export function inspectPcblintHome(
  home: string,
  source: PcblintInstallation['source'] = 'kicad-cli',
): PcblintInstallation {
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
  return { home: root, javaPath, jarPath, source, ...(version ? { version } : {}) }
}

/**
 * 按配置 → 环境变量 → 下载缓存 → kicad-cli 同级目录的顺序查找已安装组件。
 *
 * 找不到时返回 null（不抛错），供调用方决定是否触发下载。
 * 每一级只在路径存在时才尝试 `inspectPcblintHome`，避免误抛。
 */
export function findPcblintInstallation(
  input: FindPcblintInstallationInput,
): PcblintInstallation | null {
  const env = input.env ?? process.env
  const configured = input.configuredHome?.trim()
  const fromEnv = env[PCBLINT_HOME_ENV]?.trim()
  const cacheRoot = input.cacheRoot?.trim()
  const kicadCli = input.kicadCliPath?.trim()

  // 1. 显式配置
  if (configured) {
    return inspectPcblintHome(configured, 'config')
  }
  // 2. 环境变量
  if (fromEnv) {
    return inspectPcblintHome(fromEnv, 'env')
  }
  // 3. 下载缓存
  if (cacheRoot) {
    const cached = join(cacheRoot, PCBLINT_DIR_NAME)
    if (existsSync(cached)) {
      try {
        return inspectPcblintHome(cached, 'cache')
      } catch {
        // 缓存目录可能不完整，继续往下找
      }
    }
  }
  // 4. kicad-cli 同级
  if (kicadCli) {
    const besideKicad = join(dirname(kicadCli), PCBLINT_DIR_NAME)
    if (existsSync(besideKicad)) {
      try {
        return inspectPcblintHome(besideKicad, 'kicad-cli')
      } catch {
        // 同级目录不完整
      }
    }
  }
  return null
}

/**
 * 旧接口：找不到时抛 ExecutorError（带友好的安装指引）。
 *
 * 内部委托 `findPcblintInstallation`，保持兼容。新代码应优先用
 * `findPcblintInstallation`，找不到时再决定是否触发下载。
 */
export function resolvePcblintInstallation(
  input: ResolvePcblintInstallationInput,
): PcblintInstallation {
  const found = findPcblintInstallation(input)
  if (found) return found
  throw new ExecutorError(
    '找不到 PCBLint 本地组件：没有配置 pcblintHome，也没有设置 DSH_PCBLINT_HOME，'
    + '下载缓存里也没有，且无法从 kicad-cli 安装目录推导。'
    + '请安装随 KiCad 分发的 PCBLint 组件（bin\\pcblint-local\\），'
    + '或在插件配置里设置 pcblintHome。',
  )
}

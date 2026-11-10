/**
 * 插件级配置解析：只放纯函数，便于单测，不依赖 Cordis 或 DSH 服务。
 *
 * 目前包含 kicad-ipc 后端的 Python 解释器解析，以及 PCBLint 托管服务的
 * 运行时数据目录。之所以单独给 DRC 插件一个解释器配置项（而不是复用
 * `@huaqiu/dsh-kicad` 的 `DSH_KICAD_PYTHON`）：两个插件可以装在不同机器上、
 * 对着不同的 KiCad 版本，共用一份解释器配置会让"DRC 插件单独部署"变得不可能。
 *
 * @module
 */
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** kicad-ipc 后端 Python 解释器的环境变量覆盖点。 */
export const IPC_PYTHON_ENV = 'DSH_KICAD_DRC_PYTHON'

/** 持久数据根的环境变量覆盖点（与仓库其它插件一致）。 */
export const HQ_EDGE_HOME_ENV = 'HQ_EDGE_HOME'

/**
 * 解析 kicad-ipc 后端要用的 Python 解释器。
 *
 * 优先级：插件配置 `ipcPythonPath` → 环境变量 `DSH_KICAD_DRC_PYTHON` → `python3`。
 * 该解释器需要装有官方 `kicad-python`（`import kipy`）。
 */
export function resolveIpcPython(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromConfig = configured?.trim()
  if (fromConfig) return fromConfig
  const fromEnv = env[IPC_PYTHON_ENV]?.trim()
  if (fromEnv) return fromEnv
  return 'python3'
}

/**
 * PCBLint 托管服务的运行时数据根（H2、日志、预览产物）。
 *
 * 必须放在用户可写目录：随 KiCad 安装的组件位于 `Program Files`，
 * 普通用户没有写权限，H2 建库会直接失败。
 *
 * 按仓库约定使用 `HQ_EDGE_HOME`（绝对路径）或 `~/.hq-edge`，再按插件与用途分目录；
 * 与 FreeRouting 的临时 `--user_data_path` 不同，这里的 H2 库需要跨任务保留。
 */
export function resolvePcblintDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HQ_EDGE_HOME_ENV]?.trim()
  const root = override && isAbsolute(override) ? override : join(homedir(), '.hq-edge')
  return join(root, 'plugin-data', 'dsh-kicad-drc', 'pcblint')
}

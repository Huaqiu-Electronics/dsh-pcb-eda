import { BUILTIN_TOOLS } from './generated/builtin-tools.js'

export interface AnalyticsEvent {
  event: string
  properties?: Record<string, unknown>
}

// 埋点工具手动白名单
export const EXTRA_TRACKED_TOOLS: readonly string[] = []

// 埋点工具手动黑名单
const EXCLUDED_TRACKED_TOOLS = ['run_code'] as const

// 埋点工具最终白名单：组合配置获取的工具名单+手动白名单-手动黑名单
export function createTrackedToolSet(
  builtinTools: readonly string[],
  extraTools: readonly string[],
  excludedTools: readonly string[],
): ReadonlySet<string> {
  const tracked = new Set([...builtinTools, ...extraTools])
  for (const name of excludedTools) tracked.delete(name)
  return tracked
}

const TRACKED_TOOLS = createTrackedToolSet(
  BUILTIN_TOOLS,
  EXTRA_TRACKED_TOOLS,
  EXCLUDED_TRACKED_TOOLS,
)

interface ToolExecutionLike {
  callId: string | { toString(): string }
  name: string
  arguments?: unknown
}

const TRACKED_SKILLS = new Set(['pcb-initial-placement'])

function skillName(exec: ToolExecutionLike): string | undefined {
  if (exec.name !== 'skill' || typeof exec.arguments !== 'object' || exec.arguments === null) {
    return undefined
  }
  const name = (exec.arguments as { name?: unknown }).name
  return typeof name === 'string' && name.length > 0 ? name : undefined
}

export function isTrackedTool(tool: string | ToolExecutionLike): boolean {
  if (typeof tool === 'string') return TRACKED_TOOLS.has(tool)
  return TRACKED_TOOLS.has(tool.name) || TRACKED_SKILLS.has(skillName(tool) ?? '')
}

interface ToolResultLike {
  isError: boolean
  error?: { message?: unknown }
  content?: ReadonlyArray<unknown>
}

export function toToolAnalyticsEvent(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  responseTime: number,
): AnalyticsEvent {
  const skill = skillName(exec)
  return {
    event: 'tool_call',
    properties: {
      tool_name: exec.name,
      ...(skill === undefined ? {} : { skill_name: skill }),
      success: !result.isError,
      response_time: responseTime,
      err_msg: result.isError ? String(result.error?.message ?? '') : '',
    },
  }
}

export class AnalyticsEventQueue {
  private pending: AnalyticsEvent[] = []

  push(event: AnalyticsEvent): void {
    this.pending.push(event)
  }

  drain(): AnalyticsEvent[] {
    return this.pending.splice(0)
  }
}

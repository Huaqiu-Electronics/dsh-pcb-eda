export interface AnalyticsEvent {
  event: string
  properties?: Record<string, unknown>
}

// 埋点工具白名单
const TRACKED_TOOLS = new Set([
  'generate_symbol_from_image',
  'generate_footprint_from_image',
  'generate_footprint_from_dimensions',
  'generate_schematic_from_description',
  'generate_system_module_graph',
  'search_hqsch_parts',
  'get_hqsch_part',
  'get_hqsch_part_models',
  'get_hqsch_supply_chain',
  'pcb_preview',
  'get_project_netlist',
  'get_selection_netlist',
  'get_active_page_netlist',
  'get_eda_host_info',
  'get_pcb_selection',
  'get_eda_host_capabilities',
  'kicad_ipc_diagnose',
  'kicad_ipc_verify_live',
  'kicad_pcb_create_track',
  'kicad_pcb_create_via',
  'kicad_pcb_create_copper_zone',
  'kicad_pcb_add_footprint_from_template',
  'kicad_pcb_move_rotate_footprint',
  'kicad_pcb_update_selected_track_width',
  'kicad_pcb_refill_zones',
  'kicad_pcb_remove_selected_items',
])

export function isTrackedTool(name: string): boolean {
  return TRACKED_TOOLS.has(name)
}

interface ToolExecutionLike {
  callId: string | { toString(): string }
  name: string
  arguments?: unknown
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
  return {
    event: 'tool_call',
    properties: {
      tool_name: exec.name,
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

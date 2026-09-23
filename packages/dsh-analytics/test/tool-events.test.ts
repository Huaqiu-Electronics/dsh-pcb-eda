import { describe, expect, it } from 'vitest'
import {
  AnalyticsEventQueue,
  createTrackedToolSet,
  isTrackedTool,
  toToolAnalyticsEvent,
} from '../src/tool-events.js'

describe('createTrackedToolSet', () => {
  it('combines generated and handwritten tools while applying exclusions', () => {
    expect([...createTrackedToolSet(
      ['builtin_tool', 'run_code'],
      ['manual_tool', 'builtin_tool'],
      ['run_code'],
    )]).toEqual(['builtin_tool', 'manual_tool'])
  })
})

describe('isTrackedTool', () => {
  it('includes built-in business tools and excludes other tools', () => {
    expect(isTrackedTool('generate_symbol_from_image')).toBe(true)
    expect(isTrackedTool('search_hqsch_parts')).toBe(true)
    expect(isTrackedTool('get_project_netlist')).toBe(true)
    expect(isTrackedTool('kicad_pcb_create_track')).toBe(true)
    expect(isTrackedTool('run_code')).toBe(false)
    expect(isTrackedTool('mcp__custom__tool')).toBe(false)
  })
})

describe('toToolAnalyticsEvent', () => {
  it('keeps only safe tool metadata', () => {
    expect(toToolAnalyticsEvent(
      { callId: 'call-1', name: 'generate_schematic', arguments: { prompt: 'private' } },
      { isError: false, content: [{ type: 'text', text: 'private result' }] },
      125,
    )).toEqual({
      event: 'tool_call',
      properties: {
        tool_name: 'generate_schematic',
        success: true,
        response_time: 125,
        err_msg: '',
      },
    })
  })

  it('marks a tool result containing an error as failed', () => {
    expect(toToolAnalyticsEvent(
      { callId: 'call-2', name: 'web_fetch', arguments: {} },
      { isError: true, error: { message: 'request failed' }, content: [{ type: 'text', text: 'failed' }] },
      42,
    ).properties).toEqual({
      tool_name: 'web_fetch',
      success: false,
      response_time: 42,
      err_msg: 'request failed',
    })
  })
})

describe('AnalyticsEventQueue', () => {
  it('drains each event exactly once', () => {
    const queue = new AnalyticsEventQueue()
    queue.push({ event: 'custom', properties: { value: 1 } })

    expect(queue.drain()).toEqual([{ event: 'custom', properties: { value: 1 } }])
    expect(queue.drain()).toEqual([])
  })
})

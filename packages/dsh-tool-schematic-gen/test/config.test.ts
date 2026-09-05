import { describe, expect, it } from 'vitest'
import {
  agentIds,
  buildHeaders,
  buildRunBody,
  DEFAULT_AGENT_LANGUAGE,
  DEFAULT_COPILOTKIT_URL,
  resolveConfig,
  sanitizeZipBaseName,
} from '../src/config.js'

const ACCOUNT = { userId: 'u1', userToken: 'tok-1' }

describe('resolveConfig', () => {
  it('defaults to the production endpoints with no credential defaults', () => {
    const c = resolveConfig({})
    expect(c.copilotkitUrl).toBe(DEFAULT_COPILOTKIT_URL)
    expect(c.exportZipUrl).toBe('https://gen.eda.cn/api/modular_circuit/export-zip')
    expect(c.cookie).toBeNull()
    // No baked-in credential keys anywhere.
    expect('userId' in c).toBe(false)
    expect('userToken' in c).toBe(false)
  })

  it('honours env overrides', () => {
    const c = resolveConfig({ HQ_EDA_COPILOTKIT_URL: 'https://stg.example/api/copilotkit', HQ_EDA_COOKIE: 'a=1' })
    expect(c.copilotkitUrl).toBe('https://stg.example/api/copilotkit')
    expect(c.cookie).toBe('a=1')
  })

  it('lets a deployment override the agent-language default', () => {
    // `buildRunBody` used to inline a bare '简体中文' literal here, which pinned
    // every agent reply to Chinese even under an English UI. The node half
    // cannot read the host UI locale (the model invokes the tool, not the
    // browser), so the fallback is deployment config instead.
    expect(resolveConfig({}).defaultLanguage).toBe(DEFAULT_AGENT_LANGUAGE)
    expect(resolveConfig({ HQ_EDA_DEFAULT_LANGUAGE: 'English' }).defaultLanguage).toBe('English')
  })
})

describe('buildHeaders', () => {
  it('carries the account as x-user-id/x-user-token plus a fresh thread id', () => {
    const config = resolveConfig({})
    const h = buildHeaders(config, ACCOUNT, 'thr-1')
    expect(h['x-user-id']).toBe('u1')
    expect(h['x-user-token']).toBe('tok-1')
    expect(h['x-thread-id']).toBe('thr-1')
    expect(h.accept).toBe('text/event-stream')
  })
})

describe('buildRunBody', () => {
  it('builds a one-shot agent/run body with a fresh thread/run id', () => {
    const config = resolveConfig({})
    const body = buildRunBody(agentIds.SCHEMATIC, 'design a 5V supply', config, ACCOUNT, 'English', 'thr-fixed')
    expect(body.method).toBe('agent/run')
    expect((body.params as { agentId: string }).agentId).toBe('schemagen')
    const inner = body.body as Record<string, unknown>
    expect(inner.threadId).toBe('thr-fixed')
    expect(inner.runId).toBeTypeOf('string')
    expect(inner.messages).toHaveLength(1)
    expect((inner.state as Record<string, unknown>).user_id).toBe('u1')
    expect((inner.state as Record<string, unknown>).token).toBe('tok-1')
  })

  it('uses the system empty state for the modular_circuit agent', () => {
    const config = resolveConfig({})
    const body = buildRunBody(agentIds.SYSTEM, 'an alarm clock', config, ACCOUNT, undefined, 'thr-2')
    const state = (body.body as Record<string, unknown>).state as Record<string, unknown>
    expect(state.module_graph).toBeNull()
    expect(state.user_language).toBe('简体中文')
    expect(state.design_name).toBeNull()
  })

  it('falls back to config.defaultLanguage rather than a hardcoded literal', () => {
    const config = resolveConfig({ HQ_EDA_DEFAULT_LANGUAGE: 'English' })
    const body = buildRunBody(agentIds.SYSTEM, 'an alarm clock', config, ACCOUNT, undefined, 'thr-3')
    const state = (body.body as Record<string, unknown>).state as Record<string, unknown>
    expect(state.user_language).toBe('English')
  })

  it('still prefers an explicit language over the configured default', () => {
    const config = resolveConfig({ HQ_EDA_DEFAULT_LANGUAGE: 'English' })
    const body = buildRunBody(agentIds.SYSTEM, 'an alarm clock', config, ACCOUNT, '日本語', 'thr-4')
    const state = (body.body as Record<string, unknown>).state as Record<string, unknown>
    expect(state.user_language).toBe('日本語')
  })
})

describe('sanitizeZipBaseName', () => {
  it('keeps CJK intact while scrubbing illegal characters', () => {
    expect(sanitizeZipBaseName('STM32F103C8T6迷你开发板')).toBe('STM32F103C8T6迷你开发板')
    expect(sanitizeZipBaseName('a/b:c*d')).toBe('a_b_c_d')
    expect(sanitizeZipBaseName('  spaced   out  ')).toBe('spaced_out')
    expect(sanitizeZipBaseName('')).toBe('circuit')
    expect(sanitizeZipBaseName('x'.repeat(200)).length).toBe(60)
  })

  it('does not split unicode code points at the filename limit', () => {
    const name = sanitizeZipBaseName(`${'x'.repeat(59)}😀tail`)

    expect(name).toBe(`${'x'.repeat(59)}😀`)
    expect(Array.from(name)).toHaveLength(60)
  })
})

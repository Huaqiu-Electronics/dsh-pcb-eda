/**
 * The shared toolchain controller: what each surface is allowed to conclude.
 *
 * These tests use a transport instead of HTTP, so they pin the *policy* — when a
 * green pill is legal, which transitions notify, and when a draft may be
 * overwritten — rather than the route shapes (those live in the Host package).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ToolchainController, jobPercent, jobRunning, setupComplete, setupIncomplete, setupSummary,
  type InstallJob, type ToolchainStatus, type ToolchainTransport,
} from '../src/client/toolchain.js'
import { statusPill, discoveryLine } from '../src/client/toolchain-view.js'

/** One tool row, configured or not. */
function tool(
  id: 'kicad' | 'solidcraft',
  state: 'configured' | 'unconfigured' | 'invalid' | 'validating',
  extra: Partial<ToolchainStatus['kicad']> = {},
): ToolchainStatus['kicad'] {
  return {
    tool: id,
    state,
    discovery: { tool: id, state: 'done', candidates: [] },
    ...extra,
  }
}

function status(overrides: {
  kicad?: ToolchainStatus['kicad']
  solidcraft?: ToolchainStatus['solidcraft']
  job?: InstallJob
  jobs?: readonly InstallJob[]
} = {}): ToolchainStatus {
  const jobs = overrides.jobs ?? (overrides.job === undefined ? [] : [overrides.job])
  return {
    kicad: overrides.kicad ?? tool('kicad', 'configured', { version: '10.0.7', installPath: '/opt/kicad' }),
    solidcraft: overrides.solidcraft ?? tool('solidcraft', 'configured', { version: '0.49.1', installPath: '/opt/sc' }),
    manifest: { state: 'ready', schemaVersion: 1, url: 'https://example.test/manifest.json' },
    target: { platform: 'win32', arch: 'x64', downloadsSupported: true },
    official: { kicad: 'https://www.kicad.org/download/', solidcraft: 'https://example.test/sc' },
    ...(jobs.length === 0 ? {} : { job: jobs[0], jobs }),
  }
}

function job(phase: InstallJob['phase'], extra: Partial<InstallJob> = {}): InstallJob {
  return {
    id: 'job-1', tool: 'kicad', version: '10.0.7-2', phase,
    received: 10, total: 100, percent: 10, message: `${phase}…`, startedAt: 1,
    ...extra,
  }
}

/** A transport that answers from a script, and records what was asked. */
function fakeTransport(script: {
  status?: ToolchainStatus | (() => ToolchainStatus)
  save?: (tool: string, path: string) => { ok: boolean; error?: string; version?: string }
} = {}): ToolchainTransport & { readonly calls: string[] } {
  const calls: string[] = []
  const answer = (): ToolchainStatus => (typeof script.status === 'function' ? script.status() : script.status ?? status())
  return {
    calls,
    status: async ids => { calls.push(ids === undefined || ids.length === 0 ? 'status' : `status:${ids.join('|')}`); return answer() },
    validate: async (_tool, path) => { calls.push(`validate:${path}`); return { ok: true } },
    save: async (tool, path) => {
      calls.push(`save:${tool}:${path}`)
      return script.save?.(tool, path) ?? { ok: true, version: '10.0.7', installPath: path }
    },
    browse: async () => { calls.push('browse'); return { kind: 'picked', path: '/picked/kicad' } },
    install: async () => { calls.push('install'); return job('download') },
    cancel: async id => { calls.push(`cancel:${id}`); return true },
    discover: async () => { calls.push('discover') },
  }
}

describe('toolchain status projections', () => {
  it('never paints green before a validation succeeded', () => {
    expect(statusPill(tool('kicad', 'unconfigured'), undefined).tone).toBe('warn')
    expect(statusPill(tool('kicad', 'invalid', { error: 'no executable' }), undefined).tone).toBe('accent')
    expect(statusPill(tool('kicad', 'validating'), undefined).tone).toBe('muted')
    expect(statusPill(tool('kicad', 'configured', { version: '10.0.7' }), undefined))
      .toEqual({ text: 'v10.0.7', tone: 'ok' })
  })

  it('reports progress instead of the version while a job runs', () => {
    expect(statusPill(tool('kicad', 'configured', { version: '10.0.7' }), job('download', { percent: 42 })))
      .toMatchObject({ tone: 'info' })
    expect(statusPill(tool('kicad', 'configured'), job('extract')).text).toBe('解压中')
  })

  it('only claims a failure for the tool the failed job belonged to', () => {
    expect(statusPill(tool('solidcraft', 'unconfigured'), job('failed', { tool: 'kicad' })).tone).toBe('warn')
  })

  it('turns discovery into one line, and never into a configured claim', () => {
    const found = tool('kicad', 'unconfigured', {
      discovery: {
        tool: 'kicad', state: 'done', candidates: [],
        selected: { path: '/Program Files/KiCad/8.0', origin: 'system', valid: true, version: '8.0.0' },
      },
    })
    expect(discoveryLine(found)).toMatchObject({ tone: 'ok' })
    expect(discoveryLine(tool('kicad', 'unconfigured'))).toBeUndefined()
    expect(discoveryLine(tool('kicad', 'unconfigured', { discovery: { tool: 'kicad', state: 'running', candidates: [] } })))
      .toMatchObject({ tone: 'muted' })
  })

  it('summarises both tools for the sidebar tooltip', () => {
    expect(setupComplete(status())).toBe(true)
    expect(setupIncomplete(status())).toBe(false)
    expect(setupComplete(status({ solidcraft: tool('solidcraft', 'unconfigured') }))).toBe(false)
    expect(setupSummary(status({ solidcraft: tool('solidcraft', 'unconfigured') })))
      .toContain('SolidCraft')
  })

  it('derives percent from bytes when the host has no estimate', () => {
    expect(jobPercent(job('download', { percent: undefined, received: 25, total: 100 }))).toBe(25)
    expect(jobPercent(job('download', { percent: undefined, total: undefined }))).toBeUndefined()
    expect(jobRunning(job('download'))).toBe(true)
    expect(jobRunning(job('done'))).toBe(false)
  })
})

describe('toolchain controller', () => {
  let controller: ToolchainController

  beforeEach(() => {
    controller = new ToolchainController(fakeTransport(), 1_000_000)
  })

  it('boots once: one status read and one background discovery', async () => {
    const transport = fakeTransport()
    const booted = new ToolchainController(transport, 1_000_000)
    booted.start()
    booted.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.calls.filter(call => call === 'discover')).toHaveLength(1)
    expect(transport.calls.filter(call => call === 'status')).toHaveLength(1)
    booted.stop()
  })

  it('keeps text the user is typing when a poll answers an empty root', async () => {
    const transport = fakeTransport({ status: status({ kicad: tool('kicad', 'unconfigured') }) })
    controller = new ToolchainController(transport, 1_000_000)
    await controller.refresh()
    controller.setDraft('kicad', 'D:/typing/kicad')
    await controller.refresh()
    expect(controller.getSnapshot().drafts.kicad).toBe('D:/typing/kicad')
  })

  it('moves the input when the authoritative root changes', async () => {
    let current = status({ kicad: tool('kicad', 'configured', { installPath: '/a' }) })
    controller = new ToolchainController(fakeTransport({ status: () => current }), 1_000_000)
    await controller.refresh()
    expect(controller.getSnapshot().drafts.kicad).toBe('/a')
    current = status({ kicad: tool('kicad', 'configured', { installPath: '/b' }) })
    await controller.refresh()
    expect(controller.getSnapshot().drafts.kicad).toBe('/b')
  })

  it('notifies only on the transitions §11 allows, and never twice', async () => {
    let current = status({ job: job('download') })
    const transport = fakeTransport({ status: () => current })
    transport.install = async () => { transport.calls.push('install'); return job('download') }
    controller = new ToolchainController(transport, 1_000_000)
    await controller.refresh(['job-1'])
    current = status({ job: job('verify') })
    await controller.refresh(['job-1'])
    const afterVerify = controller.getSnapshot().toasts.map(item => item.text)
    expect(afterVerify.some(text => text.includes('下载完成'))).toBe(true)
    // A repeat of the same phase is not news.
    await controller.refresh(['job-1'])
    expect(controller.getSnapshot().toasts.map(item => item.text)).toEqual(afterVerify)
    current = status({ job: job('done', { percent: undefined, received: 100 }) })
    await controller.refresh(['job-1'])
    expect(controller.getSnapshot().toasts.some(item => item.text.includes('已安装'))).toBe(true)
  })

  it('reports a checksum failure in its own words', async () => {
    let current = status({ job: job('download') })
    controller = new ToolchainController(fakeTransport({ status: () => current }), 1_000_000)
    await controller.refresh(['job-1'])
    current = status({ job: job('failed', { errorCode: 'checksum-mismatch', error: 'sha256 mismatch' }) })
    await controller.refresh(['job-1'])
    expect(controller.getSnapshot().toasts.at(-1)?.text).toContain('校验值不匹配')
  })

  it('a save that validates notifies green and refreshes the host status', async () => {
    const transport = fakeTransport()
    controller = new ToolchainController(transport, 1_000_000)
    const outcome = await controller.save('kicad', '/opt/kicad')
    expect(outcome.ok).toBe(true)
    expect(transport.calls).toContain('save:kicad:/opt/kicad')
    expect(transport.calls.filter(call => call === 'status').length).toBeGreaterThanOrEqual(1)
    expect(controller.getSnapshot().toasts.at(-1)?.tone).toBe('ok')
    expect(controller.getSnapshot().saving).toBeUndefined()
  })

  it('a save the host rejects keeps the user where they are', async () => {
    controller = new ToolchainController(
      fakeTransport({ save: () => ({ ok: false, error: 'kicad-cli not found' }) }),
      1_000_000,
    )
    const outcome = await controller.save('kicad', '/nope')
    expect(outcome.ok).toBe(false)
    expect(controller.getSnapshot().toasts.at(-1)?.tone).toBe('warn')
    expect(controller.getSnapshot().saving).toBeUndefined()
  })

  it('an install the host cannot offer degrades to a warning, not an error', async () => {
    const transport = fakeTransport()
    transport.install = async () => undefined
    controller = new ToolchainController(transport, 1_000_000)
    await controller.install('kicad')
    expect(controller.getSnapshot().toasts.at(-1)).toMatchObject({ tone: 'warn' })
  })

  it('keeps both bars alive when both tools download at the same time', async () => {
    // The reported bug: start SolidCraft while KiCad is at 16% and KiCad's bar
    // vanished, because the client mirrored a single "current job" id.
    const kicadJob = job('download', { id: 'job-kicad', tool: 'kicad', percent: 16 })
    const craftJob = job('download', { id: 'job-craft', tool: 'solidcraft', percent: 90, version: '0.49.1' })
    const transport = fakeTransport()
    transport.install = async tool => {
      transport.calls.push(`install:${tool}`)
      return tool === 'kicad' ? kicadJob : craftJob
    }
    controller = new ToolchainController(transport, 1_000_000)

    await controller.install('kicad')
    transport.calls.length = 0
    // The Host now answers about both runs in one poll; before the fix only the
    // second id survived, so one card had no job to draw.
    transport.status = async ids => {
      transport.calls.push(`status:${(ids ?? []).join('|')}`)
      return status({ jobs: [kicadJob, craftJob] })
    }
    await controller.install('solidcraft')

    const snapshot = controller.getSnapshot()
    expect(snapshot.jobs.kicad).toMatchObject({ id: 'job-kicad', percent: 16 })
    expect(snapshot.jobs.solidcraft).toMatchObject({ id: 'job-craft', percent: 90 })
    expect(transport.calls).toContain('status:job-kicad|job-craft')
  })

  it('notifies once per phase per tool, so two runs do not mute each other', async () => {
    let current = status({ jobs: [job('download', { id: 'job-kicad', tool: 'kicad' })] })
    const transport = fakeTransport({ status: () => current })
    controller = new ToolchainController(transport, 1_000_000)
    await controller.refresh(['job-kicad'])
    current = status({
      jobs: [
        job('verify', { id: 'job-kicad', tool: 'kicad' }),
        job('download', { id: 'job-craft', tool: 'solidcraft' }),
      ],
    })
    await controller.refresh(['job-kicad', 'job-craft'])
    current = status({
      jobs: [
        job('verify', { id: 'job-kicad', tool: 'kicad' }),
        job('verify', { id: 'job-craft', tool: 'solidcraft' }),
      ],
    })
    await controller.refresh(['job-kicad', 'job-craft'])
    // Both tools reached `verify`, so both get their own "download done" notice.
    expect(controller.getSnapshot().toasts.filter(item => item.text.includes('下载完成'))).toHaveLength(2)
  })

  it('a picked path lands in the draft, never in the configuration', async () => {
    const transport = fakeTransport()
    controller = new ToolchainController(transport, 1_000_000)
    await controller.browse('kicad')
    expect(controller.getSnapshot().drafts.kicad).toBe('/picked/kicad')
    expect(transport.calls).not.toContain('save:kicad:/picked/kicad')
  })

  it('an unsupported chooser says so instead of failing silently', async () => {
    const transport = fakeTransport()
    transport.browse = async () => ({ kind: 'unsupported', message: 'no zenity' })
    controller = new ToolchainController(transport, 1_000_000)
    expect(await controller.browse('kicad')).toBeUndefined()
    expect(controller.getSnapshot().toasts.at(-1)?.tone).toBe('warn')
  })

  it('the picker lists what discovery found and takes the chosen row into the draft', async () => {
    const candidate = {
      path: 'C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe',
      origin: 'system' as const, valid: true, version: '10.0.7',
    }
    const transport = fakeTransport({
      status: status({
        kicad: tool('kicad', 'unconfigured', {
          discovery: { tool: 'kicad', state: 'done', candidates: [candidate] },
        }),
      }),
    })
    controller = new ToolchainController(transport, 1_000_000)
    await controller.refresh()
    controller.openPicker('kicad')
    expect(controller.getSnapshot().picker?.tool).toBe('kicad')
    expect(controller.getSnapshot().picker?.chosen).toBeUndefined()
    expect(controller.getSnapshot().picker?.candidates).toHaveLength(1)

    controller.choosePick(candidate.path)
    expect(controller.getSnapshot().picker?.chosen).toBe(candidate.path)

    controller.confirmPick()
    expect(controller.getSnapshot().picker).toBeUndefined()
    expect(controller.getSnapshot().drafts.kicad).toBe(candidate.path)
    expect(transport.calls).not.toContain(`save:kicad:${candidate.path}`)
  })

  it('the picker closes without touching the draft when nothing was chosen', () => {
    controller.openPicker('solidcraft')
    controller.confirmPick()
    expect(controller.getSnapshot().drafts.solidcraft).toBe('')
    controller.closePicker()
    expect(controller.getSnapshot().picker).toBeUndefined()
  })

  it('the native link hands the choice to the OS dialog and closes on a pick', async () => {
    controller.openPicker('kicad')
    await controller.nativePick()
    expect(controller.getSnapshot().picker).toBeUndefined()
    expect(controller.getSnapshot().drafts.kicad).toBe('/picked/kicad')
  })

  it('a cancelled OS dialog leaves the picker open, not stuck', async () => {
    const transport = fakeTransport()
    transport.browse = async () => ({ kind: 'cancelled' })
    controller = new ToolchainController(transport, 1_000_000)
    controller.openPicker('kicad')
    await controller.nativePick()
    expect(controller.getSnapshot().picker).toMatchObject({ tool: 'kicad', nativePending: false })
  })

  it('dismissing a toast removes it and is idempotent', async () => {
    controller.toast('info', 'one')
    const id = controller.getSnapshot().toasts[0]?.id ?? 0
    controller.dismiss(id)
    expect(controller.getSnapshot().toasts).toHaveLength(0)
    controller.dismiss(id)
    expect(controller.getSnapshot().toasts).toHaveLength(0)
  })

  it('caps the stack so a noisy host cannot flood the overlay', () => {
    for (let index = 0; index < 6; index += 1) controller.toast('info', `notice ${index}`)
    expect(controller.getSnapshot().toasts).toHaveLength(3)
  })

  it('cancel asks the host and re-reads the status', async () => {
    const transport = fakeTransport()
    controller = new ToolchainController(transport, 1_000_000)
    await controller.cancel('job-1')
    expect(transport.calls).toContain('cancel:job-1')
    expect(transport.calls.filter(call => call === 'status')).toHaveLength(1)
  })

  it('stop() detaches listeners so an unloaded plugin cannot notify', () => {
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.stop()
    controller.toast('info', 'after stop')
    expect(listener).not.toHaveBeenCalled()
  })
})

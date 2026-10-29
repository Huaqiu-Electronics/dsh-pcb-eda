// @vitest-environment jsdom
/**
 * DOM tests for the HQ Edge runtime facts block in the update review panel.
 *
 * Regression guard for the "[object Object]" latest-version row: hq-edge sends
 * `runtime.latest` as a full release ENTRY (`{ version, sha256, platform, … }`),
 * not a bare string. The client type once claimed `string`, and rendering the
 * entry straight into a text node stringified it. The row must name a version.
 *
 * The second half covers the configurable update source: the panel must show
 * the manifest URL in effect with its origin, edit it through the forwarder,
 * re-run discovery after a save, and offer 恢复默认 only while a user
 * override shadows the configured URL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeLatestVersion, type PluginUpdateItem, type PluginUpdateReport, type UpdateJob, type UpdatePhase, type UpdateStep } from '../src/client/api.js'
import { COPY } from '../src/client/copy.js'
import { openUpdateView, type UpdateStoreLike } from '../src/client/update-view.js'
import { normalizePluginUpdateReport } from '../src/client/version.js'

// The view calls the API directly, so stub the calls it makes. Everything
// else (facts rows, install bar) is exercised for real.
const { requestRuntimeUpdate, setRuntimeUpdateSource, setPluginUpdateSource, checkUpdates } = vi.hoisted(
  () => ({
    requestRuntimeUpdate: vi.fn(async (_v: string) => ({
      requestId: 'req-1',
      targetVersion: '0.2.12',
      state: 'accepted',
    })),
    setRuntimeUpdateSource: vi.fn(async (url: string) => ({
      url,
      origin: url.length > 0 ? ('override' as const) : ('config' as const),
      configuredUrl: 'https://example.invalid/edge-headless-manifest.json',
      override: url.length > 0,
    })),
    setPluginUpdateSource: vi.fn(async (url: string) => ({
      url,
      origin: url.length > 0 ? ('override' as const) : ('config' as const),
      configuredUrl: 'https://gitee.com/huaqiu-electronics/dsh-pcb-eda/raw/main/plugins-release-manifest.json',
      override: url.length > 0,
    })),
    checkUpdates: vi.fn(async () => ({})),
  }),
)
vi.mock('../src/client/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.js')>()
  return { ...actual, requestRuntimeUpdate, setRuntimeUpdateSource, setPluginUpdateSource, checkUpdates }
})

function runtimeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.2.12',
    sha256: 'a'.repeat(64),
    platform: 'win',
    arch: 'x64',
    url: 'https://example.invalid/edge-headless-0.2.12-win-x64.zip',
    ...overrides,
  }
}

function reportWith(
  latest: unknown,
  updateAvailable = true,
  source?: unknown,
  pluginSource?: unknown,
): PluginUpdateReport {
  return {
    manifestVersion: '0.6.1',
    items: [],
    actionableCount: 0,
    ignoredSet: false,
    runtime: {
      configured: true,
      currentVersion: '0.2.11',
      latest: latest as never,
      updateAvailable,
      checkedAt: null,
      lastError: null,
      ...(source !== undefined ? { source: source as never } : {}),
    },
    ...(pluginSource !== undefined ? { pluginSource: pluginSource as never } : {}),
  }
}

function fakeStore(
  report: PluginUpdateReport,
  overrides: Partial<UpdateStoreLike> = {},
): UpdateStoreLike {
  const listeners = new Set<() => void>()
  return {
    report: () => report,
    installing: () => false,
    setInstalling: () => undefined,
    activeJob: () => null,
    recentJobs: () => [],
    refresh: async () => {
      for (const listener of [...listeners]) listener()
      return report
    },
    check: async () => report,
    fetchStatus: async () => undefined,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    ...overrides,
  }
}

function factsText(): string {
  return document.querySelector('.hqpu-facts')?.textContent ?? ''
}

/** The advanced source editors live in the gear-toggled settings panel. */
function openSettings(): void {
  const gear = [...document.querySelectorAll<HTMLButtonElement>('.hqpu-icon-btn')].find(
    (b) => b.title === COPY.zh.ui.gearTooltip,
  )
  gear?.click()
}

function settingsText(): string {
  return document.querySelector('.hqpu-settings')?.textContent ?? ''
}

afterEach(() => {
  document.body.innerHTML = ''
  requestRuntimeUpdate.mockClear()
  setRuntimeUpdateSource.mockClear()
  setPluginUpdateSource.mockClear()
  checkUpdates.mockClear()
})

describe('runtimeLatestVersion', () => {
  it('reads the version off a release entry object', () => {
    expect(runtimeLatestVersion(reportWith(runtimeEntry()).runtime)).toBe('0.2.12')
  })

  it('accepts a bare version string from an older server', () => {
    expect(runtimeLatestVersion(reportWith('0.2.12').runtime)).toBe('0.2.12')
  })

  it('returns null when there is no latest entry', () => {
    expect(runtimeLatestVersion(reportWith(null).runtime)).toBeNull()
    expect(runtimeLatestVersion(reportWith(undefined).runtime)).toBeNull()
    expect(runtimeLatestVersion(null)).toBeNull()
  })

  it('never stringifies an object without a version', () => {
    expect(runtimeLatestVersion(reportWith({ platform: 'win' }).runtime)).toBeNull()
  })
})

describe('update view runtime engine card', () => {
  it('renders the current chip and the new version, never "[object Object]"', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry())), COPY.zh)

    const engine = document.querySelector('.hqpu-engine')
    expect(engine?.textContent).toContain('v0.2.11 (当前)')
    expect(engine?.textContent).toContain('新版本 v0.2.12 可用')
    expect(engine?.textContent).not.toContain('[object Object]')
  })

  it('omits the update row when no update is available', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), false)), COPY.zh)

    expect(document.querySelector('.hqpu-engine-update-row')).toBeNull()
  })
})

describe('runtime update action', () => {
  const startButton = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('[data-runtime-update]')
  const confirmButton = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('[data-runtime-confirm]')

  it('offers an install button only when a version is available', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry())), COPY.zh)
    expect(startButton()).not.toBeNull()

    document.body.innerHTML = ''
    openUpdateView(fakeStore(reportWith(runtimeEntry(), false)), COPY.zh)
    expect(startButton()).toBeNull()
  })

  it('needs a confirmed second click before it posts anything', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry())), COPY.zh)

    startButton()?.click()
    // Armed: the confirm prompt is up and nothing has been sent yet.
    expect(confirmButton()).not.toBeNull()
    expect(requestRuntimeUpdate).not.toHaveBeenCalled()
    // The prompt names the target version — the user must see what restarts.
    expect(document.body.textContent).toContain('0.2.12')

    confirmButton()?.click()
    expect(requestRuntimeUpdate).toHaveBeenCalledWith('0.2.12')
  })

  it('sends nothing when the confirm step is cancelled', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry())), COPY.zh)

    startButton()?.click()
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === COPY.zh.cancel,
    )
    cancel?.click()

    expect(requestRuntimeUpdate).not.toHaveBeenCalled()
    // Back to the armed-off state: the install button is offered again.
    expect(startButton()).not.toBeNull()
  })
})

describe('runtime update source editor', () => {
  const configSource = {
    url: 'https://example.invalid/edge-headless-manifest.json',
    origin: 'config' as const,
    configuredUrl: 'https://example.invalid/edge-headless-manifest.json',
    override: false,
  }
  const editButton = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('[data-runtime-source-edit]')
  const sourceInput = (): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>('[data-runtime-source-input]')

  it('shows the source URL in effect with its origin tag', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true, configSource)), COPY.zh)
    openSettings()

    const settings = settingsText()
    expect(settings).toContain('运行时 Manifest URL')
    expect(settings).toContain(configSource.url)
    // Default source origin badge (green).
    const badge = document.querySelector<HTMLElement>('.hqpu-origin-badge')
    expect(badge?.textContent).toContain(COPY.zh.ui.originDefault)
    expect(badge?.dataset.origin).toBe('config')
  })

  it('labels a user override as 自定义源', () => {
    const overrideSource = {
      ...configSource,
      url: 'https://staging.example.invalid/manifest.json',
      origin: 'override' as const,
      override: true,
    }
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true, overrideSource)), COPY.zh)
    openSettings()

    const badge = document.querySelector<HTMLElement>('.hqpu-origin-badge')
    expect(badge?.textContent).toContain(COPY.zh.ui.originCustom)
    expect(badge?.dataset.origin).toBe('override')
    expect(settingsText()).toContain(overrideSource.url)
  })

  it('offers no editor when the server sends no source (older hq-edge)', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry())), COPY.zh)
    openSettings()
    expect(editButton()).toBeNull()
  })

  it('prefills the field with the URL in effect and saves the edit', async () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true, configSource)), COPY.zh)
    openSettings()

    editButton()?.click()
    expect(sourceInput()?.value).toBe(configSource.url)

    const input = sourceInput()
    if (input === null) throw new Error('source input missing')
    input.value = 'https://staging.example.invalid/manifest.json'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    document.querySelector<HTMLButtonElement>('[data-runtime-source-save]')?.click()
    await vi.waitFor(() =>
      expect(setRuntimeUpdateSource).toHaveBeenCalledWith(
        'https://staging.example.invalid/manifest.json',
      ),
    )
    // The cached report still named the OLD manifest's offer, so a save must
    // re-run discovery — otherwise the facts and the update button would lie.
    await vi.waitFor(() => expect(checkUpdates).toHaveBeenCalled())
    // Editor closes on success.
    expect(sourceInput()).toBeNull()
  })

  it('offers reset only while an override shadows the configured URL', async () => {
    const overrideSource = {
      ...configSource,
      url: 'https://staging.example.invalid/manifest.json',
      origin: 'override' as const,
      override: true,
    }
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true, overrideSource)), COPY.zh)
    openSettings()

    editButton()?.click()
    document.querySelector<HTMLButtonElement>('[data-runtime-source-reset]')?.click()
    // Clearing the override is a POST with an empty URL.
    await vi.waitFor(() => expect(setRuntimeUpdateSource).toHaveBeenCalledWith(''))

    document.body.innerHTML = ''
    setRuntimeUpdateSource.mockClear()
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true, configSource)), COPY.zh)
    openSettings()
    editButton()?.click()
    expect(document.querySelector('[data-runtime-source-reset]')).toBeNull()
  })

  it('keeps the editor open and reports the reason when a save is refused', async () => {
    setRuntimeUpdateSource.mockRejectedValueOnce(
      new Error('http:// is only accepted for a loopback host (localhost / 127.0.0.1)'),
    )
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true, configSource)), COPY.zh)
    openSettings()

    editButton()?.click()
    const input = sourceInput()
    if (input === null) throw new Error('source input missing')
    input.value = 'http://evil.example.invalid/manifest.json'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('[data-runtime-source-save]')?.click()

    // hq-edge's 422 message is shown verbatim, and the user is dropped back
    // into the field to fix the URL rather than losing the draft.
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        'http:// is only accepted for a loopback host (localhost / 127.0.0.1)',
      )
    })
    expect(sourceInput()).not.toBeNull()
    expect(sourceInput()?.value).toBe('http://evil.example.invalid/manifest.json')
    // A refused save must not trigger discovery against a URL that was never set.
    expect(checkUpdates).not.toHaveBeenCalled()
  })

  it('cancel discards the draft without saving', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true, configSource)), COPY.zh)
    openSettings()

    editButton()?.click()
    const input = sourceInput()
    if (input === null) throw new Error('source input missing')
    input.value = 'https://never-saved.example.invalid/manifest.json'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('[data-runtime-source-cancel]')?.click()

    expect(sourceInput()).toBeNull()
    expect(setRuntimeUpdateSource).not.toHaveBeenCalled()
    // Back to read mode — the edit button is offered again.
    expect(editButton()).not.toBeNull()
  })
})

describe('plugin update source editor', () => {
  const pluginConfigSource = {
    url: 'https://gitee.com/huaqiu-electronics/dsh-pcb-eda/raw/main/plugins-release-manifest.json',
    origin: 'config' as const,
    configuredUrl: 'https://gitee.com/huaqiu-electronics/dsh-pcb-eda/raw/main/plugins-release-manifest.json',
    override: false,
  }
  const pluginEditButton = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('[data-plugin-source-edit]')
  const pluginInput = (): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>('[data-plugin-source-input]')
  const runtimeInput = (): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>('[data-runtime-source-input]')
  const reportWithPlugin = (
    pluginSource: unknown,
    runtimeSource?: unknown,
  ): PluginUpdateReport =>
    reportWith(runtimeEntry(), true, runtimeSource, pluginSource)

  it('renders the plugin source editor inside the advanced settings panel', () => {
    openUpdateView(fakeStore(reportWithPlugin(pluginConfigSource)), COPY.zh)
    // Collapsed by default — the editor is hidden until the gear is opened.
    expect(pluginEditButton()).toBeNull()
    openSettings()

    const settings = settingsText()
    expect(settings).toContain('插件 Manifest URL')
    expect(settings).toContain(pluginConfigSource.url)
  })

  it('renders nothing when the server sends no pluginSource (older hq-edge)', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry())), COPY.zh)
    openSettings()
    expect(pluginEditButton()).toBeNull()
  })

  it('prefills with the URL in effect and saves the edit, then re-checks', async () => {
    openUpdateView(fakeStore(reportWithPlugin(pluginConfigSource)), COPY.zh)
    openSettings()

    pluginEditButton()?.click()
    expect(pluginInput()?.value).toBe(pluginConfigSource.url)

    const input = pluginInput()
    if (input === null) throw new Error('plugin source input missing')
    input.value = 'https://staging.example.invalid/release-manifest.json'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('[data-plugin-source-save]')?.click()

    await vi.waitFor(() =>
      expect(setPluginUpdateSource).toHaveBeenCalledWith(
        'https://staging.example.invalid/release-manifest.json',
      ),
    )
    // The cached report still named the OLD manifest's offer, so a save must
    // re-run discovery — otherwise the list and the badge would lie.
    await vi.waitFor(() => expect(checkUpdates).toHaveBeenCalled())
    expect(pluginInput()).toBeNull()
  })

  it('offers reset only while an override shadows the configured URL', async () => {
    const overrideSource = {
      ...pluginConfigSource,
      url: 'https://staging.example.invalid/release-manifest.json',
      origin: 'override' as const,
      override: true,
    }
    openUpdateView(fakeStore(reportWithPlugin(overrideSource)), COPY.zh)
    openSettings()

    pluginEditButton()?.click()
    document.querySelector<HTMLButtonElement>('[data-plugin-source-reset]')?.click()
    // Clearing the override is a POST with an empty URL.
    await vi.waitFor(() => expect(setPluginUpdateSource).toHaveBeenCalledWith(''))

    document.body.innerHTML = ''
    setPluginUpdateSource.mockClear()
    openUpdateView(fakeStore(reportWithPlugin(pluginConfigSource)), COPY.zh)
    openSettings()
    pluginEditButton()?.click()
    expect(document.querySelector('[data-plugin-source-reset]')).toBeNull()
  })

  it('keeps the editor open and reports the reason when a save is refused', async () => {
    setPluginUpdateSource.mockRejectedValueOnce(
      new Error('http:// is only accepted for a loopback host (localhost / 127.0.0.1)'),
    )
    openUpdateView(fakeStore(reportWithPlugin(pluginConfigSource)), COPY.zh)
    openSettings()

    pluginEditButton()?.click()
    const input = pluginInput()
    if (input === null) throw new Error('plugin source input missing')
    input.value = 'http://intranet.example/release-manifest.json'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('[data-plugin-source-save]')?.click()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        'http:// is only accepted for a loopback host (localhost / 127.0.0.1)',
      )
    })
    // Still editing — the user fixes the URL in place, draft intact.
    expect(pluginInput()).not.toBeNull()
    expect(pluginInput()?.value).toBe('http://intranet.example/release-manifest.json')
    // A refused save must not trigger discovery against a URL that was never set.
    expect(checkUpdates).not.toHaveBeenCalled()
  })

  it('cancel discards the plugin draft without saving', () => {
    openUpdateView(fakeStore(reportWithPlugin(pluginConfigSource)), COPY.zh)
    openSettings()

    pluginEditButton()?.click()
    const input = pluginInput()
    if (input === null) throw new Error('plugin source input missing')
    input.value = 'https://never-saved.example.invalid/release-manifest.json'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLButtonElement>('[data-plugin-source-cancel]')?.click()

    expect(pluginInput()).toBeNull()
    expect(setPluginUpdateSource).not.toHaveBeenCalled()
    // Back to read mode — the edit button is offered again.
    expect(pluginEditButton()).not.toBeNull()
  })

  it('the two editors keep independent state', () => {
    openUpdateView(
      fakeStore(reportWith(runtimeEntry(), true, {
        url: 'https://example.invalid/edge-headless-manifest.json',
        origin: 'config' as const,
        configuredUrl: 'https://example.invalid/edge-headless-manifest.json',
        override: false,
      }, pluginConfigSource)),
      COPY.zh,
    )
    openSettings()

    // Open the runtime editor only: the plugin editor must stay in read mode.
    document.querySelector<HTMLButtonElement>('[data-runtime-source-edit]')?.click()
    expect(runtimeInput()).not.toBeNull()
    expect(pluginInput()).toBeNull()

    document.querySelector<HTMLButtonElement>('[data-runtime-source-cancel]')?.click()
    pluginEditButton()?.click()
    expect(pluginInput()).not.toBeNull()
    expect(runtimeInput()).toBeNull()
  })
})

// ── Version direction gate (the reported corner case) ───────────────────────
//
// The panel once rendered `analytics 可更新 0.6.4 → 0.6.2` with a live 安装
// button for the whole 16-plugin set: the manifest published 0.6.2 while the
// active bundle already held 0.6.4. "Update available" must exist only when
// the remote SemVer is strictly greater than the local one — an older
// hq-edge still reports the wrong state, so every report is normalized at
// the fetch boundary (fetchReport/checkUpdates) before it reaches the view.
describe('plugin item version direction (UI)', () => {
  const analyticsCard = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('.hqpu-card[data-plugin-name="@huaqiu/dsh-analytics"]')

  function item(overrides: Partial<PluginUpdateItem>): PluginUpdateItem {
    return {
      name: '@huaqiu/dsh-analytics',
      currentVersion: null,
      availableVersion: '0.6.4',
      state: 'install',
      ...overrides,
    }
  }

  function reportWithItems(items: PluginUpdateItem[]): PluginUpdateReport {
    return normalizePluginUpdateReport({
      ...reportWith(runtimeEntry()),
      items,
    })
  }

  it('a lagging manifest offer is not 可更新 and carries no install button', () => {
    // Exactly what the shell reported: installed 0.6.4, manifest 0.6.2.
    const raw = item({ currentVersion: '0.6.4', availableVersion: '0.6.2', state: 'update' })
    openUpdateView(fakeStore(reportWithItems([raw])), COPY.zh)

    const card = analyticsCard()
    expect(card).not.toBeNull()
    expect(card?.dataset.state).toBe('current')
    expect(card?.textContent).toContain('0.6.4')
    // It lands in the settled group, not in 待处理.
    const groups = [...document.querySelectorAll<HTMLElement>('.hqpu-group')]
    const inActionable = groups.some(
      (g) => g.dataset.group === COPY.zh.group.actionable && g.contains(card as Node),
    )
    expect(inActionable).toBe(false)
    const inCurrent = groups.some(
      (g) => g.dataset.group === COPY.zh.group.current && g.contains(card as Node),
    )
    expect(inCurrent).toBe(true)
    // Footer agrees: zero compatible plugins, install-all disabled.
    expect(document.querySelector('.hqpu-foot-meta')?.textContent).toContain(
      COPY.zh.ui.footerCount(0),
    )
    expect(
      document.querySelector<HTMLButtonElement>('.hqpu-btn--block')?.disabled,
    ).toBe(true)
  })

  it('a genuinely newer remote version stays 可更新 and the footer enables install-all', () => {
    const raw = item({ currentVersion: '0.6.2', availableVersion: '0.6.4', state: 'update' })
    openUpdateView(fakeStore(reportWithItems([raw])), COPY.zh)

    const card = analyticsCard()
    expect(card?.dataset.state).toBe('update')
    expect(card?.textContent).toContain('0.6.2')
    expect(card?.querySelector('.hqpu-ver-new')?.textContent).toContain('0.6.4')
    const groups = [...document.querySelectorAll<HTMLElement>('.hqpu-group')]
    expect(
      groups.some((g) => g.dataset.group === COPY.zh.group.actionable && g.contains(card as Node)),
    ).toBe(true)
    // Footer: exactly one compatible plugin, install-all enabled.
    expect(document.querySelector('.hqpu-foot-meta')?.textContent).toContain(
      COPY.zh.ui.footerCount(1),
    )
    expect(
      document.querySelector<HTMLButtonElement>('.hqpu-btn--block')?.disabled,
    ).toBe(false)
  })

  it('the reported 16-plugin lagging manifest leaves nothing actionable', () => {
    // analytics, artifacts, auth, … — 16 plugins at 0.6.4 against a 0.6.2
    // manifest: every card demoted, badge and footer both at zero.
    const names = [
      'analytics',
      'artifacts',
      'auth',
      'eda-host',
      'eda-selection',
      'huaqiu-about',
      'kicad',
      'kicad-drc',
      'tool-part-search',
      'tool-pcb-viewer',
      'tool-plugin-update',
      'tool-quote',
      'tool-symbol-footprint',
      'ui-theme-huaqiu',
      'dsh-plugin-log',
      'dsh-sidebar-entry',
    ]
    openUpdateView(
      fakeStore(
        reportWithItems(
          names.map((name) =>
            item({
              name: `@huaqiu/dsh-${name}`,
              currentVersion: '0.6.4',
              availableVersion: '0.6.2',
              state: 'update',
            }),
          ),
        ),
      ),
      COPY.zh,
    )

    const cards = [...document.querySelectorAll<HTMLElement>('.hqpu-card')]
    expect(cards).toHaveLength(16)
    expect(cards.every((c) => c.dataset.state === 'current')).toBe(true)
    // No install button anywhere, in any group (cards carry no install buttons;
    // install-all lives in the footer).
    expect(document.querySelector('.hqpu-cards button')).toBeNull()
    expect(document.querySelector('.hqpu-foot-meta')?.textContent).toContain(
      COPY.zh.ui.footerCount(0),
    )
  })

  it('keeps a mixed report honest: only the genuine upgrade is actionable', () => {
    openUpdateView(
      fakeStore(
        reportWithItems([
          item({ currentVersion: '0.6.4', availableVersion: '0.6.2', state: 'update' }), // lagging
          item({
            name: '@huaqiu/dsh-kicad',
            currentVersion: '0.6.1',
            availableVersion: '0.6.2',
            state: 'update',
          }), // genuine
          item({ name: '@huaqiu/dsh-auth', currentVersion: null, availableVersion: '0.6.2' }), // absent
        ]),
      ),
      COPY.zh,
    )

    expect(analyticsCard()?.dataset.state).toBe('current')
    expect(
      document.querySelector<HTMLElement>('.hqpu-card[data-plugin-name="@huaqiu/dsh-kicad"]')
        ?.dataset.state,
    ).toBe('update')
    expect(
      document.querySelector<HTMLElement>('.hqpu-card[data-plugin-name="@huaqiu/dsh-auth"]')
        ?.dataset.state,
    ).toBe('install')
    // Footer counts exactly the two actionable installs.
    expect(document.querySelector('.hqpu-foot-meta')?.textContent).toContain(
      COPY.zh.ui.footerCount(2),
    )
  })
})

// ── Runtime last-result alerts: amber rollback/failed vs green success ───────
describe('runtime last-result alerts', () => {
  function reportWithLastResult(lastResult: Record<string, unknown>): PluginUpdateReport {
    const base = reportWith(runtimeEntry())
    return {
      ...base,
      runtime: { ...base.runtime, lastResult } as unknown as PluginUpdateReport['runtime'],
    }
  }

  it('rolls back to an amber alert with title, old→new body, code chip and dismiss', () => {
    openUpdateView(
      fakeStore(
        reportWithLastResult({
          state: 'rolled_back',
          targetVersion: '0.2.12',
          installedVersion: '0.2.11',
          at: '2026-10-23T01:00:00.000Z',
          errorCode: 'POSTINSTALL_FAILED',
          message: 'service refused to start',
        }),
      ),
      COPY.zh,
    )
    const alert = document.querySelector('[data-group="runtime-alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.querySelector('.hqpu-alert--amber')).not.toBeNull()
    expect(alert?.textContent).toContain(COPY.zh.ui.rollbackTitle)
    expect(alert?.querySelector('code')?.textContent).toBe('POSTINSTALL_FAILED')
    // No diagnostic-log button — the plugin has no log-open affordance.
    expect(alert?.textContent).not.toContain('诊断日志')
    // Dismiss hides the alert.
    const dismiss = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === COPY.zh.ui.dismiss,
    )
    dismiss?.click()
    expect(document.querySelector('[data-group="runtime-alert"]')).toBeNull()
  })

  it('failed result also renders as the amber alert', () => {
    openUpdateView(
      fakeStore(
        reportWithLastResult({
          state: 'failed',
          targetVersion: '0.2.12',
          installedVersion: null,
          at: '2026-10-23T01:00:00.000Z',
          errorCode: 'CHECKSUM_MISMATCH',
        }),
      ),
      COPY.zh,
    )
    const alert = document.querySelector('[data-group="runtime-alert"]')
    expect(alert?.textContent).toContain(COPY.zh.ui.failedTitle)
    expect(alert?.querySelector('code')?.textContent).toBe('CHECKSUM_MISMATCH')
  })

  it('succeeded result renders as a quiet green line, never a loud banner', () => {
    openUpdateView(
      fakeStore(
        reportWithLastResult({
          state: 'succeeded',
          targetVersion: '0.2.12',
          installedVersion: '0.2.12',
          at: '2026-10-23T01:00:00.000Z',
        }),
      ),
      COPY.zh,
    )
    const success = document.querySelector('[data-role="runtime-success"]')
    expect(success).not.toBeNull()
    expect(success?.textContent).toContain(COPY.zh.ui.successInline)
    expect(document.querySelector('[data-group="runtime-alert"]')).toBeNull()
  })
})

/**
 * The last-update log drawer.
 *
 * It used to render unconditionally: a finished plugin-set install lists one
 * row per component (dozens of "ignored"/"blocked" lines), so the log pushed
 * every actionable card below the fold as soon as one update had ever run. The
 * header toggle now owns that block — closed by default for a routine success,
 * opened by itself for a failed / rolled-back / abandoned job so the error code
 * and Retry are never hidden behind a click.
 */
describe('last update log drawer', () => {
  const logButton = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('[data-log-toggle]')
  const logSection = (): Element | null => document.querySelector('[data-group="job-result"]')

  function steps(count: number): UpdateStep[] {
    return Array.from({ length: count }, (_, i) => ({
      name: `@huaqiu/dsh-plugin-${i + 1}@0.6.14`,
      state: 'skipped' as const,
    }))
  }

  function settledJob(phase: UpdatePhase, extra: Partial<UpdateJob> = {}): UpdateJob {
    return {
      id: `uj_${phase}`,
      kind: 'plugin-set',
      targetVersion: '0.6.14',
      previousVersion: '0.3.16',
      startedAt: '2026-10-29T06:30:00.000Z',
      updatedAt: '2026-10-29T06:34:45.000Z',
      phase,
      progress: { percent: null },
      logHint: 'uj_1793255677245_2fi1x0dltt',
      ...extra,
    }
  }

  it('keeps a successful log collapsed until the header button is pressed', () => {
    openUpdateView(
      fakeStore(reportWith(runtimeEntry(), false), {
        recentJobs: () => [settledJob('done', { steps: steps(6) })],
      }),
      COPY.zh,
    )

    // Collapsed: none of the per-component rows are in the DOM at all.
    expect(logSection()).toBeNull()
    expect(document.body.textContent).not.toContain('@huaqiu/dsh-plugin-1@0.6.14')
    // The affordance exists and says what a click will do.
    expect(logButton()?.disabled).toBe(false)
    expect(logButton()?.getAttribute('aria-pressed')).toBe('false')
    expect(logButton()?.title).toBe(COPY.zh.ui.logShow)

    logButton()?.click()
    expect(logSection()).not.toBeNull()
    expect(document.body.textContent).toContain('@huaqiu/dsh-plugin-1@0.6.14')
    expect(logButton()?.getAttribute('aria-pressed')).toBe('true')
    expect(logButton()?.title).toBe(COPY.zh.ui.logHide)

    // Toggles back off — the collapse is a real toggle, not a one-way expand.
    logButton()?.click()
    expect(logSection()).toBeNull()
  })

  it('opens a failed log by itself so the error code and Retry stay reachable', () => {
    openUpdateView(
      fakeStore(reportWith(runtimeEntry(), false), {
        recentJobs: () => [
          settledJob('failed', {
            steps: steps(2),
            result: {
              ok: false,
              installedVersion: null,
              errorCode: 'CHECKSUM_MISMATCH',
              rolledBack: false,
              finishedAt: '2026-10-29T06:34:45.000Z',
            },
          }),
        ],
      }),
      COPY.zh,
    )

    expect(logSection()?.textContent).toContain('CHECKSUM_MISMATCH')
    expect(logButton()?.getAttribute('aria-pressed')).toBe('true')
    expect(logButton()?.title).toBe(COPY.zh.ui.logHide)

    // Still a toggle: the person can put it away.
    logButton()?.click()
    expect(logSection()).toBeNull()
  })

  it('sits between the advanced (gear) and close actions in the header', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), false)), COPY.zh)

    const labels = [...document.querySelectorAll<HTMLButtonElement>('.hqpu-toolbar .hqpu-icon-btn')]
      .map((b) => b.title)
    const gear = labels.indexOf(COPY.zh.ui.gearTooltip)
    const log = labels.indexOf(COPY.zh.ui.logNone)
    const close = labels.indexOf(COPY.zh.close)
    expect(gear).toBeGreaterThanOrEqual(0)
    expect(log).toBe(gear + 1)
    expect(close).toBe(log + 1)
  })

  it('disables the toggle when no job has finished', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), false)), COPY.zh)

    expect(logButton()?.disabled).toBe(true)
    expect(logButton()?.title).toBe(COPY.zh.ui.logNone)
    expect(logButton()?.getAttribute('aria-pressed')).toBe('false')
  })

  it('disables the toggle while a job is running — the live view owns the panel', () => {
    const running = settledJob('downloading')
    openUpdateView(
      fakeStore(reportWith(runtimeEntry(), false), {
        activeJob: () => running,
        recentJobs: () => [settledJob('done', { steps: steps(3) })],
      }),
      COPY.zh,
    )

    // The in-flight banner shows; the previous log is not offered mid-flight.
    expect(document.querySelector('.hqpu-active')).not.toBeNull()
    expect(logSection()).toBeNull()
    expect(logButton()?.disabled).toBe(true)
    expect(logButton()?.title).toBe(COPY.zh.ui.logBusy)
  })
})

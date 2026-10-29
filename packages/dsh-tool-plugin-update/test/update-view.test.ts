// @vitest-environment jsdom
/**
 * DOM tests for the "更新中心" panel (`src/client/update-view.ts`).
 *
 * These lock the redesign's two contracts, not its pixels:
 *
 *   1. **Every number and label comes from the report.** The runtime row once
 *      rendered `[object Object]` because hq-edge sends `runtime.latest` as a
 *      release ENTRY; the version row must always name a version.
 *   2. **Nothing that needs no action sits above something that does.** The
 *      settled groups (已忽略 / 已是最新 / 版本说明) are collapsed and their
 *      content is not in the DOM until opened; the job log is a drawer, not an
 *      inline block; a failed job says so in the body.
 *
 * The update sources are edited in place (the gear strip), so the source tests
 * here drive the inputs directly instead of a read → edit → save dance.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runtimeLatestVersion,
  type PluginUpdateItem,
  type PluginUpdateReport,
  type UpdateJob,
  type UpdatePhase,
  type UpdateStep,
} from '../src/client/api.js'
import { COPY } from '../src/client/copy.js'
import { openUpdateView, type UpdateStoreLike } from '../src/client/update-view.js'
import { normalizePluginUpdateReport } from '../src/client/version.js'

// The view calls the API directly, so stub the calls it makes. Everything else
// (bands, cards, disclosures, footer) is exercised for real.
const {
  requestRuntimeUpdate,
  setRuntimeUpdateSource,
  setPluginUpdateSource,
  checkUpdates,
  installSet,
  ignorePlugin,
  unignorePlugin,
  ignoreOffer,
} = vi.hoisted(() => ({
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
    configuredUrl:
      'https://gitee.com/huaqiu-electronics/dsh-pcb-eda/raw/main/plugins-release-manifest.json',
    override: url.length > 0,
  })),
  checkUpdates: vi.fn(async () => ({})),
  installSet: vi.fn(async (_setVersion: string, _names?: string[]) => ({ accepted: true }) as never),
  ignorePlugin: vi.fn(async (_setVersion: string, _name: string) => ({ ok: true })),
  unignorePlugin: vi.fn(async (_setVersion: string, _name: string) => ({ ok: true })),
  ignoreOffer: vi.fn(async (_setVersion: string) => ({ ok: true })),
}))
vi.mock('../src/client/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/api.js')>()
  return {
    ...actual,
    requestRuntimeUpdate,
    setRuntimeUpdateSource,
    setPluginUpdateSource,
    checkUpdates,
    installSet,
    ignorePlugin,
    unignorePlugin,
    ignoreOffer,
  }
})

const zh = COPY.zh

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

/** The gear-toggled source strip. */
function openSettings(): void {
  document.querySelector<HTMLButtonElement>('[data-settings-toggle]')?.click()
}

function settingsText(): string {
  return document.querySelector('.hqpu-settings')?.textContent ?? ''
}

/** Open one collapsed group by its visible title. */
function openDisclosure(title: string): void {
  const head = [...document.querySelectorAll<HTMLButtonElement>('.hqpu-disc-head')].find((b) =>
    (b.textContent ?? '').includes(title),
  )
  head?.click()
}

/** Any plugin element in either presentation: actionable card or muted row. */
function pluginNode(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-plugin-name="${name}"]`)
}

function groupOf(node: Node | null): string | undefined {
  return node?.parentElement?.closest<HTMLElement>('[data-group]')?.dataset.group ??
    (node as HTMLElement | null)?.closest<HTMLElement>('[data-group]')?.dataset.group
}

function cta(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('.hqpu-btn--block')
}

afterEach(() => {
  document.body.innerHTML = ''
  for (const spy of [
    requestRuntimeUpdate,
    setRuntimeUpdateSource,
    setPluginUpdateSource,
    checkUpdates,
    installSet,
    ignorePlugin,
    unignorePlugin,
    ignoreOffer,
  ]) {
    spy.mockClear()
  }
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

describe('runtime engine card', () => {
  it('renders the current chip and the offered version, never "[object Object]"', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry())), zh)

    const engine = document.querySelector('.hqpu-engine')
    expect(engine?.textContent).toContain('v0.2.11 当前')
    expect(engine?.textContent).toContain('v0.2.12 可用')
    expect(engine?.textContent).not.toContain('[object Object]')
  })

  it('omits the update row when no update is available', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), false)), zh)

    expect(document.querySelector('[data-runtime-update]')).toBeNull()
  })

  it('never tags an offer "关键修复" without a note or breaking entry', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry())), zh)
    // A bare release entry carries neither → no tag, no invented claim.
    expect(document.querySelector('.hqpu-tag--brand')).toBeNull()

    document.body.innerHTML = ''
    openUpdateView(
      fakeStore(reportWith(runtimeEntry({ notes: ['fixes a memory leak'] }))),
      zh,
    )
    expect(document.querySelector('.hqpu-tag--brand')?.textContent).toBe(zh.ui.breakingTag)
  })
})

describe('runtime update action', () => {
  const startButton = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('[data-runtime-update]')
  const confirmButton = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('[data-runtime-confirm]')

  it('offers an install button only when a version is available', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry())), zh)
    expect(startButton()).not.toBeNull()

    document.body.innerHTML = ''
    openUpdateView(fakeStore(reportWith(runtimeEntry(), false)), zh)
    expect(startButton()).toBeNull()
  })

  it('needs a confirmed second click before it posts anything', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry())), zh)

    startButton()?.click()
    // Armed: the confirm prompt replaces the action, and nothing has been sent.
    expect(confirmButton()).not.toBeNull()
    expect(startButton()).toBeNull()
    expect(requestRuntimeUpdate).not.toHaveBeenCalled()
    // The prompt names the target version — the user must see what restarts.
    expect(document.body.textContent).toContain('0.2.12')

    confirmButton()?.click()
    expect(requestRuntimeUpdate).toHaveBeenCalledWith('0.2.12')
  })

  it('sends nothing when the confirm step is cancelled', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry())), zh)

    startButton()?.click()
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === zh.cancel,
    )
    cancel?.click()

    expect(requestRuntimeUpdate).not.toHaveBeenCalled()
    // Back to the armed-off state: the install button is offered again.
    expect(startButton()).not.toBeNull()
  })
})

describe('update source strip', () => {
  const configSource = {
    url: 'https://example.invalid/edge-headless-manifest.json',
    origin: 'config' as const,
    configuredUrl: 'https://example.invalid/edge-headless-manifest.json',
    override: false,
  }
  const pluginConfigSource = {
    url: 'https://gitee.com/huaqiu-electronics/dsh-pcb-eda/raw/main/plugins-release-manifest.json',
    origin: 'config' as const,
    configuredUrl:
      'https://gitee.com/huaqiu-electronics/dsh-pcb-eda/raw/main/plugins-release-manifest.json',
    override: false,
  }
  const pluginInput = (): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>('[data-plugin-source-input]')
  const runtimeInput = (): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>('[data-runtime-source-input]')
  const type = (input: HTMLInputElement, value: string): void => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const saveButton = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('[data-source-save]')

  it('hides both URLs until the gear is pressed', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true, configSource, pluginConfigSource)), zh)
    expect(pluginInput()).toBeNull()
    expect(runtimeInput()).toBeNull()

    openSettings()
    expect(pluginInput()?.value).toBe(pluginConfigSource.url)
    expect(runtimeInput()?.value).toBe(configSource.url)
    expect(settingsText()).toContain(zh.ui.pluginUrlLabel)
    expect(settingsText()).toContain(zh.ui.runtimeUrlLabel)
  })

  it('labels the default source and a user override differently', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true, configSource, pluginConfigSource)), zh)
    openSettings()
    const badge = document.querySelector<HTMLElement>('.hqpu-origin-badge')
    expect(badge?.textContent).toContain(zh.ui.originDefault)
    expect(badge?.dataset.origin).toBe('config')

    document.body.innerHTML = ''
    openUpdateView(
      fakeStore(
        reportWith(
          runtimeEntry(),
          true,
          { ...configSource, url: 'https://staging.example.invalid/m.json', origin: 'override', override: true },
          pluginConfigSource,
        ),
      ),
      zh,
    )
    openSettings()
    const override = document.querySelector<HTMLElement>('.hqpu-origin-badge')
    expect(override?.textContent).toContain(zh.ui.originCustom)
    expect(override?.dataset.origin).toBe('override')
  })

  it('offers no field when the server sends no source (older hq-edge)', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry())), zh)
    openSettings()
    expect(runtimeInput()).toBeNull()
    expect(pluginInput()).toBeNull()
    // …and says so rather than showing an empty editor.
    expect(settingsText()).toContain(zh.runtime.notConfigured)
  })

  it('saves only the URLs that changed, then re-runs discovery and closes', async () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true, configSource, pluginConfigSource)), zh)
    openSettings()

    const input = runtimeInput()
    if (input === null) throw new Error('runtime source input missing')
    type(input, 'https://staging.example.invalid/manifest.json')
    saveButton()?.click()

    await vi.waitFor(() =>
      expect(setRuntimeUpdateSource).toHaveBeenCalledWith(
        'https://staging.example.invalid/manifest.json',
      ),
    )
    // The plugin URL was untouched — saving must not rewrite it.
    expect(setPluginUpdateSource).not.toHaveBeenCalled()
    // The cached report still named the OLD manifest's offer, so a save must
    // re-run discovery — otherwise the list and the badge would lie.
    await vi.waitFor(() => expect(checkUpdates).toHaveBeenCalled())
    // The strip closes on success.
    await vi.waitFor(() => expect(runtimeInput()).toBeNull())
  })

  it('saves both URLs when both were edited', async () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true, configSource, pluginConfigSource)), zh)
    openSettings()

    const p = pluginInput()
    const r = runtimeInput()
    if (p === null || r === null) throw new Error('source inputs missing')
    type(p, 'https://staging.example.invalid/plugins.json')
    type(r, 'https://staging.example.invalid/edge.json')
    saveButton()?.click()

    await vi.waitFor(() => expect(setPluginUpdateSource).toHaveBeenCalled())
    await vi.waitFor(() => expect(setRuntimeUpdateSource).toHaveBeenCalled())
  })

  it('offers 恢复默认 only while an override shadows the configured URL', async () => {
    openUpdateView(
      fakeStore(
        reportWith(
          runtimeEntry(),
          true,
          { ...configSource, url: 'https://staging.example.invalid/m.json', origin: 'override', override: true },
          pluginConfigSource,
        ),
      ),
      zh,
    )
    openSettings()
    document.querySelector<HTMLButtonElement>('[data-runtime-source-reset]')?.click()
    // Clearing the override is a POST with an empty URL.
    await vi.waitFor(() => expect(setRuntimeUpdateSource).toHaveBeenCalledWith(''))

    document.body.innerHTML = ''
    setRuntimeUpdateSource.mockClear()
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true, configSource, pluginConfigSource)), zh)
    openSettings()
    expect(document.querySelector('[data-runtime-source-reset]')).toBeNull()
  })

  it('keeps the strip open with the draft when a save is refused', async () => {
    setRuntimeUpdateSource.mockRejectedValueOnce(
      new Error('http:// is only accepted for a loopback host (localhost / 127.0.0.1)'),
    )
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true, configSource, pluginConfigSource)), zh)
    openSettings()

    const input = runtimeInput()
    if (input === null) throw new Error('runtime source input missing')
    type(input, 'http://evil.example.invalid/manifest.json')
    saveButton()?.click()

    // hq-edge's 422 message is shown verbatim, and the typed URL survives so it
    // can be fixed in place.
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        'http:// is only accepted for a loopback host (localhost / 127.0.0.1)',
      )
    })
    expect(runtimeInput()?.value).toBe('http://evil.example.invalid/manifest.json')
    // A refused save must not trigger discovery against a URL that was never set.
    expect(checkUpdates).not.toHaveBeenCalled()
  })

  it('cancel drops both drafts without saving', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true, configSource, pluginConfigSource)), zh)
    openSettings()

    const input = runtimeInput()
    if (input === null) throw new Error('runtime source input missing')
    type(input, 'https://never-saved.example.invalid/manifest.json')
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('.hqpu-settings-actions button')].find(
      (b) => b.textContent === zh.cancel,
    )
    cancel?.click()

    expect(runtimeInput()).toBeNull()
    expect(setRuntimeUpdateSource).not.toHaveBeenCalled()
    expect(setPluginUpdateSource).not.toHaveBeenCalled()
  })
})

// ── Version direction gate (the reported corner case) ───────────────────────
//
// The panel once rendered `analytics 可更新 0.6.4 → 0.6.2` with a live install
// button for the whole set. "Update available" must exist only when the remote
// SemVer is strictly greater, so every report is normalized at the fetch
// boundary before it reaches the view. A demoted item is a settled ROW now,
// inside the collapsed 已是最新 group.
describe('plugin item version direction', () => {
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
    return normalizePluginUpdateReport({ ...reportWith(runtimeEntry(), false), items })
  }

  it('a lagging manifest offer is not actionable and lands in 已是最新', () => {
    const raw = item({ currentVersion: '0.6.4', availableVersion: '0.6.2', state: 'update' })
    openUpdateView(fakeStore(reportWithItems([raw])), zh)

    // Collapsed by default: nothing is claimed before the group is opened…
    expect(pluginNode('@huaqiu/dsh-analytics')).toBeNull()
    expect(document.querySelector('[data-group="待处理更新"]')).toBeNull()

    openDisclosure(zh.group.current)
    const row = pluginNode('@huaqiu/dsh-analytics')
    expect(row).not.toBeNull()
    expect(row?.dataset.state).toBe('current')
    expect(row?.textContent).toContain('0.6.4')
    expect(groupOf(row)).toBe(zh.group.current)

    // Footer agrees: nothing to install.
    expect(document.querySelector('.hqpu-foot-meta')?.textContent).toContain(zh.ui.footerAllGood)
    expect(cta()?.disabled).toBe(true)
  })

  it('a genuinely newer remote version becomes an actionable card', () => {
    const raw = item({ currentVersion: '0.6.2', availableVersion: '0.6.4', state: 'update' })
    openUpdateView(fakeStore(reportWithItems([raw])), zh)

    const card = pluginNode('@huaqiu/dsh-analytics')
    expect(card?.dataset.state).toBe('update')
    expect(card?.textContent).toContain('0.6.2')
    expect(card?.querySelector('.hqpu-ver-new')?.textContent).toBe('0.6.4')
    expect(groupOf(card)).toBe(zh.group.actionable)
    expect(document.querySelector('.hqpu-foot-meta')?.textContent).toContain(zh.ui.footerCount(1))
    expect(cta()?.disabled).toBe(false)
    expect(cta()?.textContent).toContain(zh.ui.cta(1))
  })

  it('the reported 16-plugin lagging manifest leaves nothing actionable', () => {
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
      zh,
    )

    // No card, no button anywhere: every item was demoted to a settled row.
    expect(document.querySelector('.hqpu-card')).toBeNull()
    expect(document.querySelector('.hqpu-cards button')).toBeNull()
    expect(document.querySelector('[data-group="待处理更新"]')).toBeNull()
    expect(cta()?.disabled).toBe(true)

    openDisclosure(zh.group.current)
    const rows = [...document.querySelectorAll<HTMLElement>('.hqpu-row')]
    expect(rows).toHaveLength(16)
    expect(rows.every((r) => r.dataset.state === 'current')).toBe(true)
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
      zh,
    )

    expect(pluginNode('@huaqiu/dsh-kicad')?.dataset.state).toBe('update')
    expect(pluginNode('@huaqiu/dsh-auth')?.dataset.state).toBe('install')
    // The absent plugin's card says 单独安装, not 单独更新.
    expect(pluginNode('@huaqiu/dsh-auth')?.querySelector('.hqpu-card-action')?.textContent).toBe(
      zh.ui.singleInstall,
    )
    // Footer counts exactly the two actionable installs.
    expect(document.querySelector('.hqpu-foot-meta')?.textContent).toContain(zh.ui.footerCount(2))
  })
})

// ── The decision band ───────────────────────────────────────────────────────
describe('decision band', () => {
  it('states plugins and runtime separately when both are on offer', () => {
    openUpdateView(
      fakeStore(
        {
          ...reportWith(runtimeEntry()),
          items: [
            { name: '@huaqiu/dsh-a', currentVersion: '0.6.0', availableVersion: '0.6.1', state: 'update' },
            { name: '@huaqiu/dsh-b', currentVersion: '0.6.0', availableVersion: '0.6.1', state: 'update' },
          ],
        },
      ),
      zh,
    )
    const band = document.querySelector('[data-role="decision-band"]')
    expect(band?.textContent).toContain(zh.ui.summaryPlugins(2))
    expect(band?.textContent).toContain(zh.ui.summaryRuntime)
  })

  it('is absent when nothing is on offer', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), false)), zh)
    expect(document.querySelector('[data-role="decision-band"]')).toBeNull()
  })
})

// ── Footer states ───────────────────────────────────────────────────────────
describe('footer states', () => {
  function updatable(): PluginUpdateReport {
    return {
      ...reportWith(runtimeEntry(), false),
      items: [
        { name: '@huaqiu/dsh-a', currentVersion: '0.6.0', availableVersion: '0.6.1', state: 'update' },
      ],
    }
  }

  it('offers the set install while something is actionable', () => {
    openUpdateView(fakeStore(updatable()), zh)
    expect(cta()?.disabled).toBe(false)
    expect(cta()?.textContent).toContain(zh.ui.cta(1))
    expect(cta()?.dataset.busy).toBe('false')
    expect(document.querySelector('.hqpu-foot-meta')?.textContent).toContain(zh.ui.footerCount(1))
  })

  it('shows a spinner label and blocks the CTA while installing', () => {
    openUpdateView(fakeStore(updatable(), { installing: () => true }), zh)
    expect(cta()?.disabled).toBe(true)
    expect(cta()?.dataset.busy).toBe('true')
    expect(cta()?.getAttribute('aria-busy')).toBe('true')
    expect(cta()?.textContent).toContain(zh.ui.ctaInstalling)
    expect(document.querySelector('.hqpu-foot-meta')?.textContent).toContain(zh.ui.footerBusy)
  })

  it('refuses to install against a failed check and says why', () => {
    const failed: PluginUpdateReport = { ...updatable(), lastError: 'manifest fetch failed: 502' }
    openUpdateView(fakeStore(failed), zh)
    // A stale offer must not be installable: the label carries the reason.
    expect(cta()?.disabled).toBe(true)
    expect(cta()?.textContent).toContain(zh.ui.ctaFailed)
    expect(document.querySelector('.hqpu-foot-meta')?.textContent).toContain(zh.ui.footerFailed)
  })

  it('names the runtime as the only remaining action when plugins are done', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), true)), zh)
    expect(cta()?.disabled).toBe(true)
    expect(cta()?.textContent).toContain(zh.ui.ctaNoPlugins)
    expect(document.querySelector('.hqpu-foot-meta')?.textContent).toContain(zh.ui.footerRuntimeOnly)
  })

  it('hides the release mute when there is nothing to mute', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), false)), zh)
    const mute = document.querySelector<HTMLButtonElement>('.hqpu-foot-meta button')
    expect(mute?.hidden).toBe(true)
  })

  it('mutes and unmutes the whole release', async () => {
    openUpdateView(fakeStore(updatable()), zh)
    const mute = document.querySelector<HTMLButtonElement>('.hqpu-foot-meta button')
    expect(mute?.textContent).toBe(zh.ui.ignoreBtn)
    mute?.click()
    await vi.waitFor(() => expect(ignoreOffer).toHaveBeenCalledWith('0.6.1'))

    document.body.innerHTML = ''
    openUpdateView(fakeStore({ ...updatable(), ignoredSet: true }), zh)
    expect(document.querySelector('.hqpu-foot-meta button')?.textContent).toBe(zh.ui.unignoreBtn)
  })
})

// ── Card actions ────────────────────────────────────────────────────────────
describe('actionable card actions', () => {
  function oneItem(): PluginUpdateReport {
    return {
      ...reportWith(runtimeEntry(), false),
      items: [
        {
          name: '@huaqiu/dsh-kicad',
          displayName: 'KiCad 集成',
          currentVersion: '0.6.9',
          availableVersion: '0.6.14',
          sizeBytes: 2_400_000,
          changes: ['修复导出崩溃'],
          state: 'update',
        },
      ],
    }
  }

  it('installs just this plugin, not the whole set', async () => {
    openUpdateView(fakeStore(oneItem()), zh)
    const action = pluginNode('@huaqiu/dsh-kicad')?.querySelector<HTMLButtonElement>(
      '.hqpu-card-action',
    )
    expect(action?.textContent).toBe(zh.ui.singleUpdate)
    // The tooltip must agree with what the call actually does.
    expect(action?.title).toBe(zh.ui.singleUpdateTip)

    action?.click()
    await vi.waitFor(() =>
      expect(installSet).toHaveBeenCalledWith('0.6.1', ['@huaqiu/dsh-kicad']),
    )
  })

  it('mutes one plugin and re-runs discovery', async () => {
    const check = vi.fn(async () => oneItem())
    openUpdateView(fakeStore(oneItem(), { check }), zh)
    const eye = pluginNode('@huaqiu/dsh-kicad')?.querySelectorAll<HTMLButtonElement>(
      '.hqpu-card-end button',
    )[1]
    expect(eye?.title).toBe(zh.ui.ignorePlugin)

    eye?.click()
    await vi.waitFor(() => expect(ignorePlugin).toHaveBeenCalledWith('0.6.1', '@huaqiu/dsh-kicad'))
    // The cached report keeps the item actionable until discovery runs again.
    await vi.waitFor(() => expect(check).toHaveBeenCalled())
  })

  it('offers 恢复提醒 on an ignored row instead of an install action', async () => {
    openUpdateView(
      fakeStore({
        ...reportWith(runtimeEntry(), false),
        items: [
          {
            name: '@huaqiu/dsh-kicad',
            currentVersion: '0.6.9',
            availableVersion: '0.6.14',
            state: 'ignored',
          },
        ],
      }),
      zh,
    )
    openDisclosure(zh.group.ignored)
    const row = pluginNode('@huaqiu/dsh-kicad')
    expect(row?.dataset.state).toBe('ignored')
    const restore = [...(row?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === zh.unignore,
    )
    restore?.click()
    await vi.waitFor(() => expect(unignorePlugin).toHaveBeenCalledWith('0.6.1', '@huaqiu/dsh-kicad'))
  })

  it('keeps the changelog behind 更新内容 and never in the initial DOM', () => {
    openUpdateView(fakeStore(oneItem()), zh)
    const card = pluginNode('@huaqiu/dsh-kicad')
    expect(card?.textContent).not.toContain('修复导出崩溃')
    const toggle = card?.querySelector<HTMLButtonElement>('[data-changes-toggle]')
    expect(toggle?.textContent).toContain(zh.ui.changesToggle)
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')

    toggle?.click()
    expect(pluginNode('@huaqiu/dsh-kicad')?.textContent).toContain('修复导出崩溃')
    expect(
      pluginNode('@huaqiu/dsh-kicad')
        ?.querySelector('[data-changes-toggle]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true')
  })

  it('exposes one 展开版本日志 control that opens every card drawer', () => {
    openUpdateView(fakeStore(oneItem()), zh)
    const expand = [...document.querySelectorAll<HTMLButtonElement>('.hqpu-sec-head button')].find(
      (b) => b.textContent === zh.ui.expandLogs,
    )
    expand?.click()
    expect(document.body.textContent).toContain('修复导出崩溃')
    expect(
      [...document.querySelectorAll<HTMLButtonElement>('.hqpu-sec-head button')].some(
        (b) => b.textContent === zh.ui.collapseLogs,
      ),
    ).toBe(true)
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
      zh,
    )
    const alert = document.querySelector('[data-group="runtime-alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.querySelector('.hqpu-alert--amber')).not.toBeNull()
    expect(alert?.textContent).toContain(zh.ui.rollbackTitle)
    expect(alert?.querySelector('code')?.textContent).toBe('POSTINSTALL_FAILED')
    // No diagnostic-log button — the plugin has no log-open affordance.
    expect(alert?.textContent).not.toContain('诊断日志')

    const dismiss = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === zh.ui.dismiss,
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
      zh,
    )
    const alert = document.querySelector('[data-group="runtime-alert"]')
    expect(alert?.textContent).toContain(zh.ui.failedTitle)
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
      zh,
    )
    const success = document.querySelector('[data-role="runtime-success"]')
    expect(success).not.toBeNull()
    expect(success?.textContent).toContain(zh.ui.successInline)
    expect(document.querySelector('[data-group="runtime-alert"]')).toBeNull()
  })
})

// ── The job log drawer ──────────────────────────────────────────────────────
/**
 * The log is a DRAWER now, not an inline block.
 *
 * Inline, a finished plugin-set install listed one row per component, so ~20
 * "ignored"/"skipped" lines sat above every actionable card. A failed job still
 * says so in the body (error code + retry + 查看日志); only the full component
 * list lives behind the header button.
 */
describe('job log drawer', () => {
  const logButton = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('[data-log-toggle]')
  const drawer = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-log-drawer]')

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

  it('stays closed until the header button is pressed, then lists every component', () => {
    openUpdateView(
      fakeStore(reportWith(runtimeEntry(), false), {
        recentJobs: () => [settledJob('done', { steps: steps(6) })],
      }),
      zh,
    )

    expect(drawer()?.hidden).toBe(true)
    expect(document.body.textContent).not.toContain('@huaqiu/dsh-plugin-1@0.6.14')
    expect(logButton()?.disabled).toBe(false)
    expect(logButton()?.getAttribute('aria-pressed')).toBe('false')
    expect(logButton()?.title).toBe(zh.ui.logShow)
    // The drawer is absolutely positioned, so the box it covers must be told
    // to keep a floor height — otherwise a short body squeezes it shut.
    expect(document.querySelector<HTMLElement>('.hqpu-main')?.dataset.logOpen).toBe('0')

    logButton()?.click()
    expect(drawer()?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('.hqpu-main')?.dataset.logOpen).toBe('1')
    expect(drawer()?.textContent).toContain('@huaqiu/dsh-plugin-1@0.6.14')
    expect(drawer()?.textContent).toContain(zh.ui.logTitle)
    expect(drawer()?.textContent).toContain(zh.job.resultDone)
    // The correlation id is reachable without opening a file.
    expect(drawer()?.textContent).toContain('uj_1793255677245_2fi1x0dltt')
    expect(logButton()?.getAttribute('aria-pressed')).toBe('true')
    expect(logButton()?.title).toBe(zh.ui.logHide)

    logButton()?.click()
    expect(drawer()?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('.hqpu-main')?.dataset.logOpen).toBe('0')
  })

  it('a failed job states the outcome in the body and offers the log', () => {
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
      zh,
    )

    // Body first: the error code and Retry never hide behind a drawer click.
    const banner = document.querySelector('[data-group="job-result"]')
    expect(banner?.textContent).toContain('CHECKSUM_MISMATCH')
    expect(banner?.textContent).toContain(zh.job.resultFailed)
    expect(drawer()?.hidden).toBe(true)

    const viewLog = [...(banner?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === zh.ui.viewLog,
    )
    viewLog?.click()
    expect(drawer()?.hidden).toBe(false)
    expect(drawer()?.textContent).toContain('CHECKSUM_MISMATCH')
  })

  it('a successful job adds no body banner at all', () => {
    openUpdateView(
      fakeStore(reportWith(runtimeEntry(), false), {
        recentJobs: () => [settledJob('done', { steps: steps(3) })],
      }),
      zh,
    )
    expect(document.querySelector('[data-group="job-result"]')).toBeNull()
  })

  it('copies the log id, and says so', async () => {
    const writeText = vi.fn(async (_id: string) => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    openUpdateView(
      fakeStore(reportWith(runtimeEntry(), false), {
        recentJobs: () => [settledJob('done', { steps: steps(1) })],
      }),
      zh,
    )
    logButton()?.click()
    document.querySelector<HTMLButtonElement>('[data-copy-log]')?.click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('uj_1793255677245_2fi1x0dltt'))
    await vi.waitFor(() => expect(document.body.textContent).toContain(zh.ui.logCopied))
  })

  it('sits between the sources and close actions in the header', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), false)), zh)

    const labels = [...document.querySelectorAll<HTMLButtonElement>('.hqpu-toolbar .hqpu-icon-btn')]
      .map((b) => b.title)
    const gear = labels.indexOf(zh.ui.gearTooltip)
    const log = labels.indexOf(zh.ui.logNone)
    const close = labels.indexOf(zh.close)
    expect(gear).toBeGreaterThanOrEqual(0)
    expect(log).toBe(gear + 1)
    expect(close).toBe(log + 1)
  })

  it('disables the toggle when no job has finished', () => {
    openUpdateView(fakeStore(reportWith(runtimeEntry(), false)), zh)

    expect(logButton()?.disabled).toBe(true)
    expect(logButton()?.title).toBe(zh.ui.logNone)
    expect(logButton()?.getAttribute('aria-pressed')).toBe('false')
  })

  it('disables the toggle while a job is running — the live view owns the body', () => {
    const running = settledJob('downloading')
    openUpdateView(
      fakeStore(reportWith(runtimeEntry(), false), {
        activeJob: () => running,
        recentJobs: () => [settledJob('done', { steps: steps(3) })],
      }),
      zh,
    )

    expect(document.querySelector('.hqpu-active')).not.toBeNull()
    expect(drawer()?.hidden).toBe(true)
    expect(logButton()?.disabled).toBe(true)
    expect(logButton()?.title).toBe(zh.ui.logBusy)
  })
})

// ── A job that stops reporting (re-attach) ──────────────────────────────────
/**
 * When the set being installed contains this very plugin, the DSH restart that
 * activates it takes the page's server away mid-job. The panel used to sit on a
 * progress bar frozen at 100 % on the final step forever.
 *
 * The fix has two halves, and both are asserted here: the server tells the
 * panel the job has stalled (`/activity.stalled`), and the panel stops claiming
 * progress — amber card, "confirming" note, a retry that re-reads the durable
 * state (which settles the job from the installed set).
 */
describe('stalled active job', () => {
  function restartingJob(overrides: Partial<UpdateJob> = {}): UpdateJob {
    return {
      id: 'uj_stalled',
      kind: 'plugin-set',
      targetVersion: '0.6.1',
      previousVersion: '0.6.0',
      startedAt: '2026-10-29T08:00:00.000Z',
      updatedAt: '2026-10-29T08:00:30.000Z',
      phase: 'restarting',
      progress: { percent: 100 },
      ...overrides,
    }
  }

  function updatable(): PluginUpdateReport {
    return {
      ...reportWith(runtimeEntry(), false),
      items: [
        { name: '@huaqiu/dsh-a', currentVersion: '0.6.0', availableVersion: '0.6.1', state: 'update' },
      ],
    }
  }

  const activeCard = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-group="active-job"] .hqpu-active')

  it('says it is confirming instead of animating a dead progress bar', () => {
    const fetchStatus = vi.fn(async () => undefined)
    openUpdateView(
      fakeStore(updatable(), {
        installing: () => true,
        activeJob: () => restartingJob(),
        stalled: () => true,
        phaseAgeMs: () => 120_000,
        fetchStatus,
      }),
      zh,
    )

    expect(activeCard()?.dataset.stalled).toBe('1')
    expect(activeCard()?.textContent).toContain(zh.ui.stalledNote)
    // The footer stops promising progress it cannot see.
    expect(document.querySelector('.hqpu-foot-meta')?.textContent).toContain(
      zh.ui.footerConfirming,
    )

    document.querySelector<HTMLButtonElement>('[data-stalled-recheck]')?.click()
    expect(fetchStatus).toHaveBeenCalledTimes(1)
  })

  it('keeps the running presentation while the server is still reporting', () => {
    openUpdateView(
      fakeStore(updatable(), {
        installing: () => true,
        activeJob: () => restartingJob({ phase: 'downloading', progress: { percent: 42 } }),
        stalled: () => false,
        phaseAgeMs: () => 900,
      }),
      zh,
    )

    expect(activeCard()?.hasAttribute('data-stalled')).toBe(false)
    expect(activeCard()?.textContent).not.toContain(zh.ui.stalledNote)
    expect(document.querySelector('.hqpu-foot-meta')?.textContent).toContain(zh.ui.footerBusy)
  })

  it('follows the accepted job id so its outcome survives a restart', async () => {
    // `GET /activity?job=<id>` is the only read that can answer "what happened
    // to my job" after the server that started it was replaced.
    const watchJob = vi.fn()
    installSet.mockResolvedValueOnce({ jobId: 'uj_42', state: 'accepted' } as never)
    openUpdateView(fakeStore(updatable(), { watchJob }), zh)

    cta()?.click()
    await vi.waitFor(() => {
      expect(watchJob).toHaveBeenCalledWith('uj_42')
    })
  })
})

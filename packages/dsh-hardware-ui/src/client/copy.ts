/**
 * User-visible copy for the Hardware Engineering UI, backed by DSH's locale
 * service.
 *
 * The dictionaries live in {@link ./locales.ts} in the same zh-source/en-checked
 * shape as `@huaqiu/dsh-huaqiu-about` and the other bilingual plugins. `apply`
 * registers them as namespace {@link HARDWARE_UI_NS} and binds a translator;
 * this module keeps the structured call-site API (nested groups, interpolation
 * as functions, string arrays) so nothing that renders needs to change when a
 * language switches. DSH dictionaries are flat `{name}` templates, so the
 * lookup and interpolation happen here, at read time.
 *
 * Reads are deliberately getters/functions, never captured constants: DSH's
 * renderer re-renders every slot outlet on a locale change, and `bind()` reads
 * the active locale at call time. Before a locale service is bound (unit tests,
 * a Host without one), the context-independent zh dictionary is used — the
 * behaviour this module had when it shipped zh-only.
 *
 * Wording rules that hold across both languages:
 *   - Commands, file names, extension names, and host paths are NOT translated
 *     (`kicad-cli`, `.kicad_pcb`, `Settings → Hardware Engineering`).
 *   - Host-origin text is never re-spelled here: {@link describeHostError} maps
 *     a stable host `code` to a sentence and appends the host detail only where
 *     it is technical output (kicad-cli stderr) rather than prose.
 *   - Interpolation is a function, not a `{placeholder}` at the call site: a
 *     function cannot be rendered with its placeholders unfilled by accident.
 *
 * Adding a language is mechanical: add its dictionary to `locales.ts` (checked
 * against the `zh` key union) and pass it to `locale.register` in `index.ts`.
 * No render site moves.
 *
 * @module @huaqiu/dsh-hardware-ui/client/copy
 */

import { en, zh, type HardwareCopyKey } from './locales.js'

/** DSH locale namespace owned by this plugin. */
export const HARDWARE_UI_NS = 'hardware-ui.huaqiu'

/** Fallback dictionary locale, used only until DSH's locale service is bound. */
export const LOCALE = 'zh_CN' as const

export type TranslateCopy = (key: HardwareCopyKey, params?: Record<string, unknown>) => string

/** The slice of DSH's client locale service this module needs. */
export interface CopyLocale {
  register(namespace: string, dictionaries: { readonly zh: typeof zh; readonly en: typeof en }): unknown
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
}

function interpolate(template: string, params?: Record<string, unknown>): string {
  return template.replace(/\{([A-Za-z][\w.-]*)\}/gu, (match, name: string) => {
    const value = params?.[name]
    return value === undefined ? match : String(value)
  })
}

const fallback: TranslateCopy = (key, params) => interpolate(zh[key], params)
let active: TranslateCopy = fallback

/** Read one dictionary entry through the active locale. */
export function translateCopy(key: HardwareCopyKey, params?: Record<string, unknown>): string {
  return active(key, params)
}

/**
 * Bind the copy facade to DSH's locale service.
 *
 * Call once from the client entry. The returned disposer restores the zh
 * fallback so an HMR reload cannot leave a stale binding behind.
 */
export function installCopyLocale(locale?: CopyLocale): () => void {
  if (locale === undefined) return () => {}
  const dispose = locale.register(HARDWARE_UI_NS, { zh, en })
  const bound = locale.bind(HARDWARE_UI_NS)
  const installed: TranslateCopy = (key, params) => bound(key, params)
  active = installed
  return () => {
    if (active === installed) active = fallback
    if (typeof dispose === 'function') dispose()
  }
}

export const COPY = {
  /** Product name — tab title, settings section label, wizard title. */
  product: {
    get name(): string { return translateCopy('product.name') },
  },

  /** The five persistent destinations, in `DESTINATIONS` order. */
  destinations: {
    get schematic(): string { return translateCopy('destinations.schematic') },
    get pcb(): string { return translateCopy('destinations.pcb') },
    get bom(): string { return translateCopy('destinations.bom') },
    get '3d'(): string { return translateCopy('destinations.3d') },
    get order(): string { return translateCopy('destinations.order') },
  },

  /** Navigation row + viewer strip. */
  viewer: {
    discoveryFailed: (detail: string): string => translateCopy('viewer.discoveryFailed', { detail }),
    installationFailed: (detail: string): string => translateCopy('viewer.installationFailed', { detail }),
    get noArtifact(): string { return translateCopy('viewer.noArtifact') },
    get kicadMissing(): string { return translateCopy('viewer.kicadMissing') },
    kicadVersion: (version: string): string => translateCopy('viewer.kicadVersion', { version }),
    get openInKicad(): string { return translateCopy('viewer.openInKicad') },
    openInKicadTitle: (path: string): string => translateCopy('viewer.openInKicadTitle', { path }),
    get selectArtifactFirst(): string { return translateCopy('viewer.selectArtifactFirst') },
    get configureKicad(): string { return translateCopy('viewer.configureKicad') },
    get selectProject(): string { return translateCopy('viewer.selectProject') },
    // aria labels / titles (screen-reader text is visible text too)
    get projectField(): string { return translateCopy('viewer.projectField') },
    get schematicSheetField(): string { return translateCopy('viewer.schematicSheetField') },
    get boardField(): string { return translateCopy('viewer.boardField') },
  },

  /**
   * Empty viewers. A placeholder names what is missing and then says how to get
   * it: the agent creates hardware, so the copy points there instead of stopping
   * at "not available". BOM is the one destination nobody creates directly — it
   * follows the schematic.
   */
  placeholder: {
    title: {
      get schematic(): string { return translateCopy('placeholder.title.schematic') },
      get pcb(): string { return translateCopy('placeholder.title.pcb') },
      get bom(): string { return translateCopy('placeholder.title.bom') },
      get '3d'(): string { return translateCopy('placeholder.title.3d') },
      get order(): string { return translateCopy('placeholder.title.order') },
    },
    /** One sentence: what the agent can create for this destination. */
    guide: {
      get schematic(): string { return translateCopy('placeholder.guide.schematic') },
      get pcb(): string { return translateCopy('placeholder.guide.pcb') },
      get bom(): string { return translateCopy('placeholder.guide.bom') },
      get '3d'(): string { return translateCopy('placeholder.guide.3d') },
      get order(): string { return translateCopy('placeholder.guide.order') },
    },
    /** Shown instead of a destination guide when no project was discovered. */
    get noProject(): string { return translateCopy('placeholder.noProject') },
  },

  /**
   * Discovery outcomes. These are the panel's OWN sentences for a host state —
   * the host also sends a `message`, but re-deriving it here keeps the copy in
   * one place and lets the count/cwd be woven in. {@link issueText} bridges the
   * two: known codes get translated, unknown ones fall back to the host text.
   */
  discovery: {
    selectionRequiredCount: (count: number): string => translateCopy('discovery.selectionRequiredCount', { count }),
    get selectionRequiredArtifact(): string { return translateCopy('discovery.selectionRequiredArtifact') },
    get noProjectSelected(): string { return translateCopy('discovery.noProjectSelected') },
    get noSchematic(): string { return translateCopy('discovery.noSchematic') },
    get noBoard(): string { return translateCopy('discovery.noBoard') },
    get noBoardToOrder(): string { return translateCopy('discovery.noBoardToOrder') },
    // Host `issue.code` vocabulary.
    noProject: (cwd: string): string => cwd === ''
      ? translateCopy('discovery.noProject')
      : translateCopy('discovery.noProjectIn', { cwd }),
    missingProject: (path: string): string => translateCopy('discovery.missingProject', { path }),
    badManifest: (detail: string): string => translateCopy('discovery.badManifest', { detail }),
  },

  /** schematic / pcb / 3d / bom stages. */
  preview: {
    get loading(): string { return translateCopy('preview.loading') },
    get kindSchematic(): string { return translateCopy('preview.kindSchematic') },
    get kindBoard(): string { return translateCopy('preview.kindBoard') },
    revision: (revision: string): string => translateCopy('preview.revision', { revision }),
    get ecadHint(): string { return translateCopy('preview.ecadHint') },
    ecadKindMismatch: (expected: string, actual: string): string =>
      translateCopy('preview.ecadKindMismatch', { expected, actual }),
    get ecadOverlay(): string { return translateCopy('preview.ecadOverlay') },
    get kicadNotConfigured(): string { return translateCopy('preview.kicadNotConfigured') },
    get glbExporting(): string { return translateCopy('preview.glbExporting') },
    get glbLoading(): string { return translateCopy('preview.glbLoading') },
    get glbCached(): string { return translateCopy('preview.glbCached') },
    get glbGenerated(): string { return translateCopy('preview.glbGenerated') },
    get glbOverlay(): string { return translateCopy('preview.glbOverlay') },
    get bomHint(): string { return translateCopy('preview.bomHint') },
    bomTitle: (lines: number): string => translateCopy('preview.bomTitle', { lines }),
    bomPlacements: (count: number): string => translateCopy('preview.bomPlacements', { count }),
    get bomColumns(): readonly string[] {
      return [
        translateCopy('preview.bomColumn.reference'),
        translateCopy('preview.bomColumn.quantity'),
        translateCopy('preview.bomColumn.value'),
        translateCopy('preview.bomColumn.footprint'),
        translateCopy('preview.bomColumn.notes'),
      ]
    },
  },

  /** Order Placing destination. */
  order: {
    get title(): string { return translateCopy('order.title') },
    get packaging(): string { return translateCopy('order.packaging') },
    get packageReady(): string { return translateCopy('order.packageReady') },
    get packagePending(): string { return translateCopy('order.packagePending') },
    get packageRunning(): string { return translateCopy('order.packageRunning') },
    get packageNotPrepared(): string { return translateCopy('order.packageNotPrepared') },
    get packageCard(): string { return translateCopy('order.packageCard') },
    packageFiles: (files: number, size: string): string => translateCopy('order.packageFiles', { files, size }),

    get pcbTitle(): string { return translateCopy('order.pcbTitle') },
    get pcbSubtitle(): string { return translateCopy('order.pcbSubtitle') },
    pcbSummary: (zip: string, files: number, size: string): string =>
      translateCopy('order.pcbSummary', { zip, files, size }),
    get pcbAction(): string { return translateCopy('order.pcbAction') },

    get smtTitle(): string { return translateCopy('order.smtTitle') },
    get smtSubtitle(): string { return translateCopy('order.smtSubtitle') },
    smtSummary: (placements: number, lines: number, size: string): string =>
      translateCopy('order.smtSummary', { placements, lines, size }),
    get smtAction(): string { return translateCopy('order.smtAction') },
    /** Kind name interpolated into the result sentences (not a standalone label). */
    get smtShort(): string { return translateCopy('order.smtShort') },

    get boardFile(): string { return translateCopy('order.boardFile') },
    get placements(): string { return translateCopy('order.placements') },
    get bomLines(): string { return translateCopy('order.bomLines') },
    get credential(): string { return translateCopy('order.credential') },
    get signedIn(): string { return translateCopy('order.signedIn') },
    get signedOut(): string { return translateCopy('order.signedOut') },

    get signInToOrder(): string { return translateCopy('order.signInToOrder') },
    get signInToOrderSmt(): string { return translateCopy('order.signInToOrderSmt') },
    get waitingForPackage(): string { return translateCopy('order.waitingForPackage') },
    get configureToPackage(): string { return translateCopy('order.configureToPackage') },
    get selectRootSchematic(): string { return translateCopy('order.selectRootSchematic') },

    // Board facts (values keep their units, which are not prose).
    get layers(): string { return translateCopy('order.layers') },
    layersValue: (layers: number): string => translateCopy('order.layersValue', { layers }),
    get outline(): string { return translateCopy('order.outline') },
    get thickness(): string { return translateCopy('order.thickness') },
    get minTrace(): string { return translateCopy('order.minTrace') },
    get minDrill(): string { return translateCopy('order.minDrill') },
    get outerCopper(): string { return translateCopy('order.outerCopper') },
    get defaultValue(): string { return translateCopy('order.defaultValue') },
    copperValue: (oz: number | string): string => translateCopy('order.copperValue', { oz }),

    get agentEntryPoints(): string { return translateCopy('order.agentEntryPoints') },
    get submitting(): string { return translateCopy('order.submitting') },

    get tabTitle(): string { return translateCopy('order.tabTitle') },
    tabOrder: (id: string): string => translateCopy('order.tabOrder', { id }),
    get tabMissing(): string { return translateCopy('order.tabMissing') },
    get tabAddressHint(): string { return translateCopy('order.tabAddressHint') },
    get openInSystemBrowser(): string { return translateCopy('order.openInSystemBrowser') },

    get resultTitlePcb(): string { return translateCopy('order.resultTitlePcb') },
    get resultTitleSmt(): string { return translateCopy('order.resultTitleSmt') },
    get resultLaunched(): string { return translateCopy('order.resultLaunched') },
    get resultReady(): string { return translateCopy('order.resultReady') },
    get resultNote(): string { return translateCopy('order.resultNote') },
    resultLaunchedMessage: (kind: string): string => translateCopy('order.resultLaunchedMessage', { kind }),
    resultReadyMessage: (kind: string): string => translateCopy('order.resultReadyMessage', { kind }),
    get openInBrowser(): string { return translateCopy('order.openInBrowser') },
    get opening(): string { return translateCopy('order.opening') },
    get copyUrl(): string { return translateCopy('order.copyUrl') },
    get copied(): string { return translateCopy('order.copied') },

    get confirmAria(): string { return translateCopy('order.confirmAria') },
    get confirmTitlePcb(): string { return translateCopy('order.confirmTitlePcb') },
    get confirmTitleSmt(): string { return translateCopy('order.confirmTitleSmt') },
    get confirmBody(): string { return translateCopy('order.confirmBody') },
    confirmZip: (zip: string, size: string): string => translateCopy('order.confirmZip', { zip, size }),
    confirmPositions: (size: string): string => translateCopy('order.confirmPositions', { size }),
    confirmBom: (size: string): string => translateCopy('order.confirmBom', { size }),
    confirmHost: (baseUrl: string | undefined): string =>
      baseUrl ?? translateCopy('order.confirmHostFallback'),
    get confirmAck(): string { return translateCopy('order.confirmAck') },
    get cancel(): string { return translateCopy('order.cancel') },
    get uploadAndOpen(): string { return translateCopy('order.uploadAndOpen') },
    get uploading(): string { return translateCopy('order.uploading') },

    get batch(): string { return translateCopy('order.batch') },
    batchUnits: (count: number): string => translateCopy('order.batchUnits', { count }),
    quoteBasis: (count: number): string => translateCopy('order.quoteBasis', { count }),
  },

  /** First-run setup wizard. */
  wizard: {
    /** Step titles, in order (also the dot-strip tooltips and the counter label). */
    get steps(): readonly string[] {
      return [
        translateCopy('wizard.steps.welcome'),
        translateCopy('wizard.steps.kicad'),
        translateCopy('wizard.steps.solidcraft'),
      ]
    },
    stepCounter: (index: number, total: number, label: string): string =>
      translateCopy('wizard.stepCounter', { index, total, label }),
    get aria(): string { return translateCopy('wizard.aria') },

    get welcomeTitle(): string { return translateCopy('wizard.welcomeTitle') },
    get welcomeKicker(): string { return translateCopy('wizard.welcomeKicker') },
    get welcomeLead(): string { return translateCopy('wizard.welcomeLead') },
    get welcomeUsesTitle(): string { return translateCopy('wizard.welcomeUsesTitle') },
    get welcomeUses(): string { return translateCopy('wizard.welcomeUses') },
    get welcomeLocal(): string { return translateCopy('wizard.welcomeLocal') },

    get kicadTitle(): string { return translateCopy('wizard.kicadTitle') },
    get kicadOptional(): string { return translateCopy('wizard.kicadOptional') },
    get kicadLead(): string { return translateCopy('wizard.kicadLead') },
    get kicadPlaceholder(): string { return translateCopy('wizard.kicadPlaceholder') },
    get kicadSkipHint(): string { return translateCopy('wizard.kicadSkipHint') },

    get solidcraftTitle(): string { return translateCopy('wizard.solidcraftTitle') },
    get solidcraftLead(): string { return translateCopy('wizard.solidcraftLead') },
    get solidcraftPlaceholder(): string { return translateCopy('wizard.solidcraftPlaceholder') },

    get skip(): string { return translateCopy('wizard.skip') },
    get back(): string { return translateCopy('wizard.back') },
    get next(): string { return translateCopy('wizard.next') },
    get finish(): string { return translateCopy('wizard.finish') },
    get saving(): string { return translateCopy('wizard.saving') },
    get footerNote(): string { return translateCopy('wizard.footerNote') },
  },

  /** Settings section (the two CAD installation roots). */
  settings: {
    get title(): string { return translateCopy('settings.title') },
    get lead(): string { return translateCopy('settings.lead') },
    get kicadTitle(): string { return translateCopy('settings.kicadTitle') },
    get kicadBlurb(): string { return translateCopy('settings.kicadBlurb') },
    get kicadPlaceholder(): string { return translateCopy('settings.kicadPlaceholder') },
    get solidcraftTitle(): string { return translateCopy('settings.solidcraftTitle') },
    get solidcraftBlurb(): string { return translateCopy('settings.solidcraftBlurb') },
    get solidcraftPlaceholder(): string { return translateCopy('settings.solidcraftPlaceholder') },
    pathField: (title: string): string => translateCopy('settings.pathField', { title }),
    get validate(): string { return translateCopy('settings.validate') },
    get validating(): string { return translateCopy('settings.validating') },
    get configured(): string { return translateCopy('settings.configured') },
    get notConfigured(): string { return translateCopy('settings.notConfigured') },
    get notDetected(): string { return translateCopy('settings.notDetected') },
    savedAndValidated: (application: string): string =>
      translateCopy('settings.savedAndValidated', { application }),
    savedButInvalid: (application: string, detail: string): string =>
      translateCopy('settings.savedButInvalid', { application, detail }),
    get hostSettingsUnavailable(): string { return translateCopy('settings.hostSettingsUnavailable') },
    hostRejected: (application: string): string => translateCopy('settings.hostRejected', { application }),
  },

  /**
   * Host error sentences, keyed by the stable `code` in the route envelope
   * (`packages/hardware-artifacts/src/routes.ts`). A code missing here is not a
   * bug in the UI: the host detail is then shown verbatim, which is the right
   * answer for an unmodelled failure.
   */
  errors: {
    get unauthorized(): string { return translateCopy('errors.unauthorized') },
    get forbidden(): string { return translateCopy('errors.forbidden') },
    get 'missing-artifact'(): string { return translateCopy('errors.missing-artifact') },
    get 'unsupported-artifact'(): string { return translateCopy('errors.unsupported-artifact') },
    get 'invalid-identity'(): string { return translateCopy('errors.invalid-identity') },
    get 'missing-executable'(): string { return translateCopy('errors.missing-executable') },
    get 'not-configured'(): string { return translateCopy('errors.not-configured') },
    get 'too-large'(): string { return translateCopy('errors.too-large') },
    get 'export-timeout'(): string { return translateCopy('errors.export-timeout') },
    get 'export-failed'(): string { return translateCopy('errors.export-failed') },
    get 'stale-revision'(): string { return translateCopy('errors.stale-revision') },
    get 'invalid-request'(): string { return translateCopy('errors.invalid-request') },
    get 'invalid-application'(): string { return translateCopy('errors.invalid-application') },
    get 'confirmation-required'(): string { return translateCopy('errors.confirmation-required') },
    get 'invalid-order-url'(): string { return translateCopy('errors.invalid-order-url') },
    get 'order-unreachable'(): string { return translateCopy('errors.order-unreachable') },
    get 'order-rejected'(): string { return translateCopy('errors.order-rejected') },
    get 'not-found'(): string { return translateCopy('errors.not-found') },
    get internal(): string { return translateCopy('errors.internal') },
  },
}

export type HardwareCopy = typeof COPY

/**
 * Codes whose host detail is a technical tail worth keeping next to the
 * translated sentence: kicad-cli stderr, an HTTP failure, a backend payload.
 * For the rest the detail merely restates the sentence in English.
 */
const KEEPS_DETAIL = new Set([
  'export-failed',
  'order-unreachable',
  'order-rejected',
  'invalid-order-url',
  'internal',
])

/**
 * One host error → one sentence in the active locale.
 *
 * `detail` is the host's own message. Unknown codes keep it untouched, so an
 * unmodelled failure still says something specific instead of collapsing into
 * a generic "出错了".
 */
export function describeHostError(code: string | undefined, detail: string): string {
  if (code === undefined) return detail
  const sentence = (COPY.errors as Record<string, string | undefined>)[code]
  if (sentence === undefined) return detail
  return KEEPS_DETAIL.has(code) && detail !== ''
    ? `${sentence}${translateCopy('error.detail', { detail })}`
    : sentence
}

/**
 * Translate one discovery `issue` without losing the host's specifics.
 *
 * The count and the workspace come from the discovery result, not from the
 * host sentence, so the wording does not depend on how the host phrased it.
 */
export function issueText(
  issue: { readonly code: string; readonly message: string },
  context: { readonly cwd?: string; readonly count?: number } = {},
): string {
  switch (issue.code) {
    case 'selection-required':
      return context.count !== undefined && context.count > 1
        ? COPY.discovery.selectionRequiredCount(context.count)
        : COPY.discovery.selectionRequiredArtifact
    case 'no-project':
      return COPY.discovery.noProject(context.cwd ?? '')
    case 'missing-project':
      // Host text is `${path} does not exist`; the path is the useful half.
      return COPY.discovery.missingProject(issue.message.replace(/\s+does not exist\s*$/u, ''))
    case 'bad-manifest':
      return COPY.discovery.badManifest(issue.message.replace(/^invalid \.hardware-engineering\.json:\s*/u, ''))
    default:
      return issue.message
  }
}

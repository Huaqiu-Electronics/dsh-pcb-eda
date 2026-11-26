/**
 * Public surface of the toolchain capability.
 * @module @huaqiu/hardware-artifacts/toolchain
 */
export {
  OFFICIAL_DOWNLOAD_PAGES,
  ToolchainManager,
  defaultManagedRoot,
  type BrowseOutcome,
  type ToolchainConfigPatch,
  type ToolchainManagerOptions,
  type ToolchainSettings,
  type ToolchainStatus,
  type ToolStatus,
  type ValidationOutcome,
} from './manager.js'
export {
  MANIFEST_SCHEMA_VERSION, MANIFEST_URL, fetchManifest, parseManifest,
  type ManifestEntry, type ManifestFailure, type ManifestResult, type ToolchainManifest,
} from './manifest.js'
export {
  candidateRoots, compareVersions, probeInstallation, validateCandidates,
  type CandidateOrigin, type CandidateRoot, type DiscoveryCandidate, type DiscoveryInternals,
  type ToolDiscovery,
} from './discovery.js'
export {
  ToolchainInstaller, expectedLayout,
  type InstallErrorCode, type InstallJobSnapshot, type InstallOutcome, type InstallPhase,
} from './install.js'
export {
  canonicalPath, executableCandidates, installRootFromExecutable, installationRootOf, label,
  normalizeVersion, resolveToolchain, sameRelease,
  type ToolchainId, type ToolchainResolution, type ToolchainSource,
} from './resolve.js'
export { commonDirectory, extractZip, readZipDirectory, safeEntrySegments, ZipError, type ZipDirectory } from './zip.js'
export { pickFile, TOOLCHAIN_FILTERS, type FileFilter, type PickFileResult } from './dialog.js'

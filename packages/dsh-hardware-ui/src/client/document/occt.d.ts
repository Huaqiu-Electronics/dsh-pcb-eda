/**
 * Ambient types for `occt-import-js` (OpenCascade STEP/IGES/BREP reader).
 *
 * The package ships the emscripten glue and the `.wasm` but no type
 * declarations, and its API is registered through embind at instantiation, so
 * these types describe what the module exposes *after* `ready` resolves — as
 * documented by the package README (`occt.ReadStepFile(buffer, params)`).
 *
 * @module @huaqiu/dsh-hardware-ui/client/document/occt
 */

declare module 'occt-import-js' {
  /** One tessellated solid: triangle soup plus an optional per-solid color. */
  export interface OcctMesh {
    readonly name?: string
    readonly color?: readonly number[]
    readonly attributes: {
      readonly position: { readonly array: readonly number[] }
      readonly normal?: { readonly array: readonly number[] }
    }
    readonly index?: { readonly array: readonly number[] }
  }

  /** Result of one import; `success` false means no geometry was produced. */
  export interface OcctImportResult {
    readonly success: boolean
    readonly root?: unknown
    readonly meshes: readonly OcctMesh[]
  }

  /** The instantiated module's import entry points. */
  export interface OcctModule {
    ReadStepFile(buffer: Uint8Array, params: Record<string, unknown> | null): OcctImportResult
    ReadIgesFile?(buffer: Uint8Array, params: Record<string, unknown> | null): OcctImportResult
    ReadBrepFile?(buffer: Uint8Array, params: Record<string, unknown> | null): OcctImportResult
  }

  /** Emscripten module overrides this package relies on. */
  export interface OcctModuleOptions {
    /** Complete `.wasm` bytes; supplying them keeps the module offline and path-independent. */
    wasmBinary?: ArrayBuffer
    /** Fallback used only when `wasmBinary` is absent. */
    locateFile?(path: string, prefix: string): string
    print?(text: string): void
    printErr?(text: string): void
  }

  /**
   * Instantiate the reader.
   * @param options - wasm source and logging hooks.
   * @returns the ready module.
   */
  export default function occtimportjs(options?: OcctModuleOptions): Promise<OcctModule>
}

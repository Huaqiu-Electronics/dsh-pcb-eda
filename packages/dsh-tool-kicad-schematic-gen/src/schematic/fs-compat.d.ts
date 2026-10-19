/** The KiCad bundled DSH exposes bounded byte reads; npm's rc.1 declarations predate it. */
import type { FsTarget } from '@deepseek-ai/dsh-fs'
declare module '@deepseek-ai/dsh-fs' {
  interface FileSystem {
    readBytes(target: FsTarget, signal: AbortSignal, maxBytes?: number): Promise<Uint8Array>
  }
}

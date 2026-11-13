/**
 * `@huaqiu/component-gen-server` — in-memory job store + generation runner.
 *
 * Jobs live in memory (no persistent queue). Each job is driven by the
 * injected generation backend and reports through SSE events. On a terminal
 * state the runner appends a history entry (generated / failed / cancelled).
 * The `needs_confirmation` phase is a PAUSE: the job reports the extracted
 * dimensions and waits — the app then starts a separate `generate-footprint`
 * job with the human-approved values (single-HIL: a footprint is generated
 * only from dimensions a human has seen).
 */
import type { ComponentGenBackend } from './backend.js'
import { newHistoryId, type HistoryStore } from './history.js'
import type { JobEvent, JobInput, JobKind, JobState, StartJobRequest, HistoryEntry } from './types.js'
import { randomUUID } from 'node:crypto'

export interface JobMeta {
  /** stored input thumbnail id (points into the history store's inputs/). */
  imageId?: string
}

interface JobRecord {
  state: JobState
  controller: AbortController
}

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>()
  private readonly listeners = new Map<string, Set<(e: JobEvent) => void>>()

  create(req: StartJobRequest, meta: JobMeta): JobState {
    const now = new Date().toISOString()
    const id = `job_${randomUUID().slice(0, 18)}`
    const state: JobState = {
      id,
      kind: req.kind,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    }
    this.jobs.set(id, { state, controller: new AbortController() })
    return state
  }

  get(id: string): JobState | undefined {
    return this.jobs.get(id)?.state
  }

  abort(id: string): boolean {
    const rec = this.jobs.get(id)
    if (!rec) return false
    rec.controller.abort()
    return true
  }

  signal(id: string): AbortSignal | undefined {
    return this.jobs.get(id)?.controller.signal
  }

  subscribe(id: string, cb: (e: JobEvent) => void): (() => void) | null {
    if (!this.jobs.has(id)) return null
    let set = this.listeners.get(id)
    if (!set) {
      set = new Set()
      this.listeners.set(id, set)
    }
    set.add(cb)
    return () => {
      set?.delete(cb)
      if (set && set.size === 0) this.listeners.delete(id)
    }
  }

  private emit(id: string, event: JobEvent): void {
    const set = this.listeners.get(id)
    if (!set) return
    for (const cb of [...set]) {
      try { cb(event) } catch { /* a bad subscriber must not strand the stream */ }
    }
  }

  /** Update job state (public — the runner writes progress/status). */
  update(id: string, patch: Partial<JobState>, event?: JobEvent): JobState {
    const rec = this.jobs.get(id)
    if (!rec) return patch as JobState
    rec.state = { ...rec.state, ...patch, updatedAt: new Date().toISOString() }
    if (event) this.emit(id, event)
    return rec.state
  }

  /** Update + emit the canonical event for a terminal state. */
  settle(id: string, patch: Partial<JobState>): JobState {
    const state = this.update(id, patch)
    const now = new Date().toISOString()
    if (state.status === 'completed') this.emit(id, { type: 'completed', job: state, at: now })
    else if (state.status === 'failed') this.emit(id, { type: 'failed', error: state.error ?? 'generation failed', result: state.result, at: now })
    else if (state.status === 'cancelled') this.emit(id, { type: 'cancelled', at: now })
    else if (state.status === 'needs_confirmation') {
      this.emit(id, {
        type: 'needs_confirmation',
        dimensions: state.dimensions ?? {},
        pkgType: state.pkgType ?? null,
        fileName: state.fileName ?? null,
        at: now,
      })
    }
    return state
  }

  remove(id: string): void {
    this.jobs.delete(id)
    this.listeners.delete(id)
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))
}

/** Map the tool-body `needs_auth` outcome to a job failure with the marker. */
function isNeedsAuth(result: Record<string, unknown> | undefined): boolean {
  return result?.status === 'needs_auth'
}

export interface RunOutcome {
  state: JobState
  /** whether a history entry was appended. */
  recorded: boolean
}

/**
 * Run one generation to a terminal state. Returns the final JobState.
 * History recording happens here so entry and state cannot drift.
 */
export async function runGeneration(
  store: JobStore,
  backend: ComponentGenBackend,
  history: HistoryStore,
  id: string,
  req: StartJobRequest,
  meta: JobMeta,
  onProgress?: (message: string) => void,
): Promise<RunOutcome> {
  if (!store.get(id)) return { state: { id, kind: req.kind, status: 'failed', error: 'job not found', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, recorded: false }
  const signal = store.signal(id)

  const progress = (message: string): void => {
    store.update(id, { status: 'running', progress: message })
    onProgress?.(message)
  }
  const exec = { signal }

  try {
    if (req.kind === 'symbol') {
      progress('正在生成 Symbol…')
      const result = await backend.generateSymbol(
        { imageDataUrl: req.input.imageDataUrl ?? '', instruction: req.input.instruction },
        exec,
      )
      if (isNeedsAuth(result)) return fail('needs_auth')
      const state = store.settle(id, { status: 'completed', result })
      await record(history, meta, req, state)
      return { state, recorded: true }
    }

    if (req.kind === 'extract-footprint') {
      progress('正在提取封装尺寸…')
      const result = await backend.extractFootprint(
        {
          imageDataUrl: req.input.imageDataUrl ?? '',
          packageType: req.input.packageType,
          instruction: req.input.instruction,
        },
        exec,
      )
      if (isNeedsAuth(result)) return fail('needs_auth')
      if (result.status === 'needs_confirmation') {
        const dims = result.dimensions && typeof result.dimensions === 'object' ? result.dimensions : {}
        const pkg = typeof result.pkgType === 'string' ? result.pkgType : (req.input.packageType ?? null)
        const fileName = typeof result.fileName === 'string' ? result.fileName : null
        const state = store.settle(id, {
          status: 'needs_confirmation',
          dimensions: dims as Record<string, unknown>,
          pkgType: pkg,
          fileName,
        })
        return { state, recorded: false }
      }
      if (result.status === 'cancelled') {
        const state = store.settle(id, { status: 'cancelled', result })
        await record(history, meta, req, state)
        return { state, recorded: true }
      }
      const state = store.settle(id, { status: 'completed', result })
      await record(history, meta, req, state)
      return { state, recorded: true }
    }

    // generate-footprint
    progress('正在生成封装…')
    const result = await backend.generateFootprint(
      {
        imageDataUrl: req.input.imageDataUrl,
        packageType: req.input.packageType ?? '',
        fileName: req.input.fileName,
        dimensions: req.input.dimensions ?? {},
      },
      exec,
    )
    if (isNeedsAuth(result)) return fail('needs_auth')
    if (result.status === 'cancelled') {
      const state = store.settle(id, { status: 'cancelled', result })
      await record(history, meta, req, state)
      return { state, recorded: true }
    }
    const state = store.settle(id, { status: 'completed', result })
    await record(history, meta, req, state)
    return { state, recorded: true }
  } catch (err) {
    if (isAbortError(err)) {
      const state = store.settle(id, { status: 'cancelled' })
      await record(history, meta, req, state).catch(() => {})
      return { state, recorded: true }
    }
    const message = String((err as Error)?.message || err)
    const state = store.settle(id, { status: 'failed', error: message })
    await record(history, meta, req, state).catch(() => {})
    return { state, recorded: true }
  }

  function fail(kind: 'needs_auth'): { state: JobState; recorded: boolean } {
    const state = store.settle(id, {
      status: 'failed',
      error: kind === 'needs_auth' ? 'Huaqiu EDA login required' : 'generation failed',
      result: { status: kind },
    })
    void record(history, meta, req, state).catch(() => {})
    return { state, recorded: true }
  }
}

/** Build + append a history entry for a terminal job state. */
async function record(
  history: HistoryStore,
  meta: JobMeta,
  req: StartJobRequest,
  state: JobState,
): Promise<void> {
  const kind: 'symbol' | 'footprint' = state.kind === 'symbol' ? 'symbol' : 'footprint'
  const status: HistoryEntry['status'] = state.status === 'completed' ? 'generated' : state.status === 'cancelled' ? 'cancelled' : 'failed'
  const result = state.result as Record<string, unknown> | undefined
  const artifact = result?.artifact && typeof result.artifact === 'object'
    ? result.artifact as { id?: unknown; filename?: unknown; size?: unknown; uri?: unknown }
    : null
  const entry: HistoryEntry = {
    id: newHistoryId(),
    kind,
    createdAt: state.updatedAt ?? state.createdAt,
    status,
    input: {
      ...(meta.imageId ? { imageId: meta.imageId } : {}),
      ...(req.input.instruction ? { instruction: req.input.instruction } : {}),
      ...(req.input.packageType ? { packageType: req.input.packageType } : {}),
      ...(req.input.dimensions && Object.keys(req.input.dimensions).length > 0 ? { dimensions: req.input.dimensions } : {}),
    },
    ...(req.input.edited && Object.keys(req.input.edited).length > 0 ? { edited: req.input.edited } : {}),
    ...(status === 'generated' && artifact?.id
      ? {
        result: {
          artifactId: String(artifact.id),
          filename: typeof artifact.filename === 'string' ? artifact.filename : (result?.filename as string | undefined) ?? `${kind}.kicad_${kind === 'symbol' ? 'sym' : 'mod'}`,
          ...(typeof result?.fileUrl === 'string' ? { fileUrl: result.fileUrl } : {}),
          ...(typeof artifact.size === 'number' ? { size: artifact.size } : {}),
          // Keep the placement channel alive across reopens: the HQ
          // Edge-resolvable URI captured by the generation tail.
          ...(typeof artifact.uri === 'string' && artifact.uri ? { uri: artifact.uri } : {}),
        },
      }
      : {}),
    ...(status === 'failed' && state.error ? { error: state.error } : {}),
  }
  await history.append(entry)
}

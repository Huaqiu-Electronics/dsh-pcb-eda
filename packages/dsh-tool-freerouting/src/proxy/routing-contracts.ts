export interface FreeroutingClientOptions {
  baseUrl: string;
  environmentHost: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  profileEmail: string;
  profileId: string;
  requestTimeoutMs: number;
}

export interface RouteParameters {
  drawtimeSec: number;
  fast: boolean;
  realtime: boolean;
  routeOnlyNets: string[];
  /** A restricted request must be acknowledged by the engine before starting. */
  requireNetFilter?: boolean;
}

export interface RouteHandlers {
  /** Called whenever the FreeRouting job state changes. */
  onState?: (state: string, percentage?: number) => void;
  /**
   * Called on every poll tick (not only on state changes) with the latest percentage,
   * state, and any live `statistics`, so the run can publish smooth realtime progress
   * instead of freezing between state transitions.
   */
  onProgress?: (progress: RouteProgress) => void;
  /** Called with each intermediate SES (base64) while the job is RUNNING. */
  onIntermediate?: (sesBase64: string) => Promise<void> | void;
}

/** One poll tick's worth of progress, forwarded through `RouteHandlers.onProgress`. */
export interface RouteProgress {
  percentage?: number;
  state: string;
  statistics?: Record<string, unknown>;
  /** Monotonic poll-tick counter, starting at 1 for the first observed status. */
  ticks: number;
}

export interface RouteOutcome {
  sesBase64: string;
  state: string;
  statistics?: Record<string, unknown>;
}

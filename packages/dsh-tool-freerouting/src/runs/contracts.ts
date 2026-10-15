import type { Agent } from '@deepseek-ai/dsh-agent';
import type { DesignReport } from './design-report.js';
import { routingRunText } from '../presentation/routing-copy.js';
import type { PreviewMeta, PreviewScene } from '../contracts/preview.js';

export type RoutingAlgorithm = 'route' | 'route-nets';

export interface RouteParameters {
  drawtimeSec: number;
  /** Refill existing copper zones after final import, independently of connectivity. */
  fillZonesAfterRoute: boolean;
  fast: boolean;
  realtime: boolean;
  /**
   * Nets to exclude from a whole-board run (e.g. GND, left for a copper pour/zone).
   * Only applied when `routeOnlyNets` is empty (whole-board scope); the server parses
   * the exported DSN's net list and routes the difference.
   */
  skipNets: string[];
  routeOnlyNets: string[];
}

export type RunState =
  'queued' | 'running' | 'repair_pending' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'expired';

export interface RunProgress {
  /** Distinct nets that have copper so far (from the latest intermediate session). */
  nets?: number;
  percentage?: number;
  /** Realtime intermediate sessions streamed back into KiCad so far. */
  refreshes?: number;
  /** Track segments counted in the latest intermediate session. */
  segments?: number;
  state: string;
  /** Vias counted in the latest intermediate session. */
  vias?: number;
  /** Live DRC violations from FreeRouting's status `statistics`, when reported. */
  violations?: number;
}

export interface RoutingResult {
  designReport?: DesignReport;
  repairAttempts?: number;
  zoneFill?: 'not_requested' | 'completed' | 'skipped' | 'failed' | 'cancelled';
  durationMs: number;
  imported: boolean;
  netCount: number;
  /** Imported tracks the Bridge reported as lying outside the board outline. */
  outsideBoard?: number;
  /** How many realtime intermediate sessions were streamed back while routing. */
  refreshes?: number;
  /** Confirmed connected target nets; omitted when connectivity is unknown. */
  routedNets?: number;
  statistics?: Record<string, unknown>;
  tracks: number;
  /** Target nets left unrouted, capped for payload size (net-level failures). */
  unroutedNetNames?: string[];
  /** Count of target nets left unrouted. */
  unroutedNets?: number;
  vias: number;
  /** DRC violations reported by FreeRouting, when available. */
  violations?: number;
  /** User-facing caveat (board-edge overflow, degraded realtime preview, …). */
  warning?: string;
  /** Reserved legacy upstream field; IPC does not create zones. */
  zonesCreated?: number;
  /** Copper zones filled after routing (only present when `fillZonesAfterRoute` was true). */
  zonesFilled?: number;
}

export interface RunArtifact {
  content: Uint8Array;
  contentType: 'text/plain; charset=utf-8' | 'application/json';
  filename: string;
}

export interface RunOutput extends RunArtifact {
  routing: RoutingResult;
}

export interface RunError {
  code: string;
  message: string;
  status: number;
}

export interface RunActivity {
  round: 1 | 2;
  events: { at: number; text: string; kind: 'step' | 'progress' }[];
  stageStartedAt: number;
  updatedAt: number;
  engineUpdatedAt?: number;
  remainingConnections?: number;
  preview?: { tracks: number; vias: number };
}

export interface RunRecord {
  activity?: RunActivity;
  algorithm: RoutingAlgorithm;
  createdAt: number;
  error?: RunError;
  expiresAt: number;
  id: string;
  jobId?: string;
  /** Rolling, user-visible Chinese log of the run's milestones (capped server-side). */
  log?: string[];
  output?: RunOutput;
  artifact?: RunArtifact;
  designReport?: DesignReport;
  reportArtifact?: RunArtifact;
  owner: Agent;
  ownerSessionId: string;
  parameters: RouteParameters;
  progress?: RunProgress;
  preview?: { meta: PreviewMeta; scene?: PreviewScene };
  state: RunState;
  token: string;
  updatedAt: number;
}

export interface RunStatusResponse {
  process?: {
    round: 1 | 2;
    events: { at: string; text: string; kind: 'step' | 'progress' }[];
    stage_started_at: string;
    updated_at: string;
    engine_updated_at?: string;
    remaining_connections?: number;
    preview?: { tracks: number; vias: number };
  };
  user_message: string;
  algorithm: RoutingAlgorithm;
  created_at: string;
  error?: RunError;
  expires_at: string;
  job_id?: string;
  log?: string[];
  output_name?: string;
  progress?: RunProgress;
  run_id: string;
  schema_version: 1;
  preview?: PreviewMeta;
  state: RunState;
  summary?: {
    duration_ms: number;
    imported: boolean;
    net_count: number;
    outside_board?: number;
    refreshes?: number;
    routed_nets?: number;
    statistics?: Record<string, unknown>;
    tracks: number;
    unrouted_net_names?: string[];
    unrouted_nets?: number;
    vias: number;
    violations?: number;
    warning?: string;
    zones_created?: number;
    zones_filled?: number;
    zone_fill?: RoutingResult['zoneFill'];
  };
  design_report?: DesignReport;
  report_name?: string;
  updated_at: string;
}

export function statusResponse(run: RunRecord): RunStatusResponse {
  const routing = run.output?.routing;
  return {
    user_message: routingRunText({ state: run.state, error: run.error, summary: routing }),
    algorithm: run.algorithm,
    created_at: new Date(run.createdAt).toISOString(),
    expires_at: new Date(run.expiresAt).toISOString(),
    run_id: run.id,
    schema_version: 1,
    ...(run.activity === undefined
      ? {}
      : {
          process: {
            round: run.activity.round,
            events: run.activity.events.map((event) => ({ ...event, at: new Date(event.at).toISOString() })),
            stage_started_at: new Date(run.activity.stageStartedAt).toISOString(),
            updated_at: new Date(run.activity.updatedAt).toISOString(),
            ...(run.activity.engineUpdatedAt === undefined
              ? {}
              : { engine_updated_at: new Date(run.activity.engineUpdatedAt).toISOString() }),
            ...(run.activity.remainingConnections === undefined
              ? {}
              : { remaining_connections: run.activity.remainingConnections }),
            ...(run.activity.preview === undefined ? {} : { preview: { ...run.activity.preview } }),
          },
        }),
    ...(run.preview === undefined ? {} : { preview: run.preview.meta }),
    state: run.state,
    ...(run.designReport === undefined ? {} : { design_report: run.designReport }),
    ...(run.reportArtifact === undefined ? {} : { report_name: run.reportArtifact.filename }),
    updated_at: new Date(run.updatedAt).toISOString(),
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.jobId === undefined ? {} : { job_id: run.jobId }),
    ...(run.log === undefined ? {} : { log: [...run.log] }),
    ...((run.output ?? run.artifact) === undefined ? {} : { output_name: (run.output ?? run.artifact)!.filename }),
    ...(run.progress === undefined ? {} : { progress: run.progress }),
    ...(routing === undefined
      ? {}
      : {
          summary: {
            duration_ms: routing.durationMs,
            imported: routing.imported,
            net_count: routing.netCount,
            ...(routing.outsideBoard === undefined ? {} : { outside_board: routing.outsideBoard }),
            ...(routing.refreshes === undefined ? {} : { refreshes: routing.refreshes }),
            ...(routing.routedNets === undefined ? {} : { routed_nets: routing.routedNets }),
            ...(routing.statistics === undefined ? {} : { statistics: routing.statistics }),
            tracks: routing.tracks,
            ...(routing.unroutedNetNames === undefined ? {} : { unrouted_net_names: [...routing.unroutedNetNames] }),
            ...(routing.unroutedNets === undefined ? {} : { unrouted_nets: routing.unroutedNets }),
            vias: routing.vias,
            ...(routing.violations === undefined ? {} : { violations: routing.violations }),
            ...(routing.warning === undefined ? {} : { warning: routing.warning }),
            ...(routing.zonesCreated === undefined ? {} : { zones_created: routing.zonesCreated }),
            ...(routing.zonesFilled === undefined ? {} : { zones_filled: routing.zonesFilled }),
            ...(routing.zoneFill === undefined ? {} : { zone_fill: routing.zoneFill }),
          },
        }),
  };
}

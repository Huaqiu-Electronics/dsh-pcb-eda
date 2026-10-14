import { configureRoutingSettings } from './routing-settings.js';
import { parseIdentifier, parseJobStatus } from './upstream-contracts.js';
import { UpstreamServiceError } from './upstream-errors.js';
import { EngineHttp } from './engine-http.js';
import { JobPoller, TERMINAL_STATES } from './job-poller.js';
import type { FreeroutingClientOptions, RouteParameters, RouteHandlers, RouteOutcome } from './routing-contracts.js';

/**
 * Server-side FreeRouting `/v1` client. Mirrors the proven flow from the Python
 * plugin (`freerouting_io/http.py`) and NextChat (`app/utils/freerouting-client.ts`):
 * session -> enqueue -> upload(base64) -> settings -> start -> poll -> output.
 *
 * Connects directly to the FreeRouting engine at `http://127.0.0.1:37864`.
 */
export class FreeroutingClient {
  private sessionId: string | undefined;
  private readonly unsettledJobs = new Set<string>();

  private readonly http: EngineHttp;
  private readonly poller: JobPoller;
  constructor(private readonly options: FreeroutingClientOptions) {
    this.http = new EngineHttp(options);
    this.poller = new JobPoller(this.http, options, (id) => this.cancel(id));
  }

  async checkStatus(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.http.request('GET', '/system/status', undefined, signal);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureSession(signal?: AbortSignal): Promise<string> {
    const list = await this.http.request('GET', '/sessions/list', undefined, signal);
    if (!Array.isArray(list) || !list.every((id) => typeof id === 'string')) {
      throw new UpstreamServiceError('FREEROUTING_SESSION_FAILED', 502, '无法确认布线引擎的连接状态');
    }
    if (this.sessionId !== undefined && list.includes(this.sessionId)) {
      return this.sessionId;
    }
    // A disappeared session proves that its engine-side jobs disappeared too.
    this.sessionId = undefined;
    this.unsettledJobs.clear();
    if (list.length) {
      this.sessionId = list[0];
      return this.sessionId!;
    }
    const created = parseIdentifier(await this.http.request('POST', '/sessions/create', {}, signal));
    const sessionId = created.id;

    this.sessionId = sessionId;
    return sessionId;
  }

  /**
   * Run one routing job to completion. `dsnBase64` is the Specctra DSN exported from
   * KiCad; `routeOnlyNets` empty means whole-board routing.
   */
  async route(
    filename: string,
    dsnBase64: string,
    parameters: RouteParameters,
    handlers: RouteHandlers,
    signal?: AbortSignal,
  ): Promise<RouteOutcome> {
    if (!(await this.checkStatus(signal))) {
      throw new UpstreamServiceError(
        'FREEROUTING_UNAVAILABLE',
        503,
        `FreeRouting service is not reachable at ${this.options.baseUrl}`,
      );
    }
    // 2.5 does not expose a verified routing-network filter. Never route a
    // broader scope than requested by sending an ignored historical setting.
    if (parameters.requireNetFilter) {
      throw new UpstreamServiceError(
        'NET_FILTER_UNSUPPORTED',
        400,
        '当前布线引擎不能可靠地只布指定网络或跳过部分网络，请使用不跳过网络的整板布线',
      );
    }
    const sessionId = await this.ensureSession(signal);
    await this.confirmIdle(signal);

    const enqueued = parseIdentifier(
      await this.http.request(
        'POST',
        '/jobs/enqueue',
        { name: filename, priority: 'NORMAL', session_id: sessionId },
        signal,
      ),
    );
    const jobId = enqueued.id;

    this.unsettledJobs.add(jobId);
    try {
      await this.http.request('POST', `/jobs/${jobId}/input`, { data: dsnBase64, filename }, signal);

      // A newly uploaded job contains only overrides. The pinned 2.5.0
      // settings endpoint resolves defaults, DSN rules and board-specific values.
      // Preserve that complete configuration when changing deadline or optimizer.
      const settings = configureRoutingSettings(
        await this.http.request('GET', `/jobs/${jobId}/settings`, undefined, signal),
        this.options.pollTimeoutMs,
        parameters.fast,
      );
      await this.http.request('POST', `/jobs/${jobId}/settings`, settings, signal);

      await this.http.request('PUT', `/jobs/${jobId}/start`, undefined, signal);
      const result = await this.poller.poll(jobId, parameters, handlers, signal);
      this.unsettledJobs.delete(jobId);
      return result;
    } catch (cause) {
      // A rejected native preview must also stop the engine; otherwise it keeps
      // routing after the editor task has failed and released its board lease.
      await this.cancel(jobId);
      throw cause;
    }
  }

  /** Check all sessions for this profile, including tasks left by another host. */
  async verifyEngineIdle(signal?: AbortSignal): Promise<void> {
    const sessions = await this.http.request('GET', '/sessions/list', undefined, signal);
    if (!Array.isArray(sessions) || !sessions.every((id) => typeof id === 'string')) {
      throw new UpstreamServiceError('ENGINE_TASK_UNCONFIRMED', 409, '无法确认旧计算是否停止，本次没有开始新的布线');
    }
    for (const session of sessions) {
      const jobs = await this.http.request('GET', `/jobs/list/${encodeURIComponent(session)}`, undefined, signal);
      if (!Array.isArray(jobs)) {
        throw new UpstreamServiceError('ENGINE_TASK_UNCONFIRMED', 409, '无法确认旧计算是否停止，本次没有开始新的布线');
      }
      for (const job of jobs) {
        const state = parseJobStatus(job);
        if (!TERMINAL_STATES.has(state.state)) {
          throw new UpstreamServiceError('ENGINE_TASK_UNCONFIRMED', 409, '引擎仍有上一轮计算，本次没有开始新的布线');
        }
      }
    }
  }

  private async confirmIdle(signal?: AbortSignal): Promise<void> {
    for (const id of this.unsettledJobs) {
      try {
        const status = parseJobStatus(await this.http.request('GET', `/jobs/${id}`, undefined, signal));
        if (TERMINAL_STATES.has(status.state)) {
          this.unsettledJobs.delete(id);
          continue;
        }
      } catch {
        signal?.throwIfAborted();
        throw new UpstreamServiceError(
          'ENGINE_TASK_UNCONFIRMED',
          409,
          '无法确认上一轮计算已停止，本次没有开始新的布线',
        );
      }
      throw new UpstreamServiceError('ENGINE_TASK_UNCONFIRMED', 409, '上一轮计算尚未停止，本次没有开始新的布线');
    }
  }

  /** Cancellation is not a stop confirmation. Keep uncertain jobs until a later verified terminal state. */
  async cancel(jobId: string): Promise<void> {
    try {
      await this.http.request('PUT', `/jobs/${jobId}/cancel`, undefined, undefined);
      await this.confirmIdle();
    } catch {
      // Cancelling is best effort; ignore failures.
    }
  }
}

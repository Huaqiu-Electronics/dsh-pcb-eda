import { waitForPoll } from './poll-wait.js';
import { Buffer } from 'node:buffer';
import type { EngineHttp } from './engine-http.js';
import type { FreeroutingClientOptions, RouteParameters, RouteHandlers, RouteOutcome } from './routing-contracts.js';
import { type JobStatus, type JobOutput, parseJobOutput, parseJobStatus } from './upstream-contracts.js';
import { UpstreamServiceError } from './upstream-errors.js';
export const TERMINAL_STATES = new Set(['COMPLETED', 'TIMED_OUT', 'CANCELLED', 'TERMINATED', 'INVALID']);
const MIN_INTERMEDIATE_BYTES = 100;

export class JobPoller {
  constructor(
    private readonly http: EngineHttp,
    private readonly options: FreeroutingClientOptions,
    private readonly cancelJob: (id: string) => Promise<void>,
  ) {
    if (
      !Number.isSafeInteger(options.pollTimeoutMs) ||
      options.pollTimeoutMs <= 0 ||
      !Number.isSafeInteger(options.pollIntervalMs) ||
      options.pollIntervalMs <= 0
    ) {
      throw new UpstreamServiceError('FREEROUTING_CONFIG_INVALID', 400, '布线等待期限和轮询间隔必须是有限的正整数');
    }
  }
  async poll(
    jobId: string,
    parameters: RouteParameters,
    handlers: RouteHandlers,
    signal?: AbortSignal,
  ): Promise<RouteOutcome> {
    const deadline = Date.now() + this.options.pollTimeoutMs;
    const drawIntervalMs = Math.max(1, parameters.drawtimeSec) * 1000;
    let lastState = '';
    let lastDrawAt = 0;
    let ticks = 0;

    while (true) {
      if (signal?.aborted) {
        await this.cancelJob(jobId);
        throw new UpstreamServiceError('RUN_CANCELLED', 499, 'The routing run was cancelled');
      }
      if (Date.now() >= deadline) {
        await this.cancelJob(jobId);
        throw new UpstreamServiceError(
          'FREEROUTING_TIMEOUT',
          504,
          `FreeRouting job did not finish within ${Math.round(this.options.pollTimeoutMs / 1000)}s`,
        );
      }

      const status: JobStatus = parseJobStatus(await this.http.request('GET', `/jobs/${jobId}`, undefined, signal));
      const state = status.state;
      const percentage = status.progress_percentage;
      ticks += 1;
      handlers.onProgress?.({
        ...(percentage === undefined ? {} : { percentage }),
        state,
        ...(status.statistics === undefined ? {} : { statistics: status.statistics }),
        ticks,
      });
      if (state !== lastState) {
        lastState = state;
        handlers.onState?.(state, percentage);
      }

      if (TERMINAL_STATES.has(state)) {
        if (state === 'TIMED_OUT') {
          throw new UpstreamServiceError(
            'FREEROUTING_TIMEOUT',
            504,
            'FreeRouting reached the configured routing deadline',
          );
        }
        if (state !== 'COMPLETED') {
          throw new UpstreamServiceError(
            'FREEROUTING_JOB_FAILED',
            502,
            `FreeRouting job ended in state ${state || 'UNKNOWN'}`,
          );
        }
        break;
      }

      // Await intermediate delivery so editor updates cannot overlap final import or cancellation.
      if (handlers.onIntermediate && state === 'RUNNING') {
        const now = Date.now();
        if (now - lastDrawAt >= drawIntervalMs) {
          lastDrawAt = now;
          const intermediate = await this.tryOutput(jobId, signal);
          if (intermediate !== undefined) {
            await handlers.onIntermediate?.(intermediate);
          }
        }
      }

      await waitForPoll(this.options.pollIntervalMs, signal);
    }

    const output: JobOutput = parseJobOutput(
      await this.http.request('GET', `/jobs/${jobId}/output`, undefined, signal),
    );
    const sesBase64 = output.data;
    if (sesBase64 === '') {
      throw new UpstreamServiceError(
        'FREEROUTING_EMPTY_OUTPUT',
        502,
        'FreeRouting completed but returned an empty SES output',
      );
    }
    return {
      sesBase64,
      state: 'COMPLETED',
      ...(output.statistics === undefined ? {} : { statistics: output.statistics }),
    };
  }
  private async tryOutput(jobId: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const snapshot = await this.http.request('GET', `/jobs/${jobId}/output`, undefined, signal);
      if (snapshot === undefined) {
        return undefined;
      }
      const output: JobOutput = parseJobOutput(snapshot);
      const sesBase64 = output.data;
      if (sesBase64 !== '' && Buffer.from(sesBase64, 'base64').length >= MIN_INTERMEDIATE_BYTES) {
        return sesBase64;
      }
    } catch (cause) {
      if (
        cause instanceof UpstreamServiceError &&
        (cause.code === 'RESOURCE_LIMIT' || cause.code === 'FREEROUTING_PROTOCOL_FAILED')
      ) {
        throw cause;
      }
      // No intermediate output yet; ignore and keep polling.
    }
    return undefined;
  }
}

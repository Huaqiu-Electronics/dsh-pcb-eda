import type { FreeroutingClientOptions } from './routing-contracts.js';
import { UpstreamServiceError } from './upstream-errors.js';
import { boundedResponse } from './bounded-response.js';
export class EngineHttp {
  constructor(private readonly options: FreeroutingClientOptions) {}
  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Freerouting-Profile-ID': this.options.profileId,
      'Freerouting-Profile-Email': this.options.profileEmail,
      'Freerouting-Environment-Host': this.options.environmentHost,
    };
  }
  private timeoutSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  }
  async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.options.baseUrl}/v1${path}`, {
      method,
      headers: this.headers(),
      signal: this.timeoutSignal(signal),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const text = await boundedResponse(response, 64 * 1024).catch(() => '');
      throw new UpstreamServiceError(
        'FREEROUTING_REQUEST_FAILED',
        response.status,
        `FreeRouting ${method} ${path} failed: ${response.status} ${text.slice(0, 200)}`,
      );
    }
    // The pinned 2.5.0 API uses 204 while its first snapshot is not ready.
    // Keep this distinct from a malformed 200 response containing an empty object.
    if (response.status === 204) {
      return undefined;
    }
    const raw = await boundedResponse(response);
    return raw.length > 0 ? JSON.parse(raw) : {};
  }
}

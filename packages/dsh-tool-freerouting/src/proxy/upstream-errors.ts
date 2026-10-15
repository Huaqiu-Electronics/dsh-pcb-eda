export class UpstreamServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'UpstreamServiceError';
  }
}

export function runError(cause: unknown): { code: string; message: string; status: number } {
  if (cause instanceof UpstreamServiceError) {
    return { code: cause.code, message: cause.message, status: cause.status };
  }
  if (
    cause instanceof Error &&
    'code' in cause &&
    'status' in cause &&
    typeof cause.code === 'string' &&
    typeof cause.status === 'number'
  ) {
    return { code: cause.code, status: cause.status, message: cause.message };
  }
  if (cause instanceof Error && cause.name === 'AbortError') {
    return { code: 'RUN_CANCELLED', message: 'The routing run was cancelled', status: 499 };
  }
  if (cause instanceof Error && cause.name === 'TimeoutError') {
    return {
      code: 'UPSTREAM_TIMEOUT',
      message: 'FreeRouting 或 KiCad IPC 请求超时',
      status: 504,
    };
  }
  const causeMessage = cause instanceof Error ? cause.message : `Unknown error: ${String(cause)}`;
  return {
    code: 'UPSTREAM_UNAVAILABLE',
    message: `FreeRouting 或 KiCad IPC 不可用：${causeMessage}`,
    status: 503,
  };
}

import { getStreamAsBuffer, MaxBufferError } from 'get-stream';
import { resourceLimits } from '../runs/resource-guard.js';
import { UpstreamServiceError } from './upstream-errors.js';

function oversizedResponse(): UpstreamServiceError {
  return new UpstreamServiceError('RESOURCE_LIMIT', 429, '布线结果超过当前保护上限，已停止处理并保留之前的可用结果');
}

export async function boundedResponse(response: Response, maxBytes = resourceLimits.responseBytes): Promise<string> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > maxBytes) {
    await response.body?.cancel();
    throw oversizedResponse();
  }
  if (!response.body) {
    return '';
  }
  try {
    // Buffer size is measured in bytes, including multi-byte UTF-8 characters.
    return (await getStreamAsBuffer(response.body, { maxBuffer: maxBytes })).toString('utf8');
  } catch (cause) {
    if (cause instanceof MaxBufferError) {
      throw oversizedResponse();
    }
    throw cause;
  }
}

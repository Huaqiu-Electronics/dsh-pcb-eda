import { previewPayloadSchema, type PreviewPayload } from '../contracts/preview.js';
import { statusSchema, type Capability, type RunStatus } from './model.js';

export class PresentationError extends Error {}

export function endpoint(capability: Capability, action: 'status' | 'output' | 'report' | 'preview'): string {
  return `${capability.routePrefix}/api/runs/${capability.runId}/${action}`;
}

export async function loadPreview(capability: Capability, signal: AbortSignal): Promise<PreviewPayload> {
  const response = await fetch(endpoint(capability, 'preview'), {
    signal,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${capability.token}` },
  });
  if (!response.ok) {
    throw new PresentationError('暂时无法读取路径预览');
  }
  const body = await response.text();
  if (body.length > 8_000_000) {
    throw new PresentationError('路径预览过大');
  }
  const parsed = previewPayloadSchema.safeParse(JSON.parse(body));
  if (!parsed.success || parsed.data.run_id !== capability.runId) {
    throw new PresentationError('路径预览与任务不匹配');
  }
  return parsed.data;
}

export async function loadStatus(capability: Capability, signal: AbortSignal): Promise<RunStatus> {
  const response = await fetch(endpoint(capability, 'status'), {
    signal,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${capability.token}` },
  });
  if (response.status === 401 || response.status === 404) {
    throw new PresentationError('这次布线结果已无法查看，可能已过期或应用已重新启动。');
  }
  if (!response.ok) {
    throw new PresentationError('暂时无法查看布线进度，请稍后重新读取状态。');
  }
  const parsed = statusSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new PresentationError('暂时无法正确读取布线进度，请稍后重新读取状态。');
  }
  const result = parsed.data;
  if (result.run_id !== capability.runId) {
    throw new PresentationError('布线进度与当前任务不匹配，请重新读取状态。');
  }
  return result;
}

export async function downloadResult(
  capability: Capability,
  signal: AbortSignal,
  action: 'output' | 'report' = 'output',
): Promise<Blob> {
  const response = await fetch(endpoint(capability, action), {
    signal,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${capability.token}` },
  });
  if (!response.ok) {
    throw new PresentationError('布线结果下载失败，结果可能已过期。请稍后再试。');
  }
  return response.blob();
}

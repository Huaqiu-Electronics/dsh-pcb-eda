import { useEffect, useState } from 'react';
import { active, type Capability, type RunStatus } from './model.js';
import { loadStatus, PresentationError } from './run-api.js';

export function useRunStatus(capability: Capability) {
  const [status, setStatus] = useState<RunStatus>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setError('');
    const poll = async () => {
      try {
        const next = await loadStatus(capability, controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        setStatus(next);
        if (active(next)) {
          timer = setTimeout(() => {
            poll();
          }, 1000);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof PresentationError
              ? cause.message
              : '暂时无法读取布线进度。请确认 DSH 仍在运行，再点击“重新读取状态”；这不代表布线已经停止。',
          );
        }
      }
    };
    poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [capability.runId, capability.token, capability.routePrefix, retry]);

  return { status, error, retryStatus: () => setRetry((value) => value + 1) };
}

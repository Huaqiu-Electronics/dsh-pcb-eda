import { useEffect, useRef, useState } from 'react';
import type { Capability } from './model.js';
import { downloadResult, PresentationError } from './run-api.js';

export function useRunDownload(capability: Capability) {
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const download = useRef<AbortController>();
  const objectUrls = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      download.current?.abort();
      for (const [url, timer] of urls) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, []);

  async function save(action: 'output' | 'report' = 'output'): Promise<void> {
    // Ref ownership closes the gap before React renders the disabled button.
    if (download.current) {
      return;
    }
    const controller = new AbortController();
    download.current = controller;
    setDownloading(true);
    setDownloadError('');
    try {
      const blob = await downloadResult(capability, controller.signal, action);
      if (controller.signal.aborted) {
        return;
      }
      const url = URL.createObjectURL(blob);
      const timer = setTimeout(() => {
        URL.revokeObjectURL(url);
        objectUrls.current.delete(url);
      }, 1000);
      objectUrls.current.set(url, timer);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = action === 'report' ? 'board-rule-report.json' : 'board.ses';
      anchor.click();
    } catch (cause) {
      if (!controller.signal.aborted) {
        setDownloadError(
          cause instanceof PresentationError ? cause.message : '暂时无法下载布线结果。请确认 DSH 仍在运行，稍后再试。',
        );
      }
    } finally {
      if (download.current === controller) {
        download.current = undefined;
      }
      if (!controller.signal.aborted) {
        setDownloading(false);
      }
    }
  }
  return { downloading, downloadError, save };
}

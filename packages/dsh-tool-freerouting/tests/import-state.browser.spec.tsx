import { createElement } from 'react';
import { render } from 'vitest-browser-react';
import { expect, it, vi } from 'vitest';
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
import { RoutingToolView } from '../src/client/run-card.js';

it('reports added copper while zone filling is still running, without waiting for the final summary', async () => {
  const runId = 'f6d913c5-793f-4bf3-a39d-1f6f02a4a272';
  const fetchMock = vi.fn(
    async (_url: string) =>
      new Response(
        JSON.stringify({
          run_id: runId,
          state: 'running',
          expires_at: '2026-10-11T00:00:00Z',
          progress: { state: '填充已有铺铜区域' },
          preview: {
            revision: 2,
            round: 1,
            state: 'unavailable',
            final: true,
            imported: true,
            updated_at: '2026-10-10T00:00:00Z',
          },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  const props = {
    toolName: 'pcb_route',
    block: {
      kind: 'tool-result',
      isError: false,
      content: [],
      meta: { card: 'pcb-freerouting-run', routePrefix: '/pcb', runId, token: 'a'.repeat(43) },
    },
  } as unknown as ToolCallViewProps;
  const view = await render(createElement(RoutingToolView, props));
  try {
    await expect.element(view.getByText('布线已添加到板子', { exact: false })).toBeVisible();
    expect(view.container.textContent).not.toContain('尚未添加到板子');
    expect(view.container.querySelector('svg')).toBeNull();
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith('/status'))).toBe(true);
  } finally {
    await view.unmount();
    vi.unstubAllGlobals();
  }
});

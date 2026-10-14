import { createElement } from 'react';
import { render, type RenderResult } from 'vitest-browser-react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
import { RoutingToolView } from '../src/client/run-card.js';

const runId = 'f6d913c5-793f-4bf3-a39d-1f6f02a4a272';
const meta = { card: 'pcb-freerouting-run', runId, routePrefix: '/pcb-freerouting', token: 'a'.repeat(43) };
const status = {
  run_id: runId,
  state: 'running',
  expires_at: '2026-10-11T00:00:00Z',
  preview: { revision: 1, round: 1, state: 'ready', final: false, updated_at: '2026-10-10T00:00:00Z' },
  progress: { state: '正在布线', percentage: 25 },
};
const fetchMock = vi.fn();
let view: RenderResult;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(async () => {
  await view.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function json(value: unknown) {
  return new Response(JSON.stringify(value));
}
async function mount() {
  const props = {
    toolName: 'pcb_route',
    block: { kind: 'tool-result', meta, isError: false, content: [] },
  } as unknown as ToolCallViewProps;
  view = await render(createElement(RoutingToolView, props));
}
it('shows routing progress without an SVG or separate preview request and displays the final board outcome', async () => {
  let completed = false;
  fetchMock.mockImplementation(async () =>
    json(completed ? { ...status, state: 'succeeded', summary: { imported: true, tracks: 3, vias: 1 } } : status),
  );
  await mount();
  await expect.element(view.getByRole('progressbar')).toHaveAttribute('value', '25');
  expect(view.container.querySelector('svg')).toBeNull();
  expect(fetchMock.mock.calls.every(([url]) => url.endsWith('/status'))).toBe(true);
  expect(view.container.textContent).not.toContain('尚未添加到板子');
  completed = true;
  await vi.advanceTimersByTimeAsync(1000);
  await expect.element(view.getByText('新增走线 3 段', { exact: false })).toBeVisible();
  const calls = fetchMock.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetchMock).toHaveBeenCalledTimes(calls);
});
it('stops pending status requests when the card is unmounted', async () => {
  fetchMock.mockImplementation(() => new Promise(() => {}));
  await mount();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
  await view.unmount();
  expect(signal.aborted).toBe(true);
});

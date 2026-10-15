import { createElement } from 'react';
import { render, type RenderResult } from 'vitest-browser-react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
import { RoutingToolView } from '../src/client/run-card.js';
import { capabilitySchema } from '../src/client/model.js';
import { loadStatus } from '../src/client/run-api.js';

const runId = 'f6d913c5-793f-4bf3-a39d-1f6f02a4a272';
const meta = { card: 'pcb-freerouting-run', runId, routePrefix: '/pcb-freerouting', token: 'a'.repeat(43) };
const status = {
  run_id: runId,
  state: 'running',
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  progress: { state: '布线中', percentage: 25 },
};
let view: RenderResult;
let container: HTMLElement;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(async () => {
  await view.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(metadata: unknown = meta) {
  // Fixtures model only the fields this view consumes; runtime/slot services are exercised by the real DSH smoke.
  const props = {
    toolName: 'pcb_route',
    block: { kind: 'tool-result', meta: metadata, isError: false, content: [] },
  } as unknown as ToolCallViewProps;
  view = await render(createElement(RoutingToolView, props));
  container = view.container;
}
function json(value: unknown, code = 200) {
  return new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json' } });
}

it('polls live progress then stops after final import, with bearer credentials kept out of the URL', async () => {
  fetchMock.mockResolvedValueOnce(json(status)).mockResolvedValueOnce(
    json({
      ...status,
      state: 'succeeded',
      output_name: 'board.ses',
      summary: { imported: true, tracks: 3, vias: 1, warning: '板子上没有已设置的铺铜区域，本次已跳过铺铜' },
    }),
  );
  await mount();
  await expect.element(view.getByText('布线中 · 25%')).toBeVisible();
  expect(container.querySelector('progress')?.getAttribute('value')).toBe('25');
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(url).toBe(`/pcb-freerouting/api/runs/${runId}/status`);
  expect(options.headers.Authorization).toBe(`Bearer ${meta.token}`);
  await vi.advanceTimersByTimeAsync(1000);
  await expect.element(view.getByText('新增走线 3 段', { exact: false })).toBeVisible();
  expect(container.textContent).toContain('尚未确认是否所有网络都已接通');
  expect(container.textContent).toContain('下载布线结果');
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('shows partial import and uncertain status without offering automatic rerouting', async () => {
  fetchMock.mockResolvedValueOnce(
    json({
      ...status,
      state: 'partial',
      summary: { imported: true, tracks: 3, vias: 1, warning: '新走线已添加到板子，但铺铜未完成' },
    }),
  );
  await mount();
  await expect.element(view.getByRole('status')).toHaveTextContent('布线结果已添加，仍有问题需要检查');
  fetchMock.mockResolvedValueOnce(
    json({
      ...status,
      state: 'failed',
      output_name: 'board.ses',
      error: { code: 'IMPORT_UNCERTAIN', message: '回导状态待确认' },
    }),
  );
  await view.unmount();
  await mount();
  await expect.element(view.getByText('请先检查目标板子', { exact: false })).toBeVisible();
  expect(container.textContent).toContain('下载布线结果');
  expect(container.textContent).not.toContain('板子未改变');
  expect(container.textContent).not.toContain('尚未添加到板子');
  expect(container.textContent).not.toContain('重新布线');
});

it('shows expiry as an error and manual status retry, never silently starts a new run', async () => {
  fetchMock.mockResolvedValueOnce(json({}, 401));
  await mount();
  await expect.element(view.getByRole('alert')).toHaveTextContent('可能已过期');
  expect(container.textContent).toContain('重新读取状态');
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('refuses malformed capabilities and mismatched status responses', async () => {
  await mount({ ...meta, routePrefix: '//other-host' });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(capabilitySchema.safeParse({ ...meta, routePrefix: '/pcb/../escape' }).success).toBe(false);
  fetchMock.mockResolvedValueOnce(json({ ...status, run_id: 'ca84d31a-20b0-4736-b65e-1f83f613c1b7' }));
  await expect(loadStatus(capabilitySchema.parse(meta), new AbortController().signal)).rejects.toThrow('不匹配');
});

it('aborts an outstanding status request when the card unmounts', async () => {
  fetchMock.mockImplementation(() => new Promise(() => {}));
  await mount();
  const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
  expect(signal.aborted).toBe(false);
  await view.unmount();
  expect(signal.aborted).toBe(true);
});

it('explains a rule violation in plain language and keeps software details collapsed', async () => {
  fetchMock.mockResolvedValueOnce(
    json({
      ...status,
      state: 'failed',
      output_name: 'board.ses',
      error: {
        code: 'DESIGN_RULE_VIOLATION',
        message: '新增铜未通过 KiCad 设计规则检查，已拒绝回导并保留 SES：clearance',
      },
    }),
  );
  await mount();
  await expect.element(view.getByText('新走线没有通过布线规则检查', { exact: false })).toBeVisible();
  await expect.element(view.getByText('错误代码：DESIGN_RULE_VIOLATION', { exact: false })).not.toBeVisible();
  expect(container.querySelector('details')?.open).toBe(false);
  container.querySelector('summary')!.click();
  await expect.element(view.getByText('错误代码：DESIGN_RULE_VIOLATION', { exact: false })).toBeVisible();
});

it('downloads retained SES through an authenticated request, including failed imports', async () => {
  fetchMock
    .mockResolvedValueOnce(
      json({
        ...status,
        state: 'failed',
        output_name: 'board.ses',
        error: { code: 'BOARD_CHANGED', message: '目标板子发生变化，已保留 SES' },
      }),
    )
    .mockResolvedValueOnce(new Response('(session fixture)'));
  const createUrl = vi.fn(() => 'blob:fixture');
  const revoke = vi.fn();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(createUrl);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await mount();
  await expect.element(view.getByRole('button', { name: '下载布线结果' })).toBeVisible();
  const button = [...container.querySelectorAll('button')].find((value) => value.textContent === '下载布线结果');
  expect(button).toBeDefined();
  button!.click();
  expect(fetchMock.mock.calls[1]?.[0]).toBe(`/pcb-freerouting/api/runs/${runId}/output`);
  expect(fetchMock.mock.calls[1]?.[1].headers.Authorization).toBe(`Bearer ${meta.token}`);
  await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  expect(createUrl).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(revoke).toHaveBeenCalledWith('blob:fixture');
});

it('keeps polling during agent repair and shows precise remaining conflicts after permissive import', async () => {
  fetchMock.mockResolvedValueOnce(json({ ...status, state: 'repair_pending' })).mockResolvedValueOnce(
    json({
      ...status,
      state: 'partial',
      report_name: 'board-rule-report.json',
      summary: { imported: true, tracks: 344, vias: 0, warning: '布线已添加，但仍有未解决的铜相碰或间距问题' },
      design_report: {
        count: 1,
        truncated: false,
        violations: [
          {
            type: 'clearance',
            description: '要求间距 0.2 mm，实际 0 mm',
            items: [{ description: 'Text I2C PROM on F.Cu', label: '铜文字「I2C PROM」', x: 166.37, y: 114.3 }],
          },
        ],
      },
    }),
  );
  await mount();
  await expect.element(view.getByRole('status')).toHaveTextContent('助手正在处理布线冲突');
  await vi.advanceTimersByTimeAsync(1000);
  await expect.element(view.getByText('布线已添加，但仍有未解决的铜相碰或间距问题', { exact: false })).toBeVisible();
  await expect.element(view.getByText('铜文字「I2C PROM」', { exact: false })).toBeVisible();
  await expect.element(view.getByText('走线或过孔与其他铜的距离不够')).toBeVisible();
  await expect.element(view.getByText('Text I2C PROM on F.Cu')).not.toBeVisible();
  expect(container.textContent).toContain('X 166.370 mm，Y 114.300 mm');
  await expect.element(view.getByRole('button', { name: '下载检查报告' })).toBeVisible();
  expect(container.querySelector('details')?.open).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('does not expose a raw network exception as the board result', async () => {
  fetchMock.mockRejectedValueOnce(new Error('IPC HTTP transport crashed at /internal/path'));
  await mount();
  await expect.element(view.getByRole('alert')).toHaveTextContent('这不代表布线已经停止');
  expect(container.textContent).not.toContain('/internal/path');
});

it('shows process steps without expanding diagnostic details, keeps preview provisional and never invents percentage', async () => {
  const at = new Date().toISOString();
  fetchMock
    .mockResolvedValueOnce(
      json({
        ...status,
        created_at: at,
        progress: { state: '第 1 轮：正在寻找连接路径' },
        process: {
          round: 1,
          stage_started_at: at,
          updated_at: at,
          preview: { tracks: 17, vias: 3 },
          events: [
            { at, kind: 'step', text: '使用快速模式，保留原有走线和过孔' },
            { at, kind: 'progress', text: '已显示过程走线；尚未完成最终检查' },
          ],
        },
      }),
    )
    .mockResolvedValueOnce(
      json({
        ...status,
        state: 'repair_pending',
        progress: { state: '等待自动处理布线冲突' },
        process: {
          round: 1,
          stage_started_at: at,
          updated_at: at,
          events: [
            { at, kind: 'step', text: '首轮发现 3 处走线离板边太近' },
            { at, kind: 'step', text: '过程走线已清理，等待自动处理' },
          ],
        },
      }),
    );
  await mount();
  await expect.element(view.getByText('使用快速模式，保留原有走线和过孔', { exact: false })).toBeVisible();
  await expect.element(view.getByText('KiCad 当前显示过程走线 17 段、过孔 3 个', { exact: false })).toBeVisible();
  expect(container.querySelector('progress')?.hasAttribute('value')).toBe(false);
  expect(container.querySelector('details')?.open).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  await expect.element(view.getByText('首轮发现 3 处走线离板边太近', { exact: false })).toBeVisible();
  expect(container.textContent).not.toContain('KiCad 当前显示过程走线');
  expect(container.textContent).not.toContain('已修复');
});

it('explains a minute without progress while continuing read-only status polling', async () => {
  const at = new Date().toISOString();
  fetchMock.mockImplementation(() =>
    json({
      ...status,
      progress: { state: '正在寻找连接路径' },
      process: {
        round: 1,
        stage_started_at: at,
        updated_at: at,
        engine_updated_at: at,
        events: [{ at, kind: 'step', text: '正在寻找连接路径' }],
      },
    }),
  );
  await mount();
  await vi.advanceTimersByTimeAsync(61000);
  await expect.element(view.getByText('没有新的阶段或数量变化', { exact: false })).toBeVisible();
  expect(container.textContent).toContain('不能据此确认任务卡住');
  expect(fetchMock.mock.calls.every(([url]) => url.endsWith('/status'))).toBe(true);
  await view.unmount();
  const calls = fetchMock.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetchMock).toHaveBeenCalledTimes(calls);
});

it('loads the independently bundled stylesheet with card-scoped layout and button sizing', async () => {
  fetchMock.mockResolvedValueOnce(json(status));
  await mount();
  await expect.element(view.getByText('布线中 · 25%')).toBeVisible();
  const card = container.querySelector<HTMLElement>('[data-freerouting-card]')!;
  expect(getComputedStyle(card).borderRadius).toBe('10px');
  expect(getComputedStyle(card.querySelector('header')!).display).toBe('flex');
  const sibling = document.createElement('button');
  container.append(sibling);
  try {
    expect(getComputedStyle(sibling).minHeight).not.toBe('44px');
  } finally {
    sibling.remove();
  }
});

it('admits one download for rapid repeated clicks and aborts it when the card unmounts', async () => {
  fetchMock
    .mockResolvedValueOnce(json({ ...status, state: 'succeeded', output_name: 'board.ses' }))
    .mockImplementationOnce(() => new Promise<Response>(() => {}));
  await mount();
  await expect.element(view.getByRole('button', { name: '下载布线结果' })).toBeVisible();
  const button = [...container.querySelectorAll('button')].find((value) => value.textContent === '下载布线结果')!;
  button.click();
  button.click();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const signal = fetchMock.mock.calls[1]![1].signal as AbortSignal;
  expect(signal.aborted).toBe(false);
  await view.unmount();
  expect(signal.aborted).toBe(true);
});

it('revokes a completed download URL on unmount without leaving its timer alive', async () => {
  fetchMock
    .mockResolvedValueOnce(json({ ...status, state: 'succeeded', output_name: 'board.ses' }))
    .mockResolvedValueOnce(new Response('(session fixture)'));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned-download');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await mount();
  await expect.element(view.getByRole('button', { name: '下载布线结果' })).toBeVisible();
  [...container.querySelectorAll('button')].find((value) => value.textContent === '下载布线结果')!.click();
  await vi.waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(revoke).not.toHaveBeenCalled();
  await view.unmount();
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:owned-download');
  await vi.advanceTimersByTimeAsync(2000);
  expect(revoke).toHaveBeenCalledOnce();
});

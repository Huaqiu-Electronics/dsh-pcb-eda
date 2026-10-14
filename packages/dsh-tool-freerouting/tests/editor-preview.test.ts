import { expect, it, vi } from 'vitest';
import { routeWithEditorPreview } from '../src/runs/editor-preview.js';
import type { IpcRun } from '../src/ipc/session.js';
import type { FreeroutingClient } from '../src/proxy/freerouting-client.js';
import type { RouteHandlers } from '../src/proxy/routing-contracts.js';
import { UpstreamServiceError } from '../src/proxy/upstream-errors.js';

const parameters = {
  realtime: true,
  drawtimeSec: 5,
  fast: false,
  skipNets: [],
  routeOnlyNets: ['GND'],
  fillZonesAfterRoute: false,
};
function harness() {
  const session = { previewSession: vi.fn(async () => ({ tracks: 2, vias: 1 })), clearPreview: vi.fn(async () => {}) };
  const client = {
    route: vi.fn(async (...args: unknown[]) => {
      const handlers = args[3] as RouteHandlers;
      await handlers.onIntermediate?.('c2Vz');
      await handlers.onIntermediate?.('c2Vz');
      return { sesBase64: 'ZmluYWw=', state: 'COMPLETED' };
    }),
  };
  const controller = new AbortController();
  const record = vi.fn(),
    retain = vi.fn();
  const route = () =>
    routeWithEditorPreview(
      client as unknown as FreeroutingClient,
      Buffer.from('dsn'),
      parameters,
      {},
      session as unknown as IpcRun,
      controller.signal,
      record,
      retain,
    );
  return { session, client, controller, route, retain };
}
it('waits for native preview, ignores duplicate SES and clears before returning the final result', async () => {
  const h = harness();
  const outcome = await h.route();
  expect(h.session.previewSession).toHaveBeenCalledTimes(1);
  expect(h.session.previewSession).toHaveBeenCalledWith(Buffer.from('ses'), ['GND'], h.controller.signal);
  expect(h.retain).toHaveBeenCalledWith(Buffer.from('ses'));
  expect(h.session.clearPreview).toHaveBeenCalledTimes(1);
  expect(outcome.sesBase64).toBe('ZmluYWw=');
});
it('clears copper after cancellation that arrives during an uninterruptible native update', async () => {
  const h = harness();
  h.session.previewSession.mockImplementation(async () => {
    h.controller.abort();
    return { tracks: 2, vias: 1 };
  });
  await expect(h.route()).rejects.toMatchObject({ name: 'AbortError' });
  expect(h.session.clearPreview).toHaveBeenCalledTimes(1);
});
it('does not return success if preview cleanup cannot be confirmed', async () => {
  const h = harness();
  h.session.clearPreview.mockRejectedValue(new UpstreamServiceError('IMPORT_UNCERTAIN', 409, '检查板子'));
  await expect(h.route()).rejects.toMatchObject({ code: 'IMPORT_UNCERTAIN' });
});

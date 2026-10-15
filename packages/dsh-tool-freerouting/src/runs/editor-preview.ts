import type { IpcRun } from '../ipc/session.js';
import type { FreeroutingClient } from '../proxy/freerouting-client.js';
import type { RouteHandlers, RouteParameters } from '../proxy/routing-contracts.js';

/** KiCad 10 displays committed copper only. Serialize previews and clear them
 * before final validation/import, cancellation, failure or the next repair round. */
export async function routeWithEditorPreview(
  client: FreeroutingClient,
  dsn: Buffer,
  parameters: RouteParameters,
  handlers: RouteHandlers,
  session: IpcRun,
  signal: AbortSignal,
  record: (message: string) => void,
  retain: (ses: Buffer) => void,
  onPreview?: (counts?: { tracks: number; vias: number }) => void,
) {
  let previous = '';
  try {
    const outcome = await client.route(
      'board.dsn',
      dsn.toString('base64'),
      parameters,
      {
        ...handlers,
        onIntermediate: async (encoded) => {
          await handlers.onIntermediate?.(encoded);
          if (!parameters.realtime || encoded === previous) {
            return;
          }
          signal.throwIfAborted();
          const ses = Buffer.from(encoded, 'base64');
          retain(ses);
          const shown = await session.previewSession(ses, parameters.routeOnlyNets, signal);
          previous = encoded;
          onPreview?.({ tracks: shown.tracks, vias: shown.vias });
          record(
            shown.displayWarning ?? `KiCad 已显示本轮过程走线 ${shown.tracks} 段、过孔 ${shown.vias} 个，结果仍会变化`,
          );
          signal.throwIfAborted();
        },
      },
      signal,
    );
    // Keep the final downloadable result even if clearing editor previews fails.
    if (parameters.realtime) {
      retain(Buffer.from(outcome.sesBase64, 'base64'));
    }
    return outcome;
  } finally {
    if (parameters.realtime) {
      await session.clearPreview();
      onPreview?.();
    }
  }
}

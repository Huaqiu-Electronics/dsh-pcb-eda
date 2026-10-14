import { z } from 'zod';
import { computeCommand } from '../runs/compute-client.js';
import { UpstreamServiceError } from '../proxy/upstream-errors.js';

export async function confirmBoard(
  python: string,
  paths: { lease: string; marker: string; confirmation: string },
): Promise<void> {
  const result = await computeCommand(
    python,
    { command: 'confirm-board', paths },
    z.object({
      ok: z.boolean(),
      code: z.string().optional(),
      message: z.string().optional(),
    }),
  );
  if (!result.ok) {
    throw new UpstreamServiceError(result.code ?? 'BOARD_CONFIRM_FAILED', 409, result.message ?? '标记未解除');
  }
}

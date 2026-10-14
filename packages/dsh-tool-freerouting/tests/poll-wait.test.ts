import { expect, it } from 'vitest';
import { waitForPoll } from '../src/proxy/poll-wait.js';

it('wakes a pending polling delay so the caller can perform cancellation cleanup', async () => {
  const controller = new AbortController();
  const pending = waitForPoll(60_000, controller.signal);
  controller.abort(new Error('editor closed'));
  await expect(pending).resolves.toBeUndefined();
});

it('does not start a polling delay for an already-cancelled run', async () => {
  await expect(waitForPoll(60_000, AbortSignal.abort())).resolves.toBeUndefined();
});

import { setTimeout } from 'node:timers/promises';

/** Wake the caller on cancellation so it can stop its owned engine job first. */
export async function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await setTimeout(ms, undefined, { signal });
  } catch (cause) {
    if (!(signal?.aborted && cause instanceof Error && cause.name === 'AbortError')) {
      throw cause;
    }
  }
}

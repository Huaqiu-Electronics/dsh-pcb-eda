import type { ChildProcess } from 'node:child_process';
const helpers = new Map<string, Set<Promise<void>>>();
export const activeHelperPids = new Set<number>();
export function hasAnyPendingHelpers(): boolean {
  return [...helpers.values()].some((pending) => pending.size);
}
export function hasPendingHelpers(clientName: string): boolean {
  return !!helpers.get(clientName)?.size;
}
export async function waitForHelpers(clientName: string): Promise<void> {
  await Promise.allSettled([...(helpers.get(clientName) ?? [])]);
}

/** Registration stays alive after a watchdog reports uncertainty, until actual exit. */
export function trackHelper(child: ChildProcess, clientName: string): void {
  if (child.pid) {
    activeHelperPids.add(child.pid);
  }
  child.once('close', () => {
    if (child.pid) {
      activeHelperPids.delete(child.pid);
    }
  });
  if (!clientName) {
    return;
  }
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const pending = helpers.get(clientName) ?? new Set<Promise<void>>();
  pending.add(closed);
  helpers.set(clientName, pending);
  closed.then(() => {
    pending.delete(closed);
    if (!pending.size) {
      helpers.delete(clientName);
    }
  });
}

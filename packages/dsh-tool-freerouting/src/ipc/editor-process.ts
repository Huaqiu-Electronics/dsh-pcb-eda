import { inspectProcesses } from './process-identity.js';

export type EditorState = 'alive' | 'closed' | 'unknown';

/** Match the named-pipe PID and FILETIME; busy IPC is never evidence of editor exit. */
export async function editorProcessState(instance: string, python: string): Promise<EditorState> {
  const parts = /^(\d+):([\da-f]+):([\da-f]+)$/i.exec(instance);
  if (!parts) {
    return 'unknown';
  }
  const pid = Number(parts[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffffffff) {
    return 'unknown';
  }
  const high = BigInt(`0x${parts[2]}`),
    low = BigInt(`0x${parts[3]}`);
  if (high > 0xffffffffn || low > 0xffffffffn) {
    return 'unknown';
  }
  const birth = ((high << 32n) | low).toString();
  try {
    const [identity] = await inspectProcesses(python, [{ pid, birth }]);
    return identity?.state ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

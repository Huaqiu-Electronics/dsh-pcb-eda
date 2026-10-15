import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';

import type { RunRecord } from '../runs/contracts.js';
import { routingRunText, routingErrorText } from '../presentation/routing-copy.js';

export const openObject = { type: 'object', additionalProperties: true } as const;

export function render(_args: unknown, value: JsonValue) {
  const output = value as Record<string, JsonValue>;
  // Capabilities belong to presentation metadata, not the assistant's prose.
  const text = JSON.stringify(
    {
      user_message: output.user_message ?? output.message,
      control: { run_id: output.run_id, state: output.state },
    },
    null,
    2,
  );
  return [{ type: 'text' as const, text }];
}

/** Keep the original error as a cause for diagnosis; only domain-based copy reaches the assistant. */
export async function explainToolFailure<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    const code =
      typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
        ? cause.code
        : 'UNKNOWN_ERROR';
    // Duplicate-request diagnostics retain the existing run identifier required by the tool contract.
    const control = code === 'BOARD_RUN_ACTIVE' && cause instanceof Error ? `\n已有任务详情：${cause.message}` : '';
    throw new Error(routingErrorText({ code }) + control, { cause });
  }
}

export function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) {
    throw new Error('请在 DSH 对话中发起布线');
  }
  return agent;
}

export function createdRunOutput(run: RunRecord, routePrefix: string, title: string) {
  return {
    user_message: routingRunText({ state: run.state, error: run.error, summary: run.output?.routing }),
    algorithm: run.algorithm,
    capability_token: run.token,
    expires_at: new Date(run.expiresAt).toISOString(),
    run_id: run.id,
    schema_version: 1,
    state: run.state,
    status_endpoint: `${routePrefix}/api/runs/${run.id}/status`,
    title,
  };
}

export function runMeta(value: JsonValue, routePrefix: string): JsonValue {
  const run = value as Record<string, JsonValue>;
  return {
    algorithm: run.algorithm ?? '',
    card: 'pcb-freerouting-run',
    routePrefix,
    runId: run.run_id ?? '',
    state: run.state ?? '',
    title: run.title ?? '',
    token: run.capability_token ?? '',
  };
}

export function normalizedNets(nets: string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const net of nets ?? []) {
    const value = net.trim();
    if (value !== '') {
      normalized.add(value);
    }
  }
  return [...normalized];
}

export function integerInRange(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

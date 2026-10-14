import { defineTool } from '@deepseek-ai/dsh-tools';
import type { RunService } from '../runs/run-service.js';
import type { RunStore } from '../runs/run-store.js';
import { createdRunOutput, explainToolFailure, openObject, render, requireAgent, runMeta } from './presentation.js';

/** Continue the locked task; this is not a new routing operation or an import-only override. */
export function createRepairRouteTool(runs: RunStore, service: RunService, routePrefix: string) {
  return defineTool({
    name: 'pcb_repair_route',
    description:
      'Continue an existing repair_pending routing task automatically, without asking the user. Read its conflict report, add copper-text avoidance to offline routing data, and reroute exactly once. Default avoids all board copper text; optional IDs select original copper text to avoid. Original board content stays unchanged until final tracks/vias are added. Remaining DRC violations are allowed and reported. Board changes, invalid geometry, failed checks and failed creation still stop the task. Never call pcb_route again for this task.',
    parameters: {
      run_id: { type: 'string', description: 'The existing repair_pending routing run_id' },
      avoid_object_ids: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional original board copper-text UUIDs from the report. Omit to avoid all copper text. Never use generated track UUIDs.',
      },
    },
    output: { schema: openObject, render, presentationMeta: (_args, value) => runMeta(value, routePrefix) },
    async execute(args, exec) {
      if (!args.run_id) {
        throw new Error('缺少要继续处理的布线任务');
      }
      const owner = requireAgent(exec.agent);
      const run = runs.require(args.run_id);
      if (run.ownerSessionId !== owner.id) {
        throw new Error('无法处理其他会话的布线任务');
      }
      return explainToolFailure(async () => {
        await service.repair(run, args.avoid_object_ids, exec.signal);
        return createdRunOutput(run, routePrefix, '自动处理布线冲突');
      });
    },
    presentCall: () => ({ card: 'generic', title: '自动处理布线冲突', kind: 'execute' }),
  });
}

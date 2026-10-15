import { defineTool } from '@deepseek-ai/dsh-tools';
import type { RunService } from '../runs/run-service.js';
import type { RunStore } from '../runs/run-store.js';
import { explainToolFailure, openObject, render, requireAgent } from './presentation.js';
import { routingRunText } from '../presentation/routing-copy.js';

export function createCancelRouteTool(runs: RunStore, service: RunService) {
  return defineTool({
    name: 'pcb_cancel_route',
    description:
      'Cancel this session’s existing routing task, including repair_pending. Before import cancellation stops immediately. During import wait for commit or rollback; already committed tracks remain. Read the final task status before claiming the board is unchanged.',
    parameters: { run_id: { type: 'string', description: 'Existing routing run_id from this session' } },
    output: { schema: openObject, render },
    async execute(args, exec) {
      if (!args.run_id) {
        throw new Error('缺少要取消的布线任务');
      }
      const run = runs.require(args.run_id);
      if (run.ownerSessionId !== requireAgent(exec.agent).id) {
        throw new Error('无法取消其他会话的布线任务');
      }
      return explainToolFailure(async () => {
        await service.cancel(run);
        return {
          run_id: run.id,
          state: run.state,
          user_message:
            run.state === 'running'
              ? '已收到取消请求。请等待最终结果，再确认是否已经添加走线，不要强行关闭 KiCad。'
              : routingRunText({ state: run.state, error: run.error, summary: run.output?.routing }),
        };
      });
    },
    presentCall: () => ({ card: 'generic', title: '取消自动布线', kind: 'execute' }),
  });
}

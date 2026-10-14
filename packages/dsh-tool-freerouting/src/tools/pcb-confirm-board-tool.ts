import { defineTool } from '@deepseek-ai/dsh-tools';
import type { RunService } from '../runs/run-service.js';
import { explainToolFailure, openObject, render } from './presentation.js';

export function createConfirmBoardTool(service: RunService) {
  return defineTool({
    name: 'pcb_confirm_board_checked',
    description:
      'Clear a persistent uncertain-import marker ONLY after the human explicitly confirms they have inspected the selected KiCad PCB. Never infer confirmation or call this automatically. Does not recover or import SES.',
    parameters: {
      confirmed: { type: 'boolean', description: 'Human explicitly confirmed they inspected the current target board' },
    },
    output: { schema: openObject, render },
    async execute(args) {
      if (args.confirmed !== true) {
        throw new Error('需要用户明确确认已经检查目标板子');
      }
      return explainToolFailure(async () => {
        const target = await service.acknowledge();
        return {
          board_path: target.boardPath,
          user_message: '已按你的检查确认解除暂停。没有重新添加走线，也没有保存文件。',
        };
      });
    },
    presentCall: () => ({ card: 'generic', title: '确认已检查板子', kind: 'execute' }),
  });
}

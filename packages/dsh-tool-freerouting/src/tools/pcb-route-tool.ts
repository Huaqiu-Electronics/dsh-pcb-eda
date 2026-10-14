import type { ResolvedConfig } from '../config.js';
import { defineTool } from '@deepseek-ai/dsh-tools';

import type { RunService } from '../runs/run-service.js';
import type { RunStore } from '../runs/run-store.js';
import {
  createdRunOutput,
  explainToolFailure,
  normalizedNets,
  openObject,
  render,
  requireAgent,
  runMeta,
} from './presentation.js';

export function createRouteTool(
  runs: RunStore,
  runService: RunService,
  routePrefix: string,
  settings: Pick<ResolvedConfig, 'realtime' | 'drawtimeSec'> = { realtime: true, drawtimeSec: 5 },
) {
  return defineTool({
    name: 'pcb_route',
    description:
      '对 KiCad 当前打开的板子进行整板自动布线，保留原有走线和过孔。后台运行并显示进度，过程中可在 KiCad 查看走线变化，完成后确认最终结果，不自动保存。发现规则问题时自动处理并重新布线一次；仍有问题也添加结果并明确说明。无需选择或上传文件。',
    parameters: {
      fast: {
        type: 'boolean',
        description:
          'Use the faster routing algorithm (set true for speed, false for higher quality; default is quality)',
        default: false,
      },
      skip_nets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact net names to skip explicitly; default skips no nets. Skipped nets require later handling.',
        default: [],
      },
      fill_zones: {
        type: 'boolean',
        description:
          'After final import, refill existing zones only. No zones are created. Fill failure retains imported copper. Default true.',
        default: true,
      },
    },
    output: {
      schema: openObject,
      render,
      presentationMeta: (_args, value) => runMeta(value, routePrefix),
    },
    async execute(args, exec) {
      return explainToolFailure(async () => {
        const run = runs.create(
          'route',
          {
            drawtimeSec: settings.drawtimeSec,
            fast: args.fast ?? false,
            fillZonesAfterRoute: args.fill_zones ?? true,
            realtime: settings.realtime,
            routeOnlyNets: [],
            skipNets: normalizedNets(args.skip_nets ?? []),
          },
          requireAgent(exec.agent),
        );
        await runService.start(run, exec.signal);
        return createdRunOutput(run, routePrefix, '整板自动布线');
      });
    },
    presentCall: () => ({ card: 'generic', title: '整板自动布线', kind: 'execute' }),
  });
}

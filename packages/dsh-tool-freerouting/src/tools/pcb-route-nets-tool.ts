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

export function createRouteNetsTool(
  runs: RunStore,
  runService: RunService,
  routePrefix: string,
  settings: Pick<ResolvedConfig, 'realtime' | 'drawtimeSec'> = { realtime: true, drawtimeSec: 5 },
) {
  return defineTool({
    name: 'pcb_route_nets',
    description:
      '只对 KiCad 当前板子中指定的网络自动布线，保留原有走线和过孔，显示进度，过程中可在 KiCad 查看走线变化，完成后确认最终结果，不自动保存。至少提供一个准确的网络名称。发现规则问题时自动处理并重新布线一次；仍有问题也添加结果并明确说明。',
    parameters: {
      nets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact net names to route; at least one is required',
      },
      fast: {
        type: 'boolean',
        description:
          'Use the faster routing algorithm (set true for speed, false for higher quality; default is quality)',
        default: false,
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
      const routeOnlyNets = normalizedNets(args.nets);
      if (routeOnlyNets.length === 0) {
        throw new Error('请至少指定一个需要布线的网络名称');
      }
      return explainToolFailure(async () => {
        const run = runs.create(
          'route-nets',
          {
            drawtimeSec: settings.drawtimeSec,
            fast: args.fast ?? false,
            fillZonesAfterRoute: args.fill_zones ?? true,
            realtime: settings.realtime,
            routeOnlyNets,
            skipNets: [],
          },
          requireAgent(exec.agent),
        );
        await runService.start(run, exec.signal);
        return createdRunOutput(run, routePrefix, '指定网络自动布线');
      });
    },
    presentCall: () => ({ card: 'generic', title: '指定网络自动布线', kind: 'execute' }),
  });
}

import type { ResolvedConfig } from '../config.js';
import type { Context } from '@deepseek-ai/cordis';

import type { RunService } from '../runs/run-service.js';
import type { RunStore } from '../runs/run-store.js';
import { createRouteNetsTool } from './pcb-route-nets-tool.js';
import { createRouteTool } from './pcb-route-tool.js';
import { createConfirmBoardTool } from './pcb-confirm-board-tool.js';
import { createRepairRouteTool } from './pcb-repair-route-tool.js';
import { createCancelRouteTool } from './pcb-cancel-route-tool.js';

export function registerFreeroutingTools(
  ctx: Context,
  runs: RunStore,
  runService: RunService,
  routePrefix: string,
  settings: Pick<ResolvedConfig, 'realtime' | 'drawtimeSec'>,
): Array<() => void> {
  return [
    ctx.tools.register(createConfirmBoardTool(runService)),
    ctx.tools.register(createRepairRouteTool(runs, runService, routePrefix)),
    ctx.tools.register(createCancelRouteTool(runs, runService)),
    ctx.tools.register(createRouteTool(runs, runService, routePrefix, settings)),
    ctx.tools.register(createRouteNetsTool(runs, runService, routePrefix, settings)),
  ];
}

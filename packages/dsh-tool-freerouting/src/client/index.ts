import type {} from '@deepseek-ai/dsh-client-ui-tool/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';

import type { Context } from '@deepseek-ai/cordis';

import { RoutingToolView } from './run-card.js';

export const inject = ['slots'] as const;
export function apply(ctx: Context): void {
  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'pcb_route' }, RoutingToolView);
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'pcb_route_nets' }, RoutingToolView);
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'pcb_repair_route' }, RoutingToolView);
  });
}

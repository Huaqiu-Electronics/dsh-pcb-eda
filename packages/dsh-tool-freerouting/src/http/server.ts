import { getRequestListener } from '@hono/node-server';

import type { RunStore } from '../runs/run-store.js';
import { createRunHttpApp } from './app.js';

export function createRunHttpRuntime(runs: RunStore, routePrefix: string) {
  const app = createRunHttpApp(runs, routePrefix);
  return { handler: getRequestListener(app.fetch) };
}

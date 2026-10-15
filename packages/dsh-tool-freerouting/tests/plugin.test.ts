import { expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { apply } from '../src/index.js';

it('rejects a self-contained configuration error during plugin loading', async () => {
  const ctx = { tools: { register: vi.fn() } } as unknown as Context;
  await expect(apply(ctx, { routePrefix: 'invalid' })).rejects.toThrow('routePrefix');
  expect(ctx.tools.register).not.toHaveBeenCalled();
});

it('releases its HTTP prefix when Cordis unloads and remounts the plugin', async () => {
  const ctx = new Context();
  const routes = new Set<string>();
  Object.assign(ctx, {
    webServer: {
      register: (route: { path: string }) => {
        if (routes.has(route.path)) {
          throw new Error(`duplicate prefix route ${route.path}`);
        }
        routes.add(route.path);
        return () => routes.delete(route.path);
      },
    },
    systemPrompt: { section: () => () => {} },
    tools: { register: () => () => {} },
    jobs: {},
  });
  try {
    for (let reload = 0; reload < 2; reload += 1) {
      const fiber = await ctx.plugin(async (child) => apply(child));
      // Cordis ACTIVE; not merely an HTTP handler left after FAILED setup.
      expect(fiber.state).toBe(2);
      expect(routes.has('/pcb-freerouting')).toBe(true);
      await fiber.dispose();
      expect(routes.size).toBe(0);
    }
  } finally {
    await ctx.fiber.dispose();
  }
});

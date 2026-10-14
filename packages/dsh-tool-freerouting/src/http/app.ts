import { Hono } from 'hono';

import type { RunRecord } from '../runs/contracts.js';
import { statusResponse } from '../runs/contracts.js';
import { type RunStore, RunStoreError } from '../runs/run-store.js';

type RunHttpEnvironment = {
  Variables: { run: RunRecord };
};

function bearer(value: string | undefined): string | undefined {
  return value?.startsWith('Bearer ') ? value.slice(7) : undefined;
}

function attachment(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Read-only run API. Routing is started by the DSH tool (server-side), so the browser
 * only polls status and downloads the finished SES; there is no upload endpoint.
 */
export function createRunHttpApp(runs: RunStore, routePrefix: string): Hono<RunHttpEnvironment> {
  const app = new Hono<RunHttpEnvironment>();
  const runPath = `${routePrefix}/api/runs/:runId`;

  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    context.header('X-Content-Type-Options', 'nosniff');
    if (context.req.header('sec-fetch-site') === 'cross-site') {
      return context.json(
        { error: { code: 'CROSS_SITE_REQUEST', message: 'Cross-site requests are not allowed' } },
        403,
      );
    }
    await next();
  });

  app.use(`${runPath}/*`, async (context, next) => {
    const runId = context.req.param('runId') ?? '';
    const run = runs.authorize(runId, bearer(context.req.header('authorization')) ?? '');
    if (run === undefined) {
      return context.json(
        {
          error: {
            code: 'INVALID_CAPABILITY',
            message: 'The run capability is invalid or expired',
          },
        },
        401,
      );
    }
    context.set('run', run);
    await next();
  });

  app.get(`${runPath}/status`, (context) =>
    context.json(statusResponse(runs.require(context.req.param('runId') ?? ''))),
  );

  app.get(`${runPath}/output`, (context) => {
    const run = runs.require(context.req.param('runId') ?? '');
    const output = run.output ?? run.artifact;
    if (output === undefined) {
      return context.json({ error: { code: 'RUN_NOT_COMPLETED', message: 'The run has no completed output' } }, 409);
    }
    context.header('Content-Disposition', attachment(output.filename));
    context.header('Content-Type', output.contentType);
    return context.body(Uint8Array.from(output.content).buffer);
  });

  app.get(`${runPath}/preview`, (context) => {
    const run = context.get('run');
    if (run.preview?.meta.state !== 'ready' || !run.preview.scene) {
      return context.json({ error: { code: 'PREVIEW_UNAVAILABLE', message: '路径预览尚不可用' } }, 409);
    }
    return context.json({ run_id: run.id, revision: run.preview.meta.revision, scene: run.preview.scene });
  });

  app.get(`${runPath}/report`, (context) => {
    const report = context.get('run').reportArtifact;
    if (!report) {
      return context.json({ error: { code: 'REPORT_UNAVAILABLE', message: '检查报告尚未生成' } }, 409);
    }
    context.header('Content-Disposition', attachment(report.filename));
    context.header('Content-Type', report.contentType);
    return context.body(Uint8Array.from(report.content).buffer);
  });

  app.all(`${runPath}/*`, (context) =>
    context.json({ error: { code: 'UNKNOWN_ACTION', message: 'Unknown PCB FreeRouting action' } }, 404),
  );
  app.notFound((context) =>
    context.json({ error: { code: 'UNKNOWN_ROUTE', message: 'Unknown PCB FreeRouting route' } }, 404),
  );
  app.onError((error, context) => {
    if (error instanceof RunStoreError) {
      return context.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    return context.json(
      {
        error: {
          code: 'PLUGIN_REQUEST_FAILED',
          message: error instanceof Error ? error.message : 'The plugin request failed',
        },
      },
      503,
    );
  });
  return app;
}

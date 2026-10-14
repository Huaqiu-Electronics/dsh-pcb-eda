import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-jobs';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';

import type { Config } from './config.js';
import { resolveConfig } from './config.js';
import { createRunHttpRuntime } from './http/server.js';
import { FreeroutingClient } from './proxy/freerouting-client.js';
import { KicadIpcClient } from './ipc/client.js';
import { FreeroutingLauncher } from './runs/launcher.js';
import { RunService } from './runs/run-service.js';
import { RunStore } from './runs/run-store.js';
import { FREEROUTING_PROMPT } from './system-prompt.js';
import { registerFreeroutingTools } from './tools/register-tools.js';
import { EditorLifecycle } from './runs/editor-lifecycle.js';
import { editorProcessState } from './ipc/editor-process.js';
import { ResourceGuard } from './runs/resource-guard.js';

/** KiCad IPC uses one-shot helpers. FreeRouting runs as the existing local HTTP engine. */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const resolved = resolveConfig(config);

  const runs = new RunStore(resolved);
  const freerouting = new FreeroutingClient({
    baseUrl: resolved.freeroutingBaseUrl,
    environmentHost: resolved.environmentHost,
    pollIntervalMs: resolved.pollIntervalMs,
    pollTimeoutMs: resolved.pollTimeoutMs,
    profileEmail: resolved.profileEmail,
    profileId: resolved.profileId,
    requestTimeoutMs: resolved.requestTimeoutMs,
  });
  const ipc = new KicadIpcClient({
    kicadPythonPath: resolved.kicadPythonPath,
    kicadApiSocket: resolved.kicadApiSocket,
    stateDirectory: resolved.ipcStateDirectory,
    onCleanupError: (message) => ctx.logger.warn(message),
    requestTimeoutMs: resolved.requestTimeoutMs,
  });
  const launcher = new FreeroutingLauncher({
    autoLaunch: resolved.autoLaunchFreerouting,
    kicadPythonPath: resolved.kicadPythonPath,
    baseUrl: resolved.freeroutingBaseUrl,
    launchTimeoutMs: resolved.freeroutingLaunchTimeoutMs,
    pollIntervalMs: resolved.pollIntervalMs,
    probe: (signal) => freerouting.checkStatus(signal),
    verifyIdle: (signal) => freerouting.verifyEngineIdle(signal),
  });
  const editors: EditorLifecycle = new EditorLifecycle({
    probe: (instance) => editorProcessState(instance, ipc.pythonExecutable()),
    onClosed: (runIds) => runService.editorClosed(runIds),
    shutdown: () => launcher.shutdown(),
    onError: (message) => ctx.logger.warn(message),
  });
  const runService = new RunService(
    ctx,
    runs,
    freerouting,
    ipc,
    launcher,
    editors,
    new ResourceGuard(() => ipc.pythonExecutable()),
  );
  const http = createRunHttpRuntime(runs, resolved.routePrefix);

  // WebServer registrations return a disposer but are not context-owned effects.
  // Bind the route to the plugin so reloads and failed setup release the prefix.
  const disposeHttp = ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: resolved.routePrefix,
        handler: http.handler,
      }),
    'pcb-freerouting: HTTP route',
  );
  ctx.systemPrompt.section({
    name: 'tool:pcb-freerouting',
    order: 130,
    text: FREEROUTING_PROMPT,
  });
  const disposeTools = registerFreeroutingTools(ctx, runs, runService, resolved.routePrefix, resolved);

  ctx.logger.info(`PCB FreeRouting service: ${resolved.freeroutingBaseUrl} (KiCad 10 IPC)`);

  return async () => {
    disposeHttp();
    for (const dispose of disposeTools.reverse()) {
      dispose();
    }
    try {
      await runService.dispose();
    } finally {
      runs.dispose();
      await launcher.shutdown();
    }
  };
}

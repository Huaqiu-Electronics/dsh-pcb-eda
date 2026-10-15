import { waitForPoll } from '../proxy/poll-wait.js';
import { getBundledPaths, hasBundledResources } from './bundled-paths.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';

import { UpstreamServiceError } from '../proxy/upstream-errors.js';
import { prepareBundledRuntime } from './bundled-runtime.js';
import { EngineProcess } from './engine-process.js';
import { pythonPath } from '../ipc/python-runtime.js';

/**
 * FreeRouting service launcher with bundled JRE.
 *
 * The JRE and FreeRouting JAR are bundled in the `bundled/` directory,
 * eliminating dependency on KiCad installation or system Java.
 *
 * Startup arguments are derived from the original Freerouting.cfg:
 *   - `--gui.enabled=false`
 *   - `--api_server.enabled=true`
 *   - `--api_server.http_allowed=true`
 *   - `--api_server.endpoints=http://127.0.0.1:37864`
 *   - `-Xmx2G` (JVM heap limit)
 */

export interface FreeroutingLauncherOptions {
  /** When false the launcher never spawns anything; a down service is just reported. */
  autoLaunch: boolean;
  kicadPythonPath?: string;
  /** FreeRouting base URL (e.g. `http://127.0.0.1:37864`), for messages only. */
  baseUrl: string;
  /** How long to wait for the service to come up after spawning. */
  launchTimeoutMs: number;
  /** Polling interval while waiting for the freshly launched service to come up. */
  pollIntervalMs: number;
  /** Liveness probe for `:37864` — wired to `FreeroutingClient.checkStatus`. */
  probe: (signal?: AbortSignal) => Promise<boolean>;
  verifyIdle?: (signal?: AbortSignal) => Promise<void>;
}

/**
 * Launcher for the bundled FreeRouting service.
 *
 * Uses the bundled JRE to start the FreeRouting JAR directly,
 * without any dependency on KiCad or system Java.
 */
export class FreeroutingLauncher {
  private launchInFlight: Promise<void> | undefined;
  private engine?: EngineProcess;
  private launchController?: AbortController;
  private stopping?: Promise<void>;

  constructor(private readonly options: FreeroutingLauncherOptions) {}

  get pid(): number | undefined {
    return this.engine?.pid;
  }

  /**
   * Ensures the FreeRouting service is up before a routing run.
   * If the service is already running, returns immediately.
   * Otherwise, spawns the bundled JRE + JAR and waits for readiness.
   */
  async ensureUp(record: (message: string) => void, signal?: AbortSignal): Promise<void> {
    await this.stopping;
    signal?.throwIfAborted();
    // 1. Check if service is already running
    if (await this.options.probe(signal)) {
      await this.options.verifyIdle?.(signal);
      return;
    }

    if (this.engine && (await this.engine.isAlive())) {
      throw new UpstreamServiceError('ENGINE_TASK_UNCONFIRMED', 409, '保留的引擎尚未恢复响应，本次没有启动第二个引擎');
    }
    if (!this.options.autoLaunch) {
      throw new UpstreamServiceError(
        'FREEROUTING_UNAVAILABLE',
        503,
        `FreeRouting service is not reachable at ${this.options.baseUrl} (auto-launch disabled)`,
      );
    }

    // 2. Deduplicate concurrent launches
    await this.stopping;
    signal?.throwIfAborted();
    if (this.launchInFlight === undefined) {
      const controller = new AbortController();
      this.launchController = controller;
      this.launchInFlight = this.launch(record, controller.signal).finally(() => {
        this.launchInFlight = undefined;
        if (this.launchController === controller) {
          this.launchController = undefined;
        }
      });
    }
    await this.launchInFlight;
    signal?.throwIfAborted();
  }

  private async launch(record: (message: string) => void, signal?: AbortSignal): Promise<void> {
    // 3. Check bundled resources
    if (!hasBundledResources()) {
      const { javaExe, jarPath } = getBundledPaths();
      throw new UpstreamServiceError(
        'FREEROUTING_UNAVAILABLE',
        503,
        `FreeRouting bundled resources missing:\n` +
          `  java.exe: ${existsSync(javaExe) ? 'found' : 'MISSING'} (${javaExe})\n` +
          `  freerouting.jar: ${existsSync(jarPath) ? 'found' : 'MISSING'} (${jarPath})\n` +
          `  JRE lib/jvm.cfg and lib/modules must both be present.\n` +
          `Please reinstall the plugin.`,
      );
    }

    const bundled = getBundledPaths();
    record('正在启动 FreeRouting 服务（内置 JRE）...');

    const endpoint = new URL(this.options.baseUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
      throw new UpstreamServiceError('FREEROUTING_AUTOLAUNCH_REMOTE', 400, '自动启动仅支持本机 FreeRouting 地址');
    }
    const dataDirectory = await mkdtemp(join(tmpdir(), 'dsh-freerouting-engine-'));
    await writeFile(
      join(dataDirectory, 'freerouting.json'),
      JSON.stringify({
        version: '2.5.0',
        api_server: {
          enabled: true,
          http_allowed: true,
          endpoints: [endpoint.origin],
          authentication: { enabled: false },
        },
        gui: { enabled: false },
        profile: { allow_telemetry: false, allow_contact: false },
        usage_and_diagnostic_data: { disable_analytics: true },
      }),
    );

    let runtime: Awaited<ReturnType<typeof prepareBundledRuntime>>;
    try {
      runtime = await prepareBundledRuntime(bundled, dataDirectory);
      if (runtime.copied) {
        record('安装目录较长，已在临时目录准备随包布线引擎');
      }
      if (signal?.aborted) {
        throw new UpstreamServiceError('RUN_CANCELLED', 499, 'The routing run was cancelled');
      }
    } catch (cause) {
      await rm(dataDirectory, { recursive: true, force: true });
      throw cause;
    }
    const { javaExe, jarPath } = runtime;

    // 4. Spawn Java process with bundled JRE
    // Arguments from Freerouting.cfg (endpoints defaults to http://127.0.0.1:37864)
    const javaArgs = [
      '-Xmx2G',
      // This Windows JRE's selector pipes fail under the user temp directory.
      // The system temp directory was exercised with the bundled HTTP engine.
      `-Djdk.net.unixdomain.tmpdir=${join(process.env.SystemRoot ?? 'C:\\Windows', 'Temp')}`,
      '-jar',
      jarPath,
      `--user_data_path=${dataDirectory}`,
      '--gui.enabled=false',
      '--api_server.enabled=true',
      '--api_server.http_allowed=true',
    ];

    const engine = await EngineProcess.launch(
      pythonPath(this.options.kicadPythonPath ?? ''),
      [javaExe, ...javaArgs],
      dataDirectory,
      () => {
        if (this.engine === engine) {
          this.engine = undefined;
        }
      },
    );
    this.engine = engine;
    // 5. Poll until service is ready
    const deadline = Date.now() + this.options.launchTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await engine.stop();
        throw new UpstreamServiceError('RUN_CANCELLED', 499, 'The routing run was cancelled');
      }
      if (await this.options.probe(signal)) {
        record('FreeRouting 服务已就绪');
        return;
      }
      await waitForPoll(this.options.pollIntervalMs, signal);
    }

    await engine.stop();
    throw new UpstreamServiceError(
      'FREEROUTING_UNAVAILABLE',
      503,
      `FreeRouting 启动失败，${Math.round(this.options.launchTimeoutMs / 1000)} 秒内未就绪`,
    );
  }
  shutdown(): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    this.launchController?.abort(new DOMException('Engine shutdown', 'AbortError'));
    this.stopping = this.stopOwnedEngine().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
  private async stopOwnedEngine(): Promise<void> {
    await this.launchInFlight?.catch(() => {});
    await this.engine?.stop();
  }
}

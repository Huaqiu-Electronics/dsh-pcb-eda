import z from '@deepseek-ai/schemastery';
import { join } from 'node:path';
import { homedir } from 'node:os';

const defaults = {
  autoLaunchFreerouting: true,
  drawtimeSec: 5,
  environmentHost: 'dsh-freerouting/1.0.0',
  freeroutingBaseUrl: 'http://127.0.0.1:37864',
  freeroutingLaunchTimeoutMs: 60_000,
  freeroutingStartBat: '',
  maxPendingRuns: 1,
  pollIntervalMs: 2_000,
  pollTimeoutMs: 1_800_000,
  profileEmail: 'huaqiu@qq.com',
  profileId: 'd0071163-7ba3-46b3-b3af-bc2ebbd4d1a0',
  realtime: true,
  kicadPythonPath: '',
  kicadApiSocket: '',
  ipcStateDirectory: join(process.env.APPDATA ?? homedir(), 'Huaqiu', 'dsh-freerouting', 'ipc-state'),
  requestTimeoutMs: 120_000,
  resultTtlMs: 60 * 60 * 1000,
  routePrefix: '/pcb-freerouting',
} as const;

export interface Config {
  kicadPythonPath?: string;
  kicadApiSocket?: string;
  ipcStateDirectory?: string;
  autoLaunchFreerouting?: boolean;
  drawtimeSec?: number;
  environmentHost?: string;
  freeroutingBaseUrl?: string;
  freeroutingLaunchTimeoutMs?: number;
  freeroutingStartBat?: string;
  maxPendingRuns?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  profileEmail?: string;
  profileId?: string;
  realtime?: boolean;
  requestTimeoutMs?: number;
  resultTtlMs?: number;
  routePrefix?: string;
}

export interface ResolvedConfig {
  kicadPythonPath: string;
  kicadApiSocket: string;
  ipcStateDirectory: string;
  autoLaunchFreerouting: boolean;
  drawtimeSec: number;
  environmentHost: string;
  freeroutingBaseUrl: string;
  freeroutingLaunchTimeoutMs: number;
  freeroutingStartBat: string;
  maxPendingRuns: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  profileEmail: string;
  profileId: string;
  realtime: boolean;
  requestTimeoutMs: number;
  resultTtlMs: number;
  routePrefix: string;
}

export const Config: z<Config> = z.object({
  kicadPythonPath: z.string().default(defaults.kicadPythonPath),
  kicadApiSocket: z.string().default(defaults.kicadApiSocket),
  ipcStateDirectory: z.string().default(defaults.ipcStateDirectory),
  freeroutingBaseUrl: z.string().default(defaults.freeroutingBaseUrl),
  autoLaunchFreerouting: z.boolean().default(defaults.autoLaunchFreerouting),
  freeroutingStartBat: z.string().default(defaults.freeroutingStartBat),
  routePrefix: z.string().default(defaults.routePrefix),
  profileId: z.string().default(defaults.profileId),
  profileEmail: z.string().default(defaults.profileEmail),
  environmentHost: z.string().default(defaults.environmentHost),
  realtime: z.boolean().default(defaults.realtime),
  drawtimeSec: z.natural().min(1).max(120).default(defaults.drawtimeSec),
  pollIntervalMs: z.natural().min(250).max(60_000).default(defaults.pollIntervalMs),
  pollTimeoutMs: z
    .natural()
    .min(10_000)
    .max(2 * 60 * 60 * 1000)
    .default(defaults.pollTimeoutMs),
  requestTimeoutMs: z
    .natural()
    .min(1_000)
    .max(15 * 60 * 1000)
    .default(defaults.requestTimeoutMs),
  resultTtlMs: z
    .natural()
    .min(60_000)
    .max(7 * 24 * 60 * 60 * 1000)
    .default(defaults.resultTtlMs),
  maxPendingRuns: z.natural().min(1).max(64).default(defaults.maxPendingRuns),
  freeroutingLaunchTimeoutMs: z
    .natural()
    .min(5_000)
    .max(10 * 60 * 1000)
    .default(defaults.freeroutingLaunchTimeoutMs),
});

function requireHttpUrl(value: string, label: string): string {
  if (value === '') {
    return value;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  return parsed.href.replace(/\/$/, '');
}

export function resolveConfig(config: Config = {}): ResolvedConfig {
  const routePrefix = config.routePrefix ?? defaults.routePrefix;
  if (!/^\/[\w/-]*[\w-]$/.test(routePrefix) || routePrefix.includes('//')) {
    throw new Error('routePrefix must be an absolute path without a trailing slash');
  }

  const freeroutingBaseUrl = config.freeroutingBaseUrl ?? defaults.freeroutingBaseUrl;
  if (freeroutingBaseUrl !== '') {
    requireHttpUrl(freeroutingBaseUrl, 'freeroutingBaseUrl');
  }

  return {
    kicadPythonPath: config.kicadPythonPath ?? defaults.kicadPythonPath,
    kicadApiSocket: config.kicadApiSocket ?? defaults.kicadApiSocket,
    ipcStateDirectory: config.ipcStateDirectory ?? defaults.ipcStateDirectory,
    autoLaunchFreerouting: config.autoLaunchFreerouting ?? defaults.autoLaunchFreerouting,
    drawtimeSec: config.drawtimeSec ?? defaults.drawtimeSec,
    environmentHost: config.environmentHost ?? defaults.environmentHost,
    freeroutingBaseUrl: requireHttpUrl(freeroutingBaseUrl, 'freeroutingBaseUrl'),
    freeroutingLaunchTimeoutMs: config.freeroutingLaunchTimeoutMs ?? defaults.freeroutingLaunchTimeoutMs,
    freeroutingStartBat: config.freeroutingStartBat ?? defaults.freeroutingStartBat,
    // First release permits one global routing task, including repair waits.
    maxPendingRuns: 1,
    pollIntervalMs: config.pollIntervalMs ?? defaults.pollIntervalMs,
    pollTimeoutMs: config.pollTimeoutMs ?? defaults.pollTimeoutMs,
    profileEmail: config.profileEmail ?? defaults.profileEmail,
    profileId: config.profileId ?? defaults.profileId,
    realtime: config.realtime ?? defaults.realtime,
    requestTimeoutMs: config.requestTimeoutMs ?? defaults.requestTimeoutMs,
    resultTtlMs: config.resultTtlMs ?? defaults.resultTtlMs,
    routePrefix,
  };
}

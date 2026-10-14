#!/usr/bin/env node
/**
 * Cross-platform equivalent of the bash start script.
 * Kills any process listening on port 3080, registers the local dsh plugins,
 * then starts the dsh web server.
 *
 * Launches dsh from the LOCAL DeepSeek Harness repo checkout via the official
 * `pnpm dsh` script (see deepseek-harness/README.md), instead of the
 * npm-published `@deepseek-ai/dsh`. The harness repo is expected to live as a
 * sibling of dsh-pcb-eda:
 *
 *   <code>/deepseek-harness     ← local dsh (pnpm dsh <cmd>)
 *   <code>/dsh-pcb-eda          ← this repo (packages/ = the plugins)
 *
 * Run from the project/git root:
 *   node scripts/launch-dsh.mjs
 */

'use strict';

import { execSync, spawn } from 'child_process';
import { accessSync, readFileSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { dshPlugins, pluginEntryInjects } from './utils/packages.mjs';

const PORT = 3080;
const PROFILE = 'web';

// Not a plugin at all — a host package bundled with HQ Edge rather than
// registered into a DSH profile.
const NOT_A_PLUGIN = new Set(['@huaqiu/dsh-eda-host']);

// Real plugins whose entry `inject` waits on `hqEdge`, a service only the
// edge-bridge provides and only inside an HQ Edge runtime. Registering them in
// a standalone DSH launch makes `dsh plugin add` succeed but leaves each one
// "pending (waiting for service: hqEdge)", and boot then aborts with
// "N entries did not activate" — so they are skipped outright.
//
// Derived from each plugin's own `cordis.patch.yml`, so a newly added
// hqEdge-dependent plugin is skipped without anyone editing this list.
const PLUGINS_NOT_AVAILABLE_IN_STANDALONE_DSH = new Set(
  dshPlugins()
    .filter((p) => pluginEntryInjects(p).includes('hqEdge'))
    .map((p) => p.name),
);

// Resolved from the script's own location (import.meta.url) so it works
// regardless of the caller's cwd.
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// This repo (dsh-pcb-eda) — home of the local plugins.
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
// Local DeepSeek Harness repo — always a sibling of this repo.
const HARNESS_DIR = path.resolve(SCRIPT_DIR, '..', '..', 'deepseek-harness');

// Discover the real dsh plugins under packages/ (those declaring a `dsh`
// config) — app/server/utility packages are not plugins and are excluded.
// Resolve to absolute paths because `pnpm dsh` runs with cwd = HARNESS_DIR.
//
// Keyed by npm NAME, not by directory path: the skip sets above hold names.
const PLUGINS = dshPlugins()
  .filter((p) => !NOT_A_PLUGIN.has(p.name) && !PLUGINS_NOT_AVAILABLE_IN_STANDALONE_DSH.has(p.name))
  .map((p) => p.dir);

// Skipped deliberately — say so, or the absence looks like a discovery bug.
const SKIPPED = dshPlugins()
  .filter((p) => NOT_A_PLUGIN.has(p.name) || PLUGINS_NOT_AVAILABLE_IN_STANDALONE_DSH.has(p.name))
  .map((p) => `${p.name}${NOT_A_PLUGIN.has(p.name) ? ' (host package, not a plugin)' : ' (needs hqEdge)'}`);

/**
 * Kill any process currently listening on the given port.
 * Silently ignores the case where nothing is listening.
 */
function killPort(port) {
  const platform = os.platform();

  try {
    if (platform === 'win32') {
      // Find PIDs listening on the port, then force-kill them.
      // netstat output lines look like:
      //   TCP    0.0.0.0:3080    0.0.0.0:0    LISTENING    12345
      const output = execSync(`netstat -ano | findstr :${port}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });

      const pids = new Set();
      for (const line of output.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0') {
          pids.add(pid);
        }
      }

      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
          console.log(`Killed process ${pid} on port ${port}`);
        } catch {
          // process may already have exited
        }
      }
    } else {
      // macOS / Linux
      try {
        const pids = execSync(`lsof -ti:${port}`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        })
          .trim()
          .split(/\s+/)
          .filter(Boolean);

        if (pids.length) {
          execSync(`kill -9 ${pids.join(' ')}`, { stdio: 'ignore' });
          console.log(`Killed process(es) ${pids.join(', ')} on port ${port}`);
        }
      } catch {
        // lsof exits non-zero when nothing is listening – ignore
      }
    }
  } catch {
    // netstat / findstr may also exit non-zero when no match – ignore
  }
}

/**
 * Run a command and inherit stdio so the user sees live output.
 * Throws if the command exits with a non-zero status.
 */
function run(cmd, args = [], cwd = process.cwd()) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execSync(`${cmd} ${args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`, {
    stdio: 'inherit',
    cwd,
    env: process.env,
    shell: true, // needed for pnpm on Windows
  });
}

function main() {
  // Ensure we are running from a directory that looks like the project root
  // (has a packages/ folder). This is only a soft check.
  const packagesDir = path.join(process.cwd(), 'packages');
  try {
    accessSync(packagesDir);
  } catch {
    console.warn(
      'Warning: ./packages not found in current working directory.\n' +
        'Please run this script from the project/git root.'
    );
  }

  // The local harness is the source of truth for the dsh CLI (`pnpm dsh`).
  // Fail fast with a clear message when it is not where we expect it.
  const harnessPkg = path.join(HARNESS_DIR, 'package.json');
  try {
    accessSync(harnessPkg);
    // Make sure the official `dsh` script exists in the harness package.json.
    const pkg = JSON.parse(readFileSync(harnessPkg, 'utf8'));
    if (typeof pkg?.scripts?.dsh !== 'string') throw new Error('no dsh script');
  } catch {
    console.error(
      `Local DeepSeek Harness not found at:\n  ${HARNESS_DIR}\n` +
        'Expected the harness repo as a sibling of dsh-pcb-eda ' +
        `(e.g. ${path.dirname(HARNESS_DIR)}/deepseek-harness).\n` +
        'It must expose the official `dsh` script: `pnpm dsh <cmd>`.'
    );
    process.exit(1);
  }

  console.log(`Using local dsh from: ${HARNESS_DIR} (pnpm dsh)`);
  if (SKIPPED.length > 0) {
    console.log(`Skipping ${SKIPPED.length} package(s) not usable in a standalone DSH launch:`);
    for (const name of SKIPPED) console.log(`  - ${name}`);
  }
  console.log(`Freeing port ${PORT}…`);
  killPort(PORT);

  for (const plugin of PLUGINS) {
    run(
      'pnpm',
      ['dsh', 'plugin', '--profile', PROFILE, 'add', plugin],
      HARNESS_DIR
    );
  }

  console.log('Starting dsh web…');
  // Final command should keep the process alive, so we spawn it without waiting.
  const child = spawn(
    'pnpm',
    ['dsh', 'web'],
    {
      stdio: 'inherit',
      cwd: HARNESS_DIR,
      env: process.env,
      shell: true,
    }
  );

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });

  // Forward termination signals to the child
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (!child.killed) child.kill(sig);
    });
  }
}

main();

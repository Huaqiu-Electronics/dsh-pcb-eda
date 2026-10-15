#!/usr/bin/env node
/**
 * Refresh every local DSH plugin into the INSTALLED KiCad HQ Edge runtime's
 * DSH home — the `kicad` target-host home — instead of the generic one.
 *
 * Why this exists:
 *   The installed KiCad ships its own edge-headless runtime. Its bundled `dsh`
 *   CLI resolves DSH_HOME to
 *
 *       <hqEdgeHome>/<version>/dsh-home/kicad
 *
 *   (host-scoped; see hq-edge `apps/server/src/dsh/dshHome.ts` — HQ Edge is
 *   bundled into `hq-eda`, `kicad` and `generic`, and one installation must
 *   never let two hosts share DSH state). Running the *installed* `dsh` shim
 *   with `plugin --profile web add <local dir>` therefore lands in the kicad
 *   host home, never the generic hq-eda one.
 *
 * What it does:
 *   1. Builds all workspace packages — plugins ship compiled `lib/` output, and
 *      the installed runtime loads that, not the TypeScript source.
 *   2. Locates the installed `dsh` shim, injects HQ_TARGET_HOST=kicad (the same
 *      host handshake KiCad's launcher uses; the bundled dsh CLI derives the
 *      home from HQ_TARGET_HOST, see hq-edge dsh-cli.ts), drops any inherited
 *      DSH_HOME override, and verifies via `dsh --hq-paths` that the resolved
 *      home is .../dsh-home/kicad. Aborts otherwise, so this update can never
 *      land in the generic hq-eda home — even though the registry-owned shim
 *      may currently point at a generic runtime ("last installed wins").
 *   3. Runs `dsh plugin --profile web add <dir>` for every local DSH plugin
 *      EXCEPT `dsh-hqsch`, which belongs to the generic/schematic host and is
 *      skipped while targeting kicad. (Unlike launch-dsh.mjs, dsh-eda-host IS
 *      included: kicad is an embedded host and needs a live link to its local
 *      host bridge; the standalone official dsh that launch-dsh targets ships
 *      its own.)
 *
 * Usage:
 *   pnpm update-bundled-plugins:kicad
 *
 * Prerequisites: KiCad Huaqiu (with the bundled edge-headless runtime) is
 * installed, so that `C:\Program Files\Common Files\KiCad\bin\dsh.cmd` (or the
 * `dsh` on PATH) exists. Do NOT set DSH_HOME in the shell — this script strips
 * it and targets the kicad host home explicitly via HQ_TARGET_HOST.
 */

'use strict';

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshPlugins } from './utils/packages.mjs';

const PROFILE = 'web';

/**
 * hq-edge checkout whose canonical plugin lock we compare against.
 *
 * `config/dsh-plugins.lock.json` is HQ Edge's list of BUILT-IN plugins. Override
 * with HQ_EDGE_DIR when the checkout is not a sibling of this repo.
 */
const HQ_EDGE_DIR = process.env.HQ_EDGE_DIR
  ? path.resolve(process.env.HQ_EDGE_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hq-edge');

/**
 * Read HQ Edge's built-in plugin names, or null when the lock is unavailable.
 *
 * Why this matters: `dsh plugin add` writes the local package into
 * <DSH_HOME>/profiles/web/node_modules/<name>, but HQ Edge's supervisor
 * re-points that exact path at its own materialized bundle on every boot
 * (DshSupervisor.ensureHQBuiltinPlugins → linkPluginIntoProfile). For a package
 * that is ALSO a built-in, this update therefore does not stick.
 */
function builtinPluginNames() {
  const lockPath = path.join(HQ_EDGE_DIR, 'config', 'dsh-plugins.lock.json');
  if (!existsSync(lockPath)) return null;
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const plugins = lock?.plugins;
    if (!plugins || typeof plugins !== 'object') return null;
    return new Set(Object.keys(plugins));
  } catch {
    console.warn(`warn: could not parse ${lockPath} — skipping the built-in collision check.`);
    return null;
  }
}

/**
 * Plugins that must NOT be added to the kicad profile:
 *  - dsh-hqsch: schematic-host plugin set, excluded when targeting kicad.
 *
 * NOTE: dsh-eda-host IS added here, unlike scripts/launch-dsh.mjs — that flow
 * targets the standalone official dsh, which ships its own host bridge; this
 * flow targets the EMBEDDED kicad runtime, whose dsh-eda-host must itself be a
 * live link to the local source under development.
 */
const SKIP_DIR_SUBSTRINGS = ['dsh-hqsch'];

/**
 * Child environment for every installed-`dsh` invocation.
 *
 * HQ_TARGET_HOST=kicad is what makes the bundled dsh CLI derive the
 * .../dsh-home/kicad tree instead of the generic one (see hq-edge
 * apps/server/src/dsh/dsh-cli.ts: `parseTargetHost(env.HQ_TARGET_HOST)`). An
 * inherited DSH_HOME would override host resolution entirely, so it is
 * deliberately stripped — the --hq-paths guard below then proves where we land.
 */
function childEnv() {
  const env = { ...process.env, HQ_TARGET_HOST: 'kicad' };
  delete env.DSH_HOME;
  return env;
}

function run(cmd, args = [], options = {}) {
  const quotedCmd = /\s/.test(cmd) ? `"${cmd}"` : cmd;
  const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
  console.log(`> ${quotedCmd} ${quoted.join(' ')}`);
  execSync(`${quotedCmd} ${quoted.join(' ')}`, {
    stdio: 'inherit',
    shell: true, // needed for .cmd shims on Windows
    env: childEnv(),
    ...options,
  });
}

/**
 * Locate the installed KiCad `dsh` shim.
 *
 * The installer drops a stable shim at <Common Files>\KiCad\bin\dsh.cmd, which
 * itself resolves the newest bundled edge-headless runtime via the registry.
 * Honour HQ_KICAD_DSH_CMD for one-off overrides; fall back to `dsh` on PATH.
 */
function locateDshCmd() {
  const candidates = [];
  if (process.env.HQ_KICAD_DSH_CMD) candidates.push(process.env.HQ_KICAD_DSH_CMD);
  if (process.platform === 'win32') {
    for (const root of [process.env['ProgramW6432'], process.env['CommonProgramW6432']]) {
      if (root) candidates.push(path.join(root, 'Common Files', 'KiCad', 'bin', 'dsh.cmd'));
      if (root) candidates.push(path.join(root, 'KiCad', 'bin', 'dsh.cmd'));
    }
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Last resort: whatever `dsh` resolves to on PATH.
  try {
    const which = process.platform === 'win32' ? 'where dsh' : 'which dsh';
    const found = execSync(which, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (found) return found;
  } catch {
    // not on PATH either
  }
  throw new Error(
    'Installed KiCad `dsh` shim not found.\n' +
      '  Expected C:\\Program Files\\Common Files\\KiCad\\bin\\dsh.cmd (or `dsh` on PATH).\n' +
      '  Install KiCad Huaqiu, or set HQ_KICAD_DSH_CMD to the shim explicitly.',
  );
}

/**
 * Ask the installed runtime where it would put DSH state, and assert it is the
 * kicad host home. This is the guard that keeps "update-bundled-plugins:kicad"
 * from ever writing into the generic hq-eda home.
 */
function assertTargetsKicadHome(dshCmd) {
  let stdout;
  try {
    stdout = execSync(`"${dshCmd}" --hq-paths`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      env: childEnv(),
    });
  } catch (e) {
    throw new Error(
      `Could not query "${dshCmd}" --hq-paths: ${e.message}\n` +
        '  The installed runtime may be older than the bundled dsh launcher.',
    );
  }
  const res = JSON.parse(stdout);
  const home = (res.dshHome || '').replace(/\\/g, '/');
  if (!home.endsWith('/dsh-home/kicad')) {
    throw new Error(
      `Refusing to update plugins: with HQ_TARGET_HOST=kicad the installed dsh\n` +
        `  still resolves DSH_HOME to:\n    ${res.dshHome}\n` +
        '  which is NOT the kicad host home (expected .../dsh-home/kicad).\n' +
        '  This usually means a DSH_HOME override is set in this shell (this script\n' +
        '  strips it, but an outer wrapper may re-inject it). Unset DSH_HOME and retry.',
    );
  }
  return res;
}

function main() {
  console.log('== Building all workspace packages (latest lib/ output) ==');
  run('pnpm', ['-r', 'build']);

  const dshCmd = locateDshCmd();
  console.log(`\n== Installed dsh: ${dshCmd} ==`);
  const resolved = assertTargetsKicadHome(dshCmd);
  console.log(`   kicad DSH home: ${resolved.dshHome}`);
  console.log(`   profile: ${resolved.profile} (dir: ${resolved.profileDir})\n`);

  const plugins = dshPlugins()
    .map((p) => p.dir)
    .filter((dir) => !SKIP_DIR_SUBSTRINGS.some((sub) => dir.includes(sub)));

  if (plugins.length === 0) {
    throw new Error('No local DSH plugins discovered under packages/.');
  }

  // Warn up-front about packages HQ Edge will overwrite at boot, so the
  // "I added it locally but the old build keeps loading" case is never a
  // mystery. This is advisory only — the update still runs.
  const builtins = builtinPluginNames();
  const collides = dshPlugins()
    .filter((p) => plugins.includes(p.dir))
    .filter((p) => builtins?.has(p.name));
  if (collides.length > 0) {
    console.log(
      `\n== NOTE: ${collides.length} package(s) are also HQ Edge built-in plugins ==`
    );
    for (const p of collides) {
      console.log(`  - ${p.name}`);
    }
    console.log(
      '  HQ Edge materializes its own copy of each built-in plugin and re-links\n' +
        '  <DSH_HOME>/profiles/web/node_modules/<name> to that copy on every boot,\n' +
        '  so this update will NOT stick for them.\n' +
        '  To test local changes to a built-in, use the hq-edge dev plugin root:\n' +
        `    cd ${HQ_EDGE_DIR} && pnpm dev:dsh-plugins-root\n` +
        '    export DSH_PATCH=<out>/edge-bridge/overlay.yml'
    );
  }

  console.log(`== Updating ${plugins.length} local plugins into the kicad profile ==`);
  for (const dir of plugins) {
    console.log(`\n--- ${path.basename(dir)} ---`);
    run(dshCmd, ['plugin', '--profile', PROFILE, 'add', dir]);
  }

  console.log('\nDone. Restart DSH (or restart KiCad) to load the updated bundles.');
}

main();

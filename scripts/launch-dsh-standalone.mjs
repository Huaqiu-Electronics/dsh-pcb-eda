#!/usr/bin/env node
/**
 * Standalone Hardware Engineering dev loop (no HQ Edge, no desktop build).
 *
 * The desktop application is the release target, and its boot path is far too
 * slow to iterate on UI work. This launcher uses the *official* DSH web profile
 * instead: the product bundle is `link:`-ed into the profile, so the running
 * DSH loads this checkout's built `lib/` straight from `packages/*` — rebuild,
 * reload the page, done.
 *
 * What it does:
 *   1. Builds the product packages (their `lib/` is what DSH loads).
 *   2. Resets the profile to the two official bundles plus
 *      `@huaqiu/hardware-engineering`, dropping every other `@huaqiu/*`
 *      dependency a previous `launch-dsh` run installed. Those child bundles
 *      insert the same row ids the product bundle inserts, so leaving them in
 *      place fails boot with duplicate-entry errors.
 *   3. `pnpm install` in the profile so the `link:` points at this checkout.
 *   4. Boots `dsh web` (default http://127.0.0.1:3080).
 *
 * Usage:
 *   pnpm launch-dsh:standalone            # build the product packages, then boot
 *   pnpm launch-dsh:standalone --no-build # boot the current lib/ as-is
 *   pnpm launch-dsh:standalone --all      # build every workspace package first
 *   pnpm launch-dsh:standalone --no-install
 */

'use strict'

import { execSync, spawn } from 'node:child_process'
import { accessSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = 3080
const PROFILE = 'web'
const PRODUCT_BUNDLE = '@huaqiu/hardware-engineering'
/** Bundles every out-of-tree profile starts from, in template order. */
const OFFICIAL_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
/** Package directories whose `lib/` this loop rebuilds by default. */
const PRODUCT_PACKAGES = [
  'hardware-artifacts',
  'dsh-hardware-ui',
  'hardware-engineering',
]

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const HARNESS_DIR = path.resolve(SCRIPT_DIR, '..', '..', 'deepseek-harness')
const BUNDLE_DIR = path.join(REPO_ROOT, 'packages', 'hardware-engineering')

const args = new Set(process.argv.slice(2))
const buildMode = args.has('--no-build') ? 'none' : args.has('--all') ? 'all' : 'product'
const doInstall = !args.has('--no-install')

/** Child environment for harness commands. */
function childEnv() {
  return { ...process.env }
}

function run(cmd, cmdArgs = [], cwd = REPO_ROOT) {
  const line = [cmd, ...cmdArgs].join(' ')
  console.log(`> ${line}`)
  execSync(line, { stdio: 'inherit', cwd, env: childEnv(), shell: true })
}

function dsh(cmdArgs) {
  run('pnpm', ['dsh', ...cmdArgs], HARNESS_DIR)
}

/** Kill whatever listens on the web port; a stale server would serve old code. */
function killPort(port) {
  try {
    if (os.platform() === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port}`, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
      })
      const pids = new Set()
      for (const line of output.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue
        const parts = line.trim().split(/\s+/)
        const pid = parts[parts.length - 1]
        if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid)
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' })
          console.log(`Killed process ${pid} on port ${port}`)
        } catch { /* already gone */ }
      }
      return
    }
    const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
      .trim().split(/\s+/).filter(Boolean)
    if (pids.length > 0) {
      execSync(`kill -9 ${pids.join(' ')}`, { stdio: 'ignore' })
      console.log(`Killed process(es) ${pids.join(', ')} on port ${port}`)
    }
  } catch { /* nothing listening */ }
}

function assertHarness() {
  const manifest = path.join(HARNESS_DIR, 'package.json')
  try {
    accessSync(manifest)
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof pkg?.scripts?.dsh !== 'string') throw new Error('no dsh script')
  } catch {
    console.error(
      `Local DeepSeek Harness not found at:\n  ${HARNESS_DIR}\n` +
      'Expected the harness repo as a sibling of dsh-pcb-eda and exposing `pnpm dsh <cmd>`.',
    )
    process.exit(1)
  }
}

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? path.resolve(process.env.DSH_HOME)
    : path.join(os.homedir(), '.dsh')
}

function profileDir() {
  return path.join(dshHome(), 'profiles', PROFILE)
}

/** Seed an uninitialized profile exactly like DSH's own `initProfile`. */
function ensureProfile(dir) {
  mkdirSync(dir, { recursive: true })
  const manifest = path.join(dir, 'package.json')
  if (!existsSync(manifest)) {
    writeFileSync(manifest, JSON.stringify({
      name: `dsh-profile-${PROFILE}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...OFFICIAL_BUNDLES] } },
    }, undefined, 2) + '\n')
  }
  const patch = path.join(dir, 'cordis.patch.yml')
  if (!existsSync(patch)) {
    writeFileSync(patch, '# Your patch layer for this dsh profile, applied after every bundle layer.\n[]\n')
  }
  const workspace = path.join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspace)) {
    writeFileSync(workspace, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  }
}

/**
 * Point the profile at exactly one Huaqiu bundle.
 *
 * A previous `launch-dsh` run adds every workspace plugin as its own bundle;
 * those layers duplicate the product bundle's row ids. Dropping them makes the
 * loop idempotent and bootable no matter what ran before.
 */
function selectProductBundle(dir) {
  const manifestPath = path.join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const drops = []

  const dependencies = { ...(manifest.dependencies ?? {}) }
  for (const name of Object.keys(dependencies)) {
    if (name.startsWith('@huaqiu/') && name !== PRODUCT_BUNDLE) {
      delete dependencies[name]
      drops.push(name)
    }
  }
  dependencies[PRODUCT_BUNDLE] = `link:${BUNDLE_DIR}`

  const previous = manifest.dsh?.profile?.bundles ?? []
  const bundles = previous.filter((name) => !name.startsWith('@huaqiu/'))
  for (const name of OFFICIAL_BUNDLES) if (!bundles.includes(name)) bundles.push(name)
  bundles.push(PRODUCT_BUNDLE)

  const next = {
    ...manifest,
    dependencies,
    dsh: { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } },
  }
  writeFileSync(manifestPath, JSON.stringify(next, undefined, 2) + '\n')

  if (drops.length > 0) {
    console.log(`Removed ${drops.length} standalone plugin link(s) superseded by ${PRODUCT_BUNDLE}:`)
    for (const name of drops) console.log(`  - ${name}`)
  }
  console.log(`Profile bundles: ${bundles.join(', ')}`)
}

function build() {
  if (buildMode === 'none') {
    console.log('Skipping build (--no-build).')
    return
  }
  if (buildMode === 'all') {
    run('pnpm', ['-r', '--workspace-concurrency=4', 'build'])
    return
  }
  // Product packages only: everything else already ships a built lib/, and the
  // three below are the ones this loop actually edits.
  const filters = PRODUCT_PACKAGES.flatMap(name => ['--filter', `./packages/${name}`])
  run('pnpm', [...filters, 'build'])
}

function main() {
  assertHarness()
  const dir = profileDir()
  console.log(`Using local dsh from: ${HARNESS_DIR}`)
  console.log(`Profile: ${dir}`)

  build()

  ensureProfile(dir)
  selectProductBundle(dir)

  if (doInstall) {
    dsh(['plugin', '--profile', PROFILE, 'install'])
  }

  const linked = path.join(dir, 'node_modules', '@huaqiu', 'hardware-engineering')
  if (!existsSync(linked)) {
    console.warn(
      `Warning: ${linked} is missing, so the bundle will not resolve.\n` +
      'Run the install step (drop --no-install) and try again.',
    )
  }

  console.log(`Freeing port ${PORT}…`)
  killPort(PORT)
  console.log('Starting dsh web…')
  const child = spawn('pnpm', ['dsh', 'web'], {
    stdio: 'inherit', cwd: HARNESS_DIR, env: childEnv(), shell: true,
  })

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { if (!child.killed) child.kill(sig) })
  }
}

main()

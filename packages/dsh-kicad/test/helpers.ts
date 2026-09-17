/**
 * Test helpers for `@huaqiu/dsh-kicad`.
 *
 * The KiCad IPC adapter shells out to a Python interpreter, so the tests drive
 * it with a *fake interpreter*: a tiny executable that reports its argv and
 * exits with a chosen code. That makes argv construction, cwd, timeout handling
 * and exit-code classification all deterministic — no KiCad, no `kipy`, and no
 * dependency on which Python happens to be installed on the machine.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { KICAD_SCRIPTS } from '../src/scripts.js'

export interface FakeEnv {
  /** Temp root — caller disposes it. */
  root: string
  /** Directory holding the (stub) scripts, to pass as `scriptsDir`. */
  scriptsDir: string
  /** Path of the fake interpreter, to pass as `pythonPath`. */
  pythonPath: string
  /** File the fake interpreter appends its argv to. */
  argvLog: string
  /** File containing the exit code / sleep directives. */
  controlFile: string
}

/**
 * Create a temp sandbox: a stub scripts directory plus a fake interpreter.
 *
 * Behaviour is steered through `controlFile`:
 *   - `exit=<n>`   exit code (default 0)
 *   - `sleep=<ms>` sleep before exiting (used to exercise the timeout)
 *   - `stderr=<s>` text written to stderr before exiting
 *   - `stdout=<s>` text written to stdout before exiting
 */
export function createFakeEnv(): FakeEnv {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kicad-'))
  const scriptsDir = join(root, 'scripts')
  mkdirSync(scriptsDir, { recursive: true })

  // Real file names so the adapter resolves the same paths it would in the
  // shipped package; the stubs are never executed by a real interpreter.
  for (const script of Object.values(KICAD_SCRIPTS)) {
    writeFileSync(join(scriptsDir, script.file), '# stub\n')
  }

  const argvLog = join(root, 'argv.log')
  const controlFile = join(root, 'control.txt')
  writeFileSync(controlFile, 'exit=0\n')

  const pythonPath = join(root, 'fake-python')
  writeFileSync(
    pythonPath,
    [
      '#!/bin/sh',
      '# Fake interpreter for @huaqiu/dsh-kicad tests.',
      'printf "%s\\n" "$@" >> "$DSH_KICAD_TEST_ARGV_LOG"',
      'CONTROL="$DSH_KICAD_TEST_CONTROL"',
      'EXIT=0',
      'SLEEP=0',
      'STDERR=""',
      'STDOUT=""',
      'if [ -f "$CONTROL" ]; then',
      '  while IFS= read -r line; do',
      '    case "$line" in',
      '      exit=*) EXIT="${line#exit=}" ;;',
      '      sleep=*) SLEEP="${line#sleep=}" ;;',
      '      stderr=*) STDERR="${line#stderr=}" ;;',
      '      stdout=*) STDOUT="${line#stdout=}" ;;',
      '    esac',
      '  done < "$CONTROL"',
      'fi',
      'if [ -n "$STDOUT" ]; then printf "%s\\n" "$STDOUT" ; fi',
      'if [ -n "$STDERR" ]; then printf "%s\\n" "$STDERR" >&2 ; fi',
      'if [ "$SLEEP" != "0" ]; then sleep "$SLEEP" ; fi',
      'exit "$EXIT"',
      ''
    ].join('\n'),
  )
  chmodSync(pythonPath, 0o755)

  // The fake interpreter reads its steering through env vars, mirroring how the
  // adapter passes configuration rather than argv.
  process.env['DSH_KICAD_TEST_ARGV_LOG'] = argvLog
  process.env['DSH_KICAD_TEST_CONTROL'] = controlFile

  return { root, scriptsDir, pythonPath, argvLog, controlFile }
}

/** Rewrite the fake interpreter's control file. */
export function setControl(env: FakeEnv, lines: string[]): void {
  writeFileSync(env.controlFile, `${lines.join('\n')}\n`)
}

/** Read back the argv the fake interpreter received (without the script path). */
export function recordedArgv(env: FakeEnv): string[] {
  if (!existsSync(env.argvLog)) return []
  return readText(env.argvLog).split('\n').filter((line) => line.length > 0)
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Remove a sandbox created by {@link createFakeEnv}. */
export function disposeFakeEnv(env: FakeEnv): void {
  delete process.env['DSH_KICAD_TEST_ARGV_LOG']
  delete process.env['DSH_KICAD_TEST_CONTROL']
  rmSync(env.root, { recursive: true, force: true })
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveKiCadPaths,getKiCadPaths } from '../src/runtime-paths.ts'
import {resolveConfig, Config} from '../src/config.ts'
import {previewConfig} from '../src/schematic/preview-config.ts'

test('discovers a relocated host and symbols, supports overrides and PATH without a fixed version', () => {
  const root = mkdtempSync(join(tmpdir(), 'schematic portable '))
  try {
    const bin = join(root, 'KiCad next', 'bin')
    const symbols = join(root, 'KiCad next', 'share', 'kicad', 'symbols')
    mkdirSync(join(bin, 'edge-headless', 'bin'), { recursive: true })
    mkdirSync(symbols, { recursive: true })
    const cli = join(bin, process.platform === 'win32' ? 'kicad-cli.exe' : 'kicad-cli')
    writeFileSync(cli, '')
    writeFileSync(join(symbols, 'power.kicad_sym'), '')
    const executable = join(bin, 'edge-headless', 'bin', 'node.exe')
    assert.deepEqual(resolveKiCadPaths(executable, {}), { kicadCliPath: cli, symbolDir: symbols })
    for (const command of ['kicad-cli', 'kicad-cli.exe']) {
      assert.equal(resolveKiCadPaths(executable, {PATH: '', KICAD_CLI_PATH: command}).kicadCliPath, cli)
    }
    const custom = join(root, 'my-cli')
    assert.equal(resolveKiCadPaths(executable, { KICAD_CLI_PATH: custom }).kicadCliPath, custom)
    assert.equal(resolveKiCadPaths(join(root, 'other', 'node'), { PATH: bin, KICAD11_SYMBOL_DIR: symbols }).symbolDir, symbols)
    assert.equal(resolveKiCadPaths(join(root, 'other', 'node'), { PATH: bin }).kicadCliPath, cli)
    assert.equal(resolveKiCadPaths(join(root, 'other', 'node'), {}).kicadCliPath, process.platform === 'win32' ? 'kicad-cli.exe' : 'kicad-cli')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('configuration and skills reuse discovery; known host CLI overrides only the preview call',()=>{
 const paths=getKiCadPaths();
 assert.equal(getKiCadPaths(),paths);
 assert.equal(getKiCadPaths(paths.kicadCliPath),paths);
 assert.equal(getKiCadPaths('kicad-cli'),paths);
 assert.equal(getKiCadPaths('kicad-cli.exe'),paths);
 assert.equal(resolveConfig(Config({} as never)).schematic.kicadCliPath,paths.kicadCliPath);
 const cli=join(tmpdir(),'known host','bin',process.platform==='win32'?'kicad-cli.exe':'kicad-cli');
 const configured=resolveConfig({schematic:{kicadCliPath:cli}}).schematic;
 assert.equal(configured.kicadCliPath,cli);
 const original=resolveConfig().schematic;
 assert.equal(previewConfig(original,undefined),original);
 assert.equal(previewConfig(original,cli).kicadCliPath,cli);
 assert.notEqual(original.kicadCliPath,cli);
 assert.throws(()=>previewConfig(original,'relative/kicad-cli.exe'),/absolute/);
 assert.throws(()=>previewConfig(original,join(tmpdir(),'python.exe')),/kicad-cli/);
})

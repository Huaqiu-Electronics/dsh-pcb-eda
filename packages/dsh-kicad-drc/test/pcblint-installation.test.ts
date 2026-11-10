import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inspectPcblintHome,
  resolvePcblintInstallation,
  PCBLINT_HOME_ENV,
} from '../src/pcblint-installation.ts'

/** 造一个完整的 `pcblint-local` 目录（文件内容不重要，只校验存在性）。 */
function createComponent(root: string, version?: string): string {
  const home = join(root, 'pcblint-local')
  mkdirSync(join(home, 'jre25', 'bin'), { recursive: true })
  mkdirSync(join(home, 'pcblint'), { recursive: true })
  writeFileSync(join(home, 'jre25', 'bin', 'java.exe'), '')
  writeFileSync(join(home, 'pcblint', 'pcblint.jar'), '')
  if (version !== undefined) {
    writeFileSync(join(home, 'pcblint', 'version.txt'), `${version}\n`)
  }
  return home
}

test('resolvePcblintInstallation：pcblintHome 优先于环境变量与 kicad-cli 同级目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'pcblint-home-'))
  try {
    const configured = createComponent(join(root, 'configured'))
    const fromEnv = createComponent(join(root, 'env'))
    const result = resolvePcblintInstallation({
      configuredHome: configured,
      kicadCliPath: join(root, 'kicad', 'bin', 'kicad-cli.exe'),
      env: { [PCBLINT_HOME_ENV]: fromEnv },
    })
    assert.equal(result.home, configured)
    assert.equal(result.javaPath, join(configured, 'jre25', 'bin', 'java.exe'))
    assert.equal(result.jarPath, join(configured, 'pcblint', 'pcblint.jar'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolvePcblintInstallation：没有配置时读 DSH_PCBLINT_HOME', () => {
  const root = mkdtempSync(join(tmpdir(), 'pcblint-env-'))
  try {
    const fromEnv = createComponent(join(root, 'env'))
    const result = resolvePcblintInstallation({
      configuredHome: '   ',
      kicadCliPath: join(root, 'kicad', 'bin', 'kicad-cli.exe'),
      env: { [PCBLINT_HOME_ENV]: fromEnv },
    })
    assert.equal(result.home, fromEnv)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolvePcblintInstallation：兜底使用 kicad-cli 同级的 pcblint-local', () => {
  const root = mkdtempSync(join(tmpdir(), 'pcblint-beside-'))
  try {
    const bin = join(root, 'KiCad', 'bin')
    const home = createComponent(bin)
    const result = resolvePcblintInstallation({
      kicadCliPath: join(bin, 'kicad-cli.exe'),
      env: {},
    })
    assert.equal(result.home, home)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('inspectPcblintHome：读取安装包写入的版本号', () => {
  const root = mkdtempSync(join(tmpdir(), 'pcblint-version-'))
  try {
    const home = createComponent(root, '1.4.2')
    const result = inspectPcblintHome(home)
    assert.equal(result.version, '1.4.2')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('inspectPcblintHome：缺 jar 时一次列出期望路径', () => {
  const root = mkdtempSync(join(tmpdir(), 'pcblint-broken-'))
  try {
    const home = join(root, 'pcblint-local')
    mkdirSync(join(home, 'jre25', 'bin'), { recursive: true })
    writeFileSync(join(home, 'jre25', 'bin', 'java.exe'), '')
    assert.throws(
      () => inspectPcblintHome(home),
      (error: Error) => {
        assert.match(error.message, /pcblint\.jar/u)
        assert.match(error.message, /pcblintHome/u)
        return true
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolvePcblintInstallation：完全没有来源时提示可配置项', () => {
  assert.throws(
    () => resolvePcblintInstallation({ env: {} }),
    (error: Error) => {
      assert.match(error.message, /DSH_PCBLINT_HOME/u)
      assert.match(error.message, /pcblintHome/u)
      return true
    },
  )
})

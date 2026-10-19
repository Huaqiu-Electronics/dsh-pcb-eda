import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerModules } from '../src/modules/register.ts'
import type { Config } from '../src/modules/config.ts'

const config: Config = {
  search: { apiBaseUrl: 'https://gen.eda.cn', requestTimeoutMs: 30000, maxResults: 10, maxResponseBytes: 1000000 },
  download: { apiBaseUrl: 'https://www.eda.cn', requestTimeoutMs: 30000, maxDetailBytes: 2000000,
    maxZipBytes: 20000000, maxSchematicBytes: 10000000, maxProjectBytes: 10000000, maxArchiveEntries: 512 },
}

test('module registration includes catalog searches and the KiCad download adapter without a live host', () => {
  const names: string[] = []
  const ctx = {
    tools: { register: (tool: { name: string }) => { names.push(tool.name); return () => {} } },
    effect: (callback: () => unknown) => callback(),
  }
  registerModules(ctx as never, config)
  assert.deepEqual(names, ['eda_module_rag_search', 'eda_module_category_search', 'eda_module_precise_search', 'download_eda_module_schematic'])
})

test('another EDA host is rejected when download executes', async () => {
  let download: any
  registerModules({
    get: () => ({ context: { getTargetHost: () => 'other' } }),
    tools: { register: (tool: any) => { if (tool.name === 'download_eda_module_schematic') download = tool; return () => {} } },
    effect: (callback: () => unknown) => callback(),
  } as never, config)
  assert.ok(download)
  await assert.rejects(download.execute({ moduleId: '1' }, { signal: new AbortController().signal }), /only in KiCad/)
})

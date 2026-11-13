import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, type Config, readWorkspaceSchematic } from '../src/schematic/index.ts'

test('schematic entry exposes a port query that returns only unique names', async () => {
  const tools: ToolDefinition[] = []
  const config: Config = {
    maxSchematicBytes: 10000000, kicadCliPath: '/usr/local/bin/kicad-cli',
    previewDensity: 288, previewMaxWidth: 2400, previewPadding: 32,
    previewTimeoutMs: 30000, previewTrimThreshold: 10, flatListLimit: 120,
    flatTemplateDir: fileURLToPath(new URL('../skills/kicad-schematic-design/templates/', import.meta.url)),
  }
  let source = '(kicad_sch (hierarchical_label "VIN" (shape input)) (hierarchical_label "VIN" (shape output)) (hierarchical_label "VOUT" (shape output)) (label "LOCAL"))'
  const fs = {resolve: async (path: string) => ({displayPath: path}), contains: () => true,
    stat: async () => ({type: 'file'}), readBytes: async () => Buffer.from(source)}
  apply({ fs, effect: (callback: () => unknown) => callback(),
    tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } },
  } as never, config)
  assert.deepEqual(tools.map(tool => tool.name), ['list_kicad_hierarchical_ports', 'render_kicad_module_preview', 'create_kicad_hierarchy'])
  assert.equal(typeof readWorkspaceSchematic, 'function')
  const exec = {agent: {session: {header: {cwd: '.'}}}, signal: new AbortController().signal} as never
  const query = tools[0]!
  assert.deepEqual(await query.execute({schematicPath: 'power.kicad_sch'}, exec), {ports: ['VIN', 'VOUT']})
  source = '(kicad_sch (label "LOCAL"))'
  assert.deepEqual(await query.execute({schematicPath: 'power.kicad_sch'}, exec), {ports: []})
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { apply, type Config, readWorkspaceSchematic } from '../src/schematic/index.ts'

test('thin entry preserves all four schematic tools and the public read helper', () => {
  const names: string[] = []
  const config: Config = {
    maxSchematicBytes: 10000000, kicadCliPath: 'D:/kicad/10.0.0/bin/kicad-cli.exe',
    previewDensity: 288, previewMaxWidth: 2400, previewMaxPages: 4, previewPadding: 32,
    previewTimeoutMs: 30000, previewTrimThreshold: 10, flatListLimit: 120,
    flatTemplateDir: fileURLToPath(new URL('../skills/kicad-schematic-design/templates/', import.meta.url)),
  }
  apply({ effect: (callback: () => unknown) => callback(),
    tools: { register: (tool: { name: string }) => { names.push(tool.name); return () => {} } },
  } as never, config)
  assert.deepEqual(names, ['get_kicad_module_ports', 'render_kicad_module_preview', 'create_kicad_hierarchy', 'edit_kicad_flat_schematic'])
  assert.equal(typeof readWorkspaceSchematic, 'function')
})

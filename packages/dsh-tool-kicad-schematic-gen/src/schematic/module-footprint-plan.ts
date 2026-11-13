import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { footprintModel } from '../components/project-footprint.ts'
import { footprintRequirements } from './footprint-links.ts'

export const moduleFootprintIndex = (sourcePath: string) => sourcePath + '.footprints.json'
export const isDownloadedModule = (sourcePath: string) => /^HQ_EDA_.+\.kicad_sch$/iu.test(basename(sourcePath))

export interface ModuleFootprintAsset {
  path: string
  archiveEntry?: string
  sha256?: string
}

export function moduleFootprintAssets(sourcePath: string, index: string): ModuleFootprintAsset[] {
  const files: unknown = JSON.parse(index)
  if (!Array.isArray(files)) throw new Error('Invalid module footprint index')
  const folder = basename(sourcePath, '.kicad_sch') + '.footprints'
  return files.map(file => {
    if (typeof file?.path !== 'string' || !/^[a-f0-9]{24}\.kicad_mod$/u.test(file.path)
      || typeof file.archiveEntry !== 'string' || typeof file.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error('Invalid module footprint index entry')
    return { path: join(dirname(sourcePath), folder, file.path), archiveEntry: file.archiveEntry, sha256: file.sha256 }
  })
}

export interface ModuleFootprint {
  nickname: string
  name: string
  text: string
}

export function planModuleFootprints(source: string, assets: Array<ModuleFootprintAsset & { raw: string }>) {
  const candidates = assets.map(({ raw, archiveEntry, path, sha256 }) => {
    if (sha256 && createHash('sha256').update(raw).digest('hex') !== sha256) {
      throw new Error('MODULE_FOOTPRINTS_UNAVAILABLE: extracted footprint changed: ' + path + '. Use an intact module download.')
    }
    const model = footprintModel(raw)
    const digest = createHash('sha256').update(model.text).digest('hex')
    const nickname = 'Module_' + digest.slice(0, 16)
    const entry = (archiveEntry ?? path).replaceAll('\\', '/')
    const library = /(?:^|\/)([^/]+)\.pretty\/[^/]+$/iu.exec(entry)?.[1]
    const names = [model.name, basename(entry).replace(/\.kicad_mod$/iu, '')]
    const pads = new Set(model.summary.pads.map(pad => pad.number).filter(Boolean))
    return { id: nickname + ':' + model.name, model: { nickname, name: model.name, text: model.text }, names, library, pads, digest }
  })
  const models = new Map<string, ModuleFootprint>()
  const mappings: Record<string, string> = Object.create(null)
  const problems: string[] = []
  for (const { reference, footprintId, pinNumbers } of footprintRequirements(source)) {
    const [library, name, extra] = footprintId.split(':')
    const named = library && name && extra === undefined
      ? candidates.filter(candidate => candidate.names.includes(name))
      : []
    const exact = named.filter(candidate => candidate.library === library)
    const matches = [...new Map((exact.length ? exact : named).map(candidate => [candidate.digest, candidate])).values()]
    const match = matches[0]
    const label = reference + ' (' + (footprintId || 'empty Footprint') + ')'
    if (!match || matches.length !== 1) {
      problems.push(label + (match ? ': ambiguous packaged footprints' : ': no matching packaged footprint'))
    } else if (!pinNumbers.length || pinNumbers.some(pin => !match.pads.has(pin))
      || [...match.pads].some(pad => !pinNumbers.includes(pad))) {
      problems.push(label + ': PIN_PAD_MISMATCH')
    } else if (mappings[reference] && mappings[reference] !== match.id) {
      problems.push(label + ': units of one reference use different footprints')
    } else {
      mappings[reference] = match.id
      models.set(match.id, match.model)
    }
  }
  if (problems.length) {
    throw new Error('MODULE_FOOTPRINTS_UNAVAILABLE: ' + problems.slice(0, 12).join('; ')
      + (problems.length > 12 ? ' (+' + (problems.length - 12) + ' more)' : '')
      + '. Select a module with complete, unambiguous packaged footprints.')
  }
  return { mappings, models }
}

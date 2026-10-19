import {basename,isAbsolute} from 'node:path'
import type {Config} from './config.ts'

/** A known host CLI can be reused for this call without updating plugin configuration. */
export function previewConfig(config:Config,kicadCliPath:unknown):Config{
 if(kicadCliPath===undefined)return config;
 if(typeof kicadCliPath!=='string'||!isAbsolute(kicadCliPath)||!['kicad-cli','kicad-cli.exe'].includes(basename(kicadCliPath).toLowerCase())){
  throw new Error('kicadCliPath must be the absolute kicad-cli executable path from the current host');
 }
 return {...config,kicadCliPath};
}

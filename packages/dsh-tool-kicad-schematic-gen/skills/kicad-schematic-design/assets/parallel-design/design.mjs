/** Main-agent entry: module files are authored independently; one shared sheet is saved. */
import {join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
const plugin=process.env.DSH_SCHEMATIC_PLUGIN_DIR;
const manifest=process.env.DSH_MODULE_PLAN_PATH;
if(!plugin||!manifest||!isAbsolute(process.argv[2]||''))throw new Error('Run with run-design.mjs --modules <module-plan.json> and an absolute candidate directory');
const {assembleDesign}=await import(pathToFileURL(join(plugin,'skills/kicad-schematic-design/assets/module-runtime.mjs')).href);
console.log(JSON.stringify(await assembleDesign(manifest,process.argv[2])));

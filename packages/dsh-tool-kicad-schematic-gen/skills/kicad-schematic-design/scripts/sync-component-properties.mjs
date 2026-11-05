/** Audit by default; --apply fills missing properties with backups and optimistic file checks. */
import {readFileSync,writeFileSync,realpathSync,mkdirSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const [manifestPath,...flags]=process.argv.slice(2);
if(!manifestPath || flags.some(f=>f!=='--apply'))throw new Error('Usage: node sync-component-properties.mjs <manifest.json> [--apply]');
const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
const workspace=realpathSync(manifest.workspace);
const scoped=path=>{
  const target=realpathSync(resolve(dirname(resolve(manifestPath)),path));
  const rel=relative(workspace,target);
  if(rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))throw new Error(`Path outside workspace: ${path}`);
  return target;
};
const pluginDir=process.env.DSH_SCHEMATIC_PLUGIN_DIR||resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const {mergeSymbolProperties,syncSchematicProperties}=await import(pathToFileURL(join(pluginDir,'lib/builder.js')).href);
const require=createRequire(join(pluginDir,'package.json'));
const {createPartSearchService}=await import(pathToFileURL(require.resolve('@huaqiu/part-search')).href);
const service=createPartSearchService({timeoutMs:20000});
if(!Array.isArray(manifest.parts)||!manifest.parts.length||!Array.isArray(manifest.schematics))throw new Error('Manifest requires parts and schematics arrays');
const changes=new Map(),updates=[],parts=[];
const stage=(path,oldText,newText)=>{
  if(changes.has(path))throw new Error(`Repeated target: ${path}`);
  changes.set(path,{oldText,newText});
};
// Resolve every identity and complete all preparation before any file mutation.
for(const part of manifest.parts){
  if(!/^\d+$/.test(part.manufacturer_id)||typeof part.mpn!=='string'||!part.mpn||!Array.isArray(part.references)||!part.references.length)throw new Error('Each part needs exact manufacturer_id, mpn, libId, libraryPath and references');
  const path=scoped(part.libraryPath),oldText=readFileSync(path,'utf8');
  // A previously saved getPart response allows repeatable audits without new network requests.
  const detail=part.detailPath?JSON.parse(readFileSync(scoped(part.detailPath),'utf8')):
    await service.getPart({manufacturerId:part.manufacturer_id,mpn:part.mpn});
  if(detail.mpn!==part.mpn || (detail.manufacturer.id && detail.manufacturer.id!==part.manufacturer_id)
    || (part.detailPath && detail.manufacturer.id!==part.manufacturer_id))throw new Error(`Identity mismatch: ${part.mpn}`);
  const newText=mergeSymbolProperties(oldText,detail);
  stage(path,oldText,newText);
  updates.push({libId:part.libId,libraryText:newText,references:part.references});
  parts.push({mpn:part.mpn,references:part.references,attributeCount:detail.attributes.length,libraryChanged:newText!==oldText});
}
for(const file of manifest.schematics){
  const path=scoped(file),oldText=readFileSync(path,'utf8');
  stage(path,oldText,syncSchematicProperties(oldText,updates));
}
const changed=[...changes].filter(([,c])=>c.oldText!==c.newText);
let backupDir;
if(flags.includes('--apply')&&changed.length){
  const parent=realpathSync(dirname(resolve(manifestPath)));
  const rel=relative(workspace,parent);
  if(rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))throw new Error('Apply manifest must be inside workspace');
  backupDir=join(parent,`properties-backup-${Date.now()}`);
  mkdirSync(backupDir);
  for(const [path,c] of changed){
    if(scoped(path)!==path || readFileSync(path,'utf8')!==c.oldText)throw new Error(`File changed during preparation: ${path}`);
    const backup=join(backupDir,relative(workspace,path));
    mkdirSync(dirname(backup),{recursive:true});writeFileSync(backup,c.oldText,{flag:'wx'});
  }
  for(const [path,c] of changed){
    if(scoped(path)!==path || readFileSync(path,'utf8')!==c.oldText)throw new Error(`File changed before write: ${path}; backups: ${backupDir}`);
    writeFileSync(path,c.newText);
  }
}
const report={mode:flags.includes('--apply')?'applied':'check',parts,changedFiles:changed.map(([path])=>path),...(backupDir?{backupDir}:{})};
console.log(JSON.stringify(report,null,2));

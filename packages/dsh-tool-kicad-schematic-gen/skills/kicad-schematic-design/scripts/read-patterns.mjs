/** Read selected drawing references without running code or generating files. */
import {readFileSync,statSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {catalog,assets,references,runtime} from '../assets/pattern-references.mjs';


function readPatterns(ids){
 const selected=[...new Set(ids)];
 if(!selected.length)throw new Error('Choose pattern IDs; use --list to inspect available IDs.');
 for(const id of selected)if(!catalog.has(id))throw new Error(`Unknown pattern ID: ${id}. Use --list; paths and maintenance generators are not pattern IDs.`);
 const resources=new Map(),imagePaths=new Set(),runtimePaths=new Set();
 const addText=(path,kind)=>{
  if(!resources.has(path))resources.set(path,{path,kind,content:readFileSync(path,'utf8')});
  return resources.get(path).content;
 };
 const code=(path,kind)=>{
  if(resources.has(path))return;
  const text=addText(path,kind);
  // Follow static local imports (including multiline named imports); stop at the public runtime boundary.
  for(const match of text.matchAll(/^\s*import\s+(?:[^;]*?\s+from\s+)?['"](\.[^'"]+)['"]/gm)){
   const target=resolve(dirname(path),match[1]);
   if(target===runtime){runtimePaths.add(target);continue;}
   const local=relative(assets,target);
   if(local.startsWith('..')||isAbsolute(local)||!target.endsWith('.mjs'))throw new Error(`Unsupported drawing dependency: ${match[1]}`);
   code(target,'dependency');
  }
 };
 const patterns=selected.map(id=>{
  const entry=catalog.get(id);
  const referencePaths=[entry.doc??entry.code,...(entry.extraDocs??[])].map(name=>join(references,`${name}.md`));
  referencePaths.forEach(path=>addText(path,'reference'));
  const codePath=join(assets,`${entry.code}.mjs`);
  code(codePath,'code');
  const imagePath=join(assets,`${entry.image??entry.code}.png`);
  if(!statSync(imagePath).isFile())throw new Error(`Missing reference image: ${imagePath}`);
  imagePaths.add(imagePath);
  return {id,applicability:entry.label,referencePaths,codePath,imagePath};
 });
 return {kind:'drawing-pattern-reference-bundle',patterns,resources:[...resources.values()],
  runtimePaths:[...runtimePaths],readImagesNext:[...imagePaths],
  nextAction:'For these selected patterns, read their code/notes and use read_image on the returned images. Common rules: actual confirmed parts/pins, local mm on 1.27 mm grid, all place before connect, explicit junctions and planned wire paths; the parent/runtime handles public labels, power conversion and saving. Keep important text and pins readable; inspect actual previews and fix concrete defects together, not conservative warning counts. Reuse identical resources. This read-only bundle does not generate or validate a circuit.',complete:true};
}

try{
 const ids=process.argv.slice(2);
 if(ids.length===1&&ids[0]==='--list')console.log(JSON.stringify({patterns:[...catalog].map(([id,entry])=>({id,applicability:entry.label}))}));
 else console.log(JSON.stringify(readPatterns(ids)));
}catch(error){
 console.error(JSON.stringify({status:'error',message:error.message,nextAction:'Correct the selected IDs or missing resource; do not scan the installation or generate a test circuit.'}));
 process.exitCode=1;
}

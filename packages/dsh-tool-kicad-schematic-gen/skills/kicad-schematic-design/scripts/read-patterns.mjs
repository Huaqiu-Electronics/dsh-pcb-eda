/** Read selected drawing references without running code or generating files. */
import {readFileSync,statSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const skillDir=fileURLToPath(new URL('../',import.meta.url));
const assets=join(skillDir,'assets','drawing-patterns');
const references=join(skillDir,'references','drawing-patterns');
const runtime=join(skillDir,'assets','runtime.mjs');
const catalog=new Map([
 ['usb-c-device',{label:'USB 2.0 UFP/sink',code:'usb-c-device'}],
 ['ldo-three-pin',{label:'VIN/VOUT/GND 三脚固定 LDO',code:'ldo-three-pin'}],
 ['ldo-fixed-on',{label:'带 EN 且已确认 EN 接 VIN 的固定 LDO',code:'ldo-fixed-on'}],
 ['reset-rc',{label:'已确认有效低的复位 RC',code:'reset-rc',extraDocs:['reset-enable']}],
 ['pullup-button',{label:'上拉、按下接地按键',code:'pullup-button',extraDocs:['reset-enable']}],
 ['decoupling-bank',{label:'同电源域并联去耦',code:'decoupling-bank'}],
 ['led-power-indicator',{label:'电源经限流电阻、LED 接地',code:'led-power-indicator'}],
 ['i2c-pullups',{label:'同电压域 I2C 上拉',code:'i2c-pullups'}],
 ['crystal-load',{label:'无源晶体及外部负载电容',code:'crystal-load'}],
 ['dcdc-buck',{label:'异步 Buck',code:'dcdc-buck'}],
 ['dcdc-boost',{label:'异步 Boost',code:'dcdc-boost'}],
 ['mcu-minimum',{label:'STM32F030 内部 RC 示例；不能直接套 ESP32',code:'mcu-minimum'}],
 ['mcu-external-crystal',{label:'STM32F030 外部无源晶体示例',code:'mcu-external-crystal',extraDocs:['mcu-minimum']}],
 ['mosfet-low-side',{label:'N-MOSFET 低侧感性负载开关',code:'mosfet-low-side'}],
 ['swd-header',{label:'五针 SWD 排针',code:'swd-header'}],
 ['label-sides',{label:'左右信号标签对齐',code:'label-alignment',doc:'label-alignment',image:'label-sides'}],
 ['label-vertical',{label:'上下信号标签对齐',code:'label-alignment',doc:'label-alignment',image:'label-vertical'}],
]);

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
  nextAction:'Read the returned full code and applicability notes, then use read_image on each selected reference image before first layout. Paths/Markdown links are not image reads. Reuse already reviewed identical resources; map actual parts/pins and record any adaptation. No circuit generation or electrical validation occurred.',complete:true};
}

try{
 const ids=process.argv.slice(2);
 if(ids.length===1&&ids[0]==='--list')console.log(JSON.stringify({patterns:[...catalog].map(([id,entry])=>({id,applicability:entry.label}))}));
 else console.log(JSON.stringify(readPatterns(ids)));
}catch(error){
 console.error(JSON.stringify({status:'error',message:error.message,nextAction:'Correct the selected IDs or missing resource; do not scan the installation or generate a test circuit.'}));
 process.exitCode=1;
}

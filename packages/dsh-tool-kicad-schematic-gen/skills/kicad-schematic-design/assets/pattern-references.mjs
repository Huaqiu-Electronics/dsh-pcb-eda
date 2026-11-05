/** Shared reference metadata; reads selected notes/images, never runs circuit examples. */
import {readFileSync,statSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const skillDir=fileURLToPath(new URL('../',import.meta.url));
export const assets=join(skillDir,'assets','drawing-patterns');
export const references=join(skillDir,'references','drawing-patterns');
export const runtime=join(skillDir,'assets','runtime.mjs');
export const catalog=new Map([
 ['usb-c-device',{label:'USB 2.0 UFP/sink',code:'usb-c-device'}],
 ['ldo-three-pin',{label:'VIN/VOUT/GND 三脚固定 LDO',code:'ldo-three-pin'}],
 ['ldo-fixed-on',{label:'带 EN 且已确认 EN 接 VIN 的固定 LDO',code:'ldo-fixed-on'}],
 ['reset-rc',{label:'已确认有效低的复位 RC',code:'reset-rc',doc:'reset-enable'}],
 ['pullup-button',{label:'上拉、按下接地按键',code:'pullup-button',doc:'reset-enable'}],
 ['decoupling-bank',{label:'同电源域并联去耦',code:'decoupling-bank'}],
 ['led-power-indicator',{label:'电源经限流电阻、LED 接地',code:'led-power-indicator'}],
 ['i2c-pullups',{label:'同电压域 I2C 上拉',code:'i2c-pullups'}],
 ['crystal-load',{label:'无源晶体及外部负载电容',code:'crystal-load'}],
 ['dcdc-buck',{label:'异步 Buck',code:'dcdc-buck'}],
 ['dcdc-boost',{label:'异步 Boost',code:'dcdc-boost'}],
 ['mcu-minimum',{label:'STM32F030 内部 RC 示例；不能直接套 ESP32',code:'mcu-minimum'}],
 ['mcu-external-crystal',{label:'STM32F030 外部无源晶体示例',code:'mcu-external-crystal'}],
 ['mosfet-low-side',{label:'N-MOSFET 低侧感性负载开关',code:'mosfet-low-side'}],
 ['swd-header',{label:'五针 SWD 排针',code:'swd-header'}],
 ['label-sides',{label:'左右信号标签对齐',code:'label-alignment',doc:'label-alignment',image:'label-sides'}],
 ['label-vertical',{label:'上下信号标签对齐',code:'label-alignment',doc:'label-alignment',image:'label-vertical'}],
]);

export function validateReferencePatterns(ids){
 if(!Array.isArray(ids)||ids.some(id=>!catalog.has(id)))
  throw new Error('MODULE_REFERENCE_PATTERN_INVALID: referencePatterns must contain known drawing-pattern IDs; use read-patterns.mjs --list');
 return [...new Set(ids)];
}

/** Conservative fallback for old manifests. Explicit [] disables matching for a custom circuit. */
export function moduleReferencePatterns(mod,parts,plan){
 if(mod.referencePatterns!==undefined)return validateReferencePatterns(mod.referencePatterns);
 const entries=Object.entries(mod.partRoles).map(([role,key])=>({ref:mod.references[role],part:parts[key]}));
 const hasPin=(p,re)=>Object.keys(p.pins??{}).some(k=>re.test(k));
 const ids=new Set(),groups=mod.expectedConnections??[];
 for(const {part:p} of entries){
  if(hasPin(p,/^cc1$/i)&&hasPin(p,/^cc2$/i))ids.add('usb-c-device');
  if(hasPin(p,/^vin$/i)&&hasPin(p,/^vout\d*$/i)&&hasPin(p,/^gnd\d*$/i)&&!hasPin(p,/^(en|enable)$/i))ids.add('ldo-three-pin');
 }
 const refsIn=(g,re)=>g.pins.some(p=>re.test(p.reference));
 for(const group of groups){
  if(refsIn(group,/^R\d/) && refsIn(group,/^(SW|S)\d/)){
   if(/(?:^|__)(?:EN|RESET|NRST)$/i.test(group.net)&&refsIn(group,/^C\d/))ids.add('reset-rc');
   else if(/(?:^|__)BOOT\d*$/i.test(group.net))ids.add('pullup-button');
  }
 }
 const grounds=new Set(entries.flatMap(({part:p,ref})=>Object.entries(p.pins??{}).filter(([k])=>/^gnd\d*$/i.test(k)).map(([,pin])=>ref+'.'+pin)));
 const supplies=groups.filter(g=>Object.hasOwn(plan.power.nets,g.net)&&!g.pins.some(p=>grounds.has(p.reference+'.'+p.pin))&&!/^(?:GND|[AD]GND)$/i.test(g.net));
 if(supplies.some(g=>refsIn(g,/^U\d/)&&refsIn(g,/^C\d/))&&!ids.has('ldo-three-pin'))ids.add('decoupling-bank');
 const groundGroups=groups.filter(g=>g.pins.some(p=>grounds.has(p.reference+'.'+p.pin))||/^(?:GND|[AD]GND)$/i.test(g.net));
 // Do not match active-low MCU indicator circuits to a supply-to-ground example.
 if(groups.some(g=>{
  const r=g.pins.find(p=>/^R\d/.test(p.reference)),led=g.pins.find(p=>/^LED\d/.test(p.reference));
  return r&&led&&supplies.some(s=>s.pins.some(p=>p.reference===r.reference&&p.pin!==r.pin))
   &&groundGroups.some(s=>s.pins.some(p=>p.reference===led.reference&&p.pin!==led.pin));
 }))ids.add('led-power-indicator');
 return [...ids];
}

export function patternMetadata(ids){
 return validateReferencePatterns(ids).map(id=>{
  const entry=catalog.get(id);
  return {id,applicability:entry.label,
   referencePaths:[entry.doc??entry.code,...(entry.extraDocs??[])].map(name=>join(references,`${name}.md`)),
   codePath:join(assets,`${entry.code}.mjs`),imagePath:join(assets,`${entry.image??entry.code}.png`)};
 });
}

export function moduleReferenceBundle(ids){
 const patterns=patternMetadata(ids),notes=new Map(),images=[...new Set(patterns.map(p=>p.imagePath))];
 for(const p of patterns)for(const path of p.referencePaths)if(!notes.has(path))notes.set(path,readFileSync(path,'utf8'));
 for(const path of images)if(!statSync(path).isFile())throw new Error(`Missing reference image: ${path}`);
 const content='# 本模块画法参考\n\n写首版前读本文件，再用 read_image 逐张读取下列参考图；路径列表或生成预览不能代替读参考图。只借鉴排列、短线及文字留白，实际器件/引脚/参数/接法以任务和确认方案为准；不直接套用代码或照搬示例型号。图样不匹配时说明差异，图片不可读时上报。\n\n'
  +patterns.map(p=>`- ${p.id}：${p.applicability}；图片：${p.imagePath}`).join('\n')+'\n\n'
  +[...notes].map(([path,text])=>`来源：${path}\n\n${text.replace(/\]\((\.\.?\/[^)]+)\)/g,
   (_match,target)=>`](${resolve(dirname(path),target).replaceAll('\\','/')})`)}`).join('\n\n---\n\n');
 return {patterns,images,content};
}

/** Prepare short dispatch messages and independent task documents. No model calls or writes. */
import {accessSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectPath,loadConfirmedParts,moduleContractSha256,digest,describeModuleParts} from './module-runtime.mjs';
import {moduleStarter} from './module-authoring.mjs';
import {moduleReferencePatterns,moduleReferenceBundle} from './pattern-references.mjs';
import {assessModuleSpace} from './module-space.mjs';

const code=value=>'`'+String(value).replaceAll('`','\\`').replaceAll('|','\\|').replaceAll('\n',' ')+'`';

export async function prepareModuleTasks(contract,{feedback={}}={}){
 const parts=await loadConfirmedParts(contract);
 const skill=fileURLToPath(new URL('../',import.meta.url));
 const checker=resolve(skill,'scripts/check-module.mjs');
 for(const file of [contract.plan.parts,...contract.plan.sharedSources,...contract.plan.resources])accessSync(projectPath(contract,file));
 const tasks=contract.plan.modules.map(mod=>{
  const contractSha256=moduleContractSha256(contract,mod.id);
  const scope=[mod.entry,...mod.sources];
  const catalog=describeModuleParts(contract,mod,parts),geometry={version:1,coordinateSystem:'native angle=0, relative to symbol centre; use region.pin after rotation/mirror',parts:{}};
  const space=contract.spaceAssessment?.find(s=>s.moduleId===mod.id)??assessModuleSpace(mod,catalog,undefined,{paper:contract.plan.project.paper});
  for(const [role,key] of Object.entries(mod.partRoles))if(!geometry.parts[key]){
   const entries=catalog.filter(o=>o.reference===mod.references[role]);
   geometry.parts[key]=entries.map(({reference,...entry})=>entry);
  }
  const geometryContent=JSON.stringify(geometry,null,2)+'\n';
  const geometryPath=projectPath(contract,`work/tasks/${mod.id}/geometry-${digest(geometryContent)}.json`);
  const files=[{path:projectPath(contract,mod.entry),content:moduleStarter(mod),preserveExisting:true},
   {path:geometryPath,content:geometryContent,preserveExisting:false}];
  const referenceIds=moduleReferencePatterns(mod,parts,contract.plan);
  const referenceBundle=referenceIds.length?moduleReferenceBundle(referenceIds):undefined;
  const referencePath=referenceBundle?projectPath(contract,`work/tasks/${mod.id}/references-${digest(referenceBundle.content)}.md`):undefined;
  if(referenceBundle)files.push({path:referencePath,content:referenceBundle.content,preserveExisting:false});
  const referenceInstruction=referenceBundle
   ?`写首版前：读取 ${code(referencePath)}（已合并去重的本模块说明），再用 read_image 读取 ${referenceBundle.images.map(code).join('、')}。选定 ${referenceIds.map(code).join('、')}；参考排列而非照抄接法/脚号，不加载其他图样源码。图片不可读或图样不适用须上报差异。`
   :'未匹配通用图样；按确认方案和实际几何自行设计。若有适用参考向主 agent 提供 ID，由其补入 referencePatterns；不套其他芯片整图。';
  const components=Object.entries(mod.partRoles).map(([role,key])=>{
   const part=parts[key];
   if(!part)throw new Error(`MODULE_PARTS_INVALID: ${mod.id} missing parts.${key}`);
   return `- ${code(role)} → ${code(mod.references[role])}，${code(key)}，数值/型号 ${code(part.value??'未提供，派发前补齐 value')}`;
  }).join('\n');
  const pinRoles=[...new Set(Object.values(mod.partRoles))]
   .map(key=>`- ${code(key)}：${code(JSON.stringify(parts[key].pins??{}))}`).join('\n');
  const ports=Object.entries(mod.ports).map(([name,p])=>`- ${code(name)}：${code(p.reference+'.'+p.pin)} → ${code(p.net)}（${code(p.voltage)}）`
   +(p.labelAt?`；规划 labelAt=${code(JSON.stringify(p.labelAt))}，angle=${code(p.angle??0)}（仅建议，返回实际落点）`:'；未指定落点时标签在真实引脚端')).join('\n');
  const [exampleRole,exampleKey]=Object.entries(mod.partRoles).find(([,key])=>Object.keys(parts[key]?.pins??{}).length)
   ??Object.entries(mod.partRoles)[0];
  const examplePin=Object.keys(parts[exampleKey]?.pins??{})[0];
  const [portName,port]=Object.entries(mod.ports)[0];
  const examplePorts={[portName]:{reference:port.reference,pin:port.pin}};
  const example=examplePin?`export function place({draw,bounds}){
 draw.put(${JSON.stringify(exampleRole)},{at:[30.48,30.48]});
 // 补齐全部器件，并保留骨架全部端口；这里只展示一个端口。
 return {bounds,ports:${JSON.stringify(examplePorts)},connect(){
  const p=draw.pin(${JSON.stringify(exampleRole)},${JSON.stringify(examplePin)});
  draw.wire(p,draw.offset(p,5.08,0),{axis:'x'});
  // 按第3节补全实际网络；公共端口不要再 draw.label。
 }};
}`:'';
  const connections=(mod.expectedConnections??[]).map(g=>`- ${code(g.net)}${g.namePolicy==='connectivity'?'（内部网按连通性核对）':''}：${g.pins.map(p=>code(p.reference+'.'+p.pin)).join('、')}`).join('\n')
   ||'未声明 expectedConnections；检查通过不能视为完整连接已验证。';
  const changes=feedback[mod.id]?`\n本轮返工要求：\n${String(feedback[mod.id]).split('\n').map(line=>'> '+line).join('\n')}\n`:'';
  const document=`# 模块 ${mod.id}：${mod.goal}

只读任务快照，总清单由主 agent 管理；约定变化上报，不改此文件。
模块版本：${code(contractSha256)}；清单：${code(contract.file)}。

## 1. 范围

仅完成本模块，不重新确认需求、选型或派发。只写 ${scope.map(code).join('、')} 和 ${code(`work/modules/${mod.id}/`)}；主入口、方案、清单、共享器件和库由主 agent 管理。文件范围是协作约定。
依赖：${mod.dependsOn.length?mod.dependsOn.map(code).join('、'):'无'}。

## 2. 已确认器件

${components}
引脚语义（按器件键去重）：
${pinRoles}
器件表：${code(projectPath(contract,contract.plan.parts))}。draw.put 已固定真实符号/封装/value；不拼库路径或更换器件，缺具体属性才查表。

## 3. 连接约定

网络角色：${code(JSON.stringify(mod.nets))}。公共端口：
${ports}
预期连接：
${connections}
内部网络使用 ${code(mod.id+'__')} 前缀。实际引脚完整连接或明确不连接；重复电源、外壳和地脚须核对。

## 4. 设计约束

模块选择：${code(JSON.stringify(mod.reuse??{decision:'legacy',reason:'已有派发任务，沿用原决定'}))}。new 才从零编写；reuse/adapt 须保留已核实源电路的接法和清楚布局，仅改 reason 中说明的适配项。来源只读；源文件通过 resources 绑定版本。不要把画法参考图当作已下载电路。当前 draw/region 不提供源图导入：需要导入时立即上报主 agent，使用公开 Schematic.importModule 的平铺整合路线；主 agent 协调流程后再执行，不能因接口不支持就静默逐器件重画或伪称已复用。

${referenceInstruction}

region：${code(JSON.stringify(mod.region))}。origin 为全局平移、size 为局部范围，代码用 bounds；不另读全清单或维护 layout.mjs。扩框由主 agent处理，不缩字/符号硬塞。
空间预检：${code(JSON.stringify(space))}。tight 为保守风险提示，不能当作已证明放不下；先规划完整功能组、字段和走线通道。第一次出现 POWER_PLACEMENT_UNAVAILABLE 或明确空间冲突，就把全部空间问题和建议尺寸一次报主 agent，暂停局部挪动试错，等待统一扩框/重排决定；不得自行改共享框。
方案：${code(contract.designPlan.path)}（${code(contract.designPlan.sha256)}），需要时只读本模块相关参数/限制，不以本任务替代手册。共享代码：${contract.plan.sharedSources.map(s=>code(projectPath(contract,s))).join('、')||'无'}。

## 5. 实现入口

补全 ${code(projectPath(contract,mod.entry))} 的骨架，保留已有实现。几何数据：${code(geometryPath)}，尺寸/方向按需读，不拆库或探测源码。自由编写即可，不强套模板。
导出 place({draw,region,parts,references,nets,bounds})，返回 {ports,bounds,connect}；先放完全部器件再 connect。坐标均为本框局部毫米，50mil=1.27mm；旋转/镜像后的端点取实际 pin，不从几何表手算。

| 接口 | 本任务用法 |
| --- | --- |
| draw.put(role,{at,...}) | 固定使用已确认器件、位号、value；可选 angle(0/90/180/270)、mirror(x/y)、unit、referenceAt/valueAt、fieldAngle、hideReference/hideValue；不覆盖器件身份 |
| draw.pin(role,pinRole) | pinRole 是第2节的引脚语义键，不是物理脚号；未映射的物理脚用 region.pin(references.role,'脚号') |
| draw.offset(p,dx,dy)／draw.row(start,count,step=10.16) | 相对平移／沿x排列，不改变真实引脚几何 |
| draw.stub(role,pinRole,dx,dy,{net,angle=0}) | 从真实引脚引短线，net可省略；返回末端点，内部标签随器件移动；公共端口仍由运行时管理 |
| draw.wire(a,b,{axis:'x'或'y'}) | x先水平后竖直，y先竖直后水平；可用laneX或laneY指定通道（二选一），不避障、不自动加接点 |
| draw.label(net,p,angle=0)／draw.junction(p)／draw.nc(role,pinRole) | 内部网络标签／分支接点／NC；未映射脚可用region.marker('no_connect',region.pin(reference,'脚号')) |

公共 ports 保留第3节的 reference/pin，pin为物理脚号；返回 labelAt（局部点）/angle 决定实际标签落点。运行时从引脚先水平再竖直引至落点，未给labelAt时落在引脚端；不保证避开符号或其它引脚，勿在 connect 重复画公共标签。**内部明确命名网络和电源仍须 draw.label 到实际线上**；运行时只统一转换电源标签，不替你补接地或命名 EN/BOOT。

${example?`语法示例（局部接口演示，不是完整电路；坐标按实际尺寸调整）：\n\n\`\`\`js\n${example}\n\`\`\`\n`:''}
在脚本中先定功能组位置与走线通道，再放器件。输入→保护→稳压→输出顺读；LDO两侧电容、RC/按键、R+LED组成紧凑支路，相邻器件用短直接线，标签用于跨框或较长网络，不把同一小电路拆成标签孤岛。按实际引脚方向向外起线，分支显式接点，避开其它引脚/地母线；器件与文字成行、留白均匀，不为填满大框拉散。框过大报告主 agent 收紧。长型号/数值/电源预留空间，默认字段仅有限调整且保留显式位置；保留实际 value。
connect内现取draw.pin，短线/标签用draw.stub或draw.offset，相邻器件直接用两个pin连接。修改功能组的锚点/间距，不在全脚本批量替换坐标数字；移动器件时一起核对该组连线。WIRE_ROUTE_INVALID按全部issues集中修复，无效图不会保存为候选。
任务足以开始编写，不默认读完整 skill、总清单或兄弟脚本。具体接口缺失才查 ${code(resolve(skill,'references/programming.md'))}，具体画法问题只查选定项；不扫描目录、读 builder/检查器源码或写探测工程。缺信息上报。

## 6. 检查与提交

调用 check_and_preview_kicad_module(${JSON.stringify({manifestPath:contract.file,moduleId:mod.id})})，含语法、构建、声明连接和预览，不重复预检。不可用才在项目根执行 node ${JSON.stringify(checker)} module-plan.json ${JSON.stringify(mod.id)} work/modules/${mod.id}/candidate-<唯一run-id> 并预览；候选预览不传projectDir，不发布。
工具返回 reviewPlan.issues 有界问题摘要、issueCount/omittedIssues、repairPlan 和已批量生成的整框/局部图。omittedIssues>0 或 repairPlan.fullReportRequired=true 必须定向读 reportPath 中遗漏的诊断，不能只修返回的前几项。repairPlan.stage=structure 先集中修语法/网名/漏接/错连；stage=resize 先汇总空间问题交主 agent 统一扩框/重排，不继续逐个挪动尝试；stage=layout 一次读当前整框和相关局部图，汇总全部确认问题后批量改脚本。近似重叠单独待读图确认，不因未清零而重建。reviewPlan.mode=changed_regions 时优先复核改动对象、原位置及遗留问题，仅沿用实际检查过的未变区域结论；unchanged 只表示画面未变，不表示验收通过。现有图片清晰时不再用 PowerShell/Python 手工裁图。所有确认缺陷修复后调用同一工具并传 reviewMode:"full"，实际读最终整框一次后再提交。
文字0或默认字段零未决不保证可读：核对文字压图形/脚号、数值归属、标签和接点。图片不可见须上报，不能宣称目检通过。误报说明位置，不追求清零；未检查不算零问题，不手写通过报告。可读性达标后的对齐/留白偏好不反复重建；真实错误不受轮数限制。
布局检查同时看功能组是否紧凑、相邻支路是否被标签拆散及主信号是否易读；这些属于可读性缺陷，不能以零检测问题放行。
本轮可构建修复，但只交付一次：固定候选、check.json、实际已读参考图与候选图、参考差异、结论及遗留位置。提交后结束，小修交主 agent；真实错误未解须阻塞，共享接口/空间问题提前报告。仅明确大范围重做/中断才续派，主 agent接管前确认本任务停止。
${changes}`;
  const documentSha256=digest(document);
  // Immutable revisions keep active workers on their exact assigned instructions.
  const documentPath=projectPath(contract,`work/tasks/${mod.id}/${documentSha256}/task.md`);
  const prompt=`你是原理图模块子 agent，仅完成模块 ${mod.id}。先完整读取任务文档 ${JSON.stringify(documentPath)}（SHA256 ${documentSha256}），再读第4节指定的参考说明和参考图片，然后补全指定脚本。按需读几何，不默认加载整套参考或源码。按文档检查并一次提交。\n`
   +`项目：${contract.root}；允许修改：${scope.join('、')} 和 work/modules/${mod.id}/。总清单是唯一配置来源；任务文档只读，约定变化或有阻塞向主 agent 报告。`;
  return {id:mod.id,dependsOn:mod.dependsOn,cwd:contract.root,description:`生成原理图模块 ${mod.id}`,
   contractSha256,documentPath,documentSha256,document,prompt,files,geometryPath,referenceIds,referencePath};
 });
 return {version:1,manifestPath:contract.file,manifestSha256:contract.manifestSha256,maxParallel:contract.plan.maxParallel,tasks,
  nextAction:'Persist documents, delegate each module once, then verify runtime completion and fill unstarted slots. Parent batches minor repairs and rechecks them; do not automatically resume stale/failed children. Review images and cross-module connections before assembly.'};
}

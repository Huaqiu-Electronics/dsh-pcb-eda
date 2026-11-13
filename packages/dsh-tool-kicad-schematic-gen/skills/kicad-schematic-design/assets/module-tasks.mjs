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
  let pinBudget=6000;
  const pinGeometry=Object.entries(geometry.parts).map(([key,units])=>{
   const aliases=parts[key].pins??{};
   const lines=units.map(({unit,pins,bounds,fields})=>{
    const entries=(pins??[]).map(({number,name,at,outward})=>`${number} ${name} @(${at.join(',')})${outward?` →(${outward.join(',')})`:''}`);
    const layout=[bounds&&`外接范围(左,上,右,下)=${[bounds.left,bounds.top,bounds.right,bounds.bottom].join(',')}`,
     ...(fields??[]).map(field=>`${field.name} @(${field.at.join(',')}) ${field.angle}° ${field.hidden?'隐藏':'显示'}`)].filter(Boolean).join('；');
    return `  - 单元 ${unit}：${code(entries.join('；')||'无引脚')}${layout?`；${code(layout)}`:''}`;
   }).join('\n');
   const heading=`- ${code(key)}，引脚语义键→物理脚号 ${code(JSON.stringify(aliases))}`;
   if(lines.length>pinBudget)return `${heading}；完整引脚坐标见几何文件中的此器件键。`;
   pinBudget-=lines.length;
   return `${heading}\n${lines}`;
  }).join('\n');
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
实际引脚和字段（原生角度 0，相对符号原点的毫米坐标；→(dx,dy) 是引线向外的方向，图纸 Y 向下）：
${pinGeometry}
完整几何与边界：${code(geometryPath)}。只在上表未列出该器件或需要符号边界时定向读取对应器件键。
器件表：${code(projectPath(contract,contract.plan.parts))}。draw.put 已固定真实符号/封装/value；不拼库路径或更换器件，缺具体属性才查表。

## 3. 连接约定

网络角色：${code(JSON.stringify(mod.nets))}。公共端口：
${ports}
预期连接：
${connections}
方案确认不接的物理脚：${(mod.expectedNoConnects??[]).map(p=>code(p.reference+'.'+p.pin)).join('、')||'未列出；需要有意悬空时按方案确认'}。运行时为清单中的脚和库定义的 no_connect 脚统一放置 KiCad 原生蓝叉，保留引脚电气类型。不得用文字或图形画叉，也不得把所有未布线的引脚自动认定为不接。
须保留准确网名：${[...new Set((mod.expectedConnections??[]).filter(g=>g.namePolicy!=='connectivity').map(g=>g.net))].map(code).join('、')||'无显式声明'}。公共端口由运行时落标签；内部准确网名用骨架中的物理脚号标签锚点，按实际布局调整。
内部网络使用 ${code(mod.id+'__')} 前缀。实际引脚完整连接或明确不连接；重复电源、外壳和地脚须核对。

## 4. 设计约束

模块选择：${code(JSON.stringify(mod.reuse??{decision:'legacy',reason:'已有派发任务，沿用原决定'}))}。new 才从零编写；reuse/adapt 须保留已核实源电路的接法和清楚布局，仅改 reason 中说明的适配项。来源只读；源文件通过 resources 绑定版本。不要把画法参考图当作已下载电路。当前 draw/region 不提供源图导入：需要导入时立即上报主 agent，使用公开 Schematic.importModule 的平铺整合路线；主 agent 协调流程后再执行，不能因接口不支持就静默逐器件重画或伪称已复用。

${referenceInstruction}

region：${code(JSON.stringify(mod.region))}。origin 为全局平移、size 为预留范围，代码用 bounds。默认出图后按实际器件、字段、线、标签和电源符号在预留范围内自动收框；autoFit:false 使用固定框。在预留范围内紧凑画图，为标题和说明留空间，避免为了填框拉散器件。不足时向主 agent 汇报，不自行改共享清单。
空间预检：${code(JSON.stringify(space))}。tight 为保守风险提示，不能当作已证明放不下；先规划完整功能组、字段和走线通道。第一次出现 POWER_PLACEMENT_UNAVAILABLE 或明确空间冲突，就把全部空间问题和建议尺寸一次报主 agent，暂停局部挪动试错，等待统一扩框/重排决定；不得自行改共享框。
方案：${code(contract.designPlan.path)}（${code(contract.designPlan.sha256)}），需要时只读本模块相关参数/限制，不以本任务替代手册。共享代码：${contract.plan.sharedSources.map(s=>code(projectPath(contract,s))).join('、')||'无'}。

## 5. 实现入口

补全 ${code(projectPath(contract,mod.entry))} 的骨架，保留已有实现。先用第2节实际引脚和第3节连接清单起草摆放及连线，不另用 shell 提取引脚。自由编写即可，不强套模板。
导出 place({draw,region,parts,references,nets,bounds})，返回 {ports,bounds,connect}；先放完全部器件再 connect。坐标均为本框局部毫米，50mil=1.27mm；旋转/镜像后的端点取实际 pin，不从几何表手算。

| 接口 | 本任务用法 |
| --- | --- |
| draw.put(role,{at,...}) | 使用已确认的器件、位号和值。竖放两脚阻容的位号和值固定在右侧，横放阻容和其他器件默认在上方。摆器件、接线时给该位置留空。可选 angle(0/90/180/270)、mirror(x/y)、unit、fieldAngle、hideReference/hideValue。特殊位置用 referenceOffset/valueOffset（从器件原点沿图纸轴偏移）或 referenceAt/valueAt（模块内坐标）。同一字段只能选择一种。 |
| draw.putSeries(role,{at,from,input,output,...}) | 已确认串联的双引脚器件优先用此接口。先放上游器件，from 用其实际引脚坐标，input/output 用串联器件引脚语义键，at 给出预留位置。自动选朝向、对齐入口；显式 angle 时按该角度尝试对齐。connect() 中用实际引脚直连，输出标签放到出口侧。 |
| draw.pin(role,pinRole) | pinRole 是第2节的引脚语义键，不是物理脚号；未映射的物理脚用 region.pin(references.role,'脚号') |
| draw.offset(p,dx,dy)／draw.row(start,count,step=10.16) | 相对平移／沿x排列，不改变真实引脚几何 |
| draw.stub(role,pinRole,dx,dy,{net,angle=0}) | 从真实引脚引短线，net可省略；返回末端点，内部标签随器件移动；公共端口仍由运行时管理 |
| draw.pinStub(reference,number,dx,dy,{net,angle=0}) | 同上，直接使用位号和物理脚号；dx=dy=0 时标签落在脚端 |
| draw.wire(a,b,{axis:'x'或'y'}) | x先水平后竖直，y先竖直后水平；可用laneX或laneY指定通道（二选一），不避障、不自动加接点 |
| draw.wirePins(from,to,route) | 两端各传 {reference,pin}，直接用第3节确认的物理脚号；route 同 draw.wire |
| draw.label(net,p,angle=0)／draw.junction(p)／draw.nc(role,pinRole) | 内部网络标签／分支接点／NC；实际确认不连接的物理脚可用 draw.ncPin(reference,number) |

公共 ports 保留第3节的 reference/pin，pin为物理脚号。只挂网标的普通信号脚默认由运行时按实际朝向成组画等长短直线，左右标签横排、上下标签竖排；首稿不为错开文字逐脚拉成长阶梯。EN、BOOT 等已有连线的功能网络按实际节点给 labelAt（局部点）/angle；有意固定位置可返回 labelLayout:'manual'。勿在 connect 重复画公共标签。内部明确命名网络和电源仍须 draw.label 到实际线上。

${example?`语法示例（局部接口演示，不是完整电路；坐标按实际尺寸调整）：\n\n\`\`\`js\n${example}\n\`\`\`\n`:''}
在脚本中先定功能组位置与走线通道，再放器件。输入→保护→稳压→输出顺读；LDO两侧电容、RC/按键、R+LED组成紧凑支路，相邻器件用短直接线，标签用于跨框或较长网络，不把同一小电路拆成标签孤岛。按实际引脚方向向外起线，分支显式接点，避开其它引脚/地母线；器件与文字成行，内部留白均匀。长型号/数值/电源预留空间，默认字段仅有限调整且保留显式位置；保留实际 value。
同一功能组内相邻且已确认同网的供电脚或地脚，优先用短支路汇到小母线，每个电源网只在该连通组标一次。若对外电源端口的标签已落在这条母线上，直接复用它。相隔较远、跨框或短线会穿过其他电路时，保留独立的同名标签；不同电源域按清单分别接线。
电源入口、稳压输出、主供电/地母线优先用电源符号，同页远端和小支路用黑色本地网标，网名须与电源符号完全一致。可用 draw.label 的 powerStyle:'symbol' 或 powerStyle:'label' 指定，draw.stub 和返回的电源端口也支持。省略时模块每个电源网优先选公共端口作代表符号，其余独立接点保留本地网标。
connect内现取draw.pin，短线/标签用draw.stub或draw.offset，相邻器件直接用两个pin连接。修改功能组的锚点/间距，不在全脚本批量替换坐标数字；移动器件时一起核对该组连线。WIRE_ROUTE_INVALID按全部issues集中修复，无效图不会保存为候选。
任务足以开始编写，不默认读完整 skill、总清单或兄弟脚本。具体接口缺失才查 ${code(resolve(skill,'references/programming.md'))}，具体画法问题只查选定项；不扫描目录、读 builder/检查器源码或写探测工程。缺信息上报。

## 6. 检查与提交

调用 review_kicad_module_candidate(${JSON.stringify({manifestPath:contract.file,moduleId:mod.id})})，含语法、构建、声明连接和预览，不重复预检。不可用才在项目根执行 node ${JSON.stringify(checker)} module-plan.json ${JSON.stringify(mod.id)} work/modules/${mod.id}/candidate-<唯一run-id> 并预览；候选预览不传projectDir，不发布。
工具返回 reviewPlan.issues、priorityCounts 和 repairPlan。must_fix 先集中处理；visual_check 用图确认；advisory 是近似重叠提示，只有确认遮挡才改。omittedIssues>0 或 repairPlan.fullReportRequired=true 时，定向读取 reportPath 中本阶段遗漏的诊断。
POWER_SYMBOL_WIRE_CROSSING 表示导线越过电气接点穿入符号笔画。按报告的位号、网名和线段调整电源落点或短引线方向，保留原网络。
PORT_LABEL_LAYOUT_REVIEW 表示一组信号脚没有安全的短直引线落点。看报告列出的脚号和局部图，给该组留出空间或指定手动落点，避免把整侧标签拉成长阶梯。
blocked 时本轮没有预览，直接按报告修复，不搜索 PNG；stage=resize 先向主 agent 汇报空间问题和建议尺寸。构建通过后，一次读齐当前整框及相关诊断图，再统一修改。changed_regions 优先看改动、原位置和遗留问题；只沿用实际验过的未变区域结论。优先用现成清晰图片。
流程为首版→检查→集中修复→整框复核。只剩提示时，直接读取 reviewPlan.fullFrameImage 指向的当前整框；已验收就提交。只有需要再请求整框时才调用 reviewMode:"full"，工具可复用未变的候选。图片不可读时提交当前候选、已知问题和待查看位置，标记视觉待主 agent 复核。确认实际缺陷才继续修复。
文字0或默认字段零未决不保证可读：核对文字压图形/脚号、数值归属、标签和接点。图片不可见须上报，不能宣称目检通过。误报说明位置，不追求清零；未检查不算零问题，不手写通过报告。可读性达标后的对齐/留白偏好不反复重建；真实错误不受轮数限制。
布局检查同时看功能组是否紧凑、相邻支路是否被标签拆散及主信号是否易读；这些属于可读性缺陷，不能以零检测问题放行。
本轮只交付一次。把检查工具返回的 handoff 原样附在提交消息中（CLI 回退时从 check.json 补 candidate 路径、报告路径、checkedAt 和 inputSha256）。另外列出视觉状态（已复核/待主 agent 复核）、实际已读的整框/局部图及其对应位号、尚未确认的位置、实际已读参考图和参考差异。只记录本候选实际看过的区域。提交后结束，小修交主 agent；真实错误未解须阻塞，共享接口/空间问题提前报告。
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

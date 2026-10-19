import {test} from 'node:test'
import assert from 'node:assert/strict'
import {attachPinLabels,attachPinLabel,type LabelTarget} from '../src/schematic/label-leads.ts'
import type {FlatPoint} from '../src/schematic/flat.ts'

function fixture(points:Record<string,FlatPoint>){
 const wires:{from:FlatPoint;to:FlatPoint}[]=[],labels:{net:string;at:FlatPoint;angle?:number}[]=[]
 const target:LabelTarget={pin:(_r,p)=>{if(!points[p])throw new Error('missing pin');return points[p]!},
  wire:(from,to)=>{assert.ok(from[0]===to[0]||from[1]===to[1]);wires.push({from,to})},
  label:(net,at,angle)=>{labels.push({net,at,angle});return net}}
 return {target,wires,labels}
}
test('a side group shares a baseline regardless of name length or pin endpoint offsets',()=>{
 const f=fixture({'1':[20,10],'2':[22,12.54]})
 const result=attachPinLabels(f.target,{reference:'U1',direction:'left',textPosition:'outside',pins:[{pin:'1',net:'A'},{pin:'2',net:'VERY_LONG_SIGNAL'}]})
 assert.deepEqual(f.wires,[{from:[20,10],to:[14.92,10]},{from:[22,12.54],to:[14.92,12.54]}])
 assert.deepEqual(f.labels.map(l=>l.angle),[180,180]);assert.deepEqual(result.warnings,[])
})
test('all four sides point text outward and keep straight leads',()=>{
 for(const [direction,angle,at] of [['left',180,[14.92,20]],['right',0,[25.08,20]],['up',90,[20,14.92]],['down',270,[20,25.08]]] as const){
  const f=fixture({'1':[20,20]})
  attachPinLabels(f.target,{reference:'U1',direction,textPosition:'outside',pins:[{pin:'1',net:'NET'}]})
  assert.deepEqual(f.labels[0],{net:'NET',at:[...at],angle})
 }
})
test('bad groups are rejected before mutation, including missing late pins and shared tracks',()=>{
 for(const pins of [[{pin:'1',net:'A'},{pin:'missing',net:'B'}],[{pin:'1',net:'A'},{pin:'1',net:'B'}],[{pin:'1',net:'A'},{pin:'2',net:'B'}]]){
  const f=fixture({'1':[20,20],'2':[22,20]})
  assert.throws(()=>attachPinLabels(f.target,{reference:'U1',direction:'right',pins}));assert.equal(f.wires.length,0);assert.equal(f.labels.length,0)
 }
 const f=fixture({'1':[20,20]})
 assert.throws(()=>attachPinLabels(f.target,{reference:'U1',direction:'right',alignAt:19,pins:[{pin:'1',net:'A'}]}),/outside/)
 assert.equal(f.wires.length,0)
})
test('tight pitch is reported without silently moving anchors or changing nets',()=>{
 const f=fixture({'1':[20,20],'2':[21.27,20]})
 const result=attachPinLabels(f.target,{reference:'U1',direction:'down',alignAt:28,textPosition:'outside',pins:[{pin:'1',net:'A'},{pin:'2',net:'B'}]})
 assert.deepEqual(result.warnings,[{code:'LABEL_PITCH_TIGHT',pins:['1','2'],pitch:1.27}])
 assert.deepEqual(f.labels.map(l=>l.at),[[20,28],[21.27,28]])
})
test('single leads round both endpoints to avoid false diagonal segments from float noise',()=>{
 const f=fixture({'1':[63.239999999999995,20]})
 attachPinLabel(f.target,{reference:'U1',pin:'1',net:'NET',direction:'down'})
 assert.deepEqual(f.wires,[{from:[63.24,20],to:[63.24,25.08]}])
})

test('over-wire labels face inward from aligned outer ends with room for the longest name',()=>{
 for(const [direction,angle] of [['left',0],['right',180],['up',270],['down',90]] as const){
  const horizontal=direction==='left'||direction==='right',negative=direction==='left'||direction==='up',axis=horizontal?0:1
  const f=fixture({'1':[30,30],'2':horizontal?[30,32.54]:[32.54,30]})
  const result=attachPinLabels(f.target,{reference:'U1',direction,pins:[{pin:'1',net:'EN'},{pin:'2',net:'LONG_SIGNAL'}]})
  assert.deepEqual(result.warnings,[])
  assert.equal(f.wires[0]!.to[axis],f.wires[1]!.to[axis])
  assert.ok(Math.abs(f.wires[0]!.to[axis]-30)>=11*1.27+2.54-1e-6)
  assert.equal(f.labels[0]!.angle,angle)
  assert.ok(Math.abs(f.labels[0]!.at[axis]-f.wires[0]!.to[axis]-(negative?1.27:-1.27))<1e-6)
 }
})
test('explicit short baselines report text overflow instead of silently changing the requested line',()=>{
 const f=fixture({'1':[30,30]})
 const result=attachPinLabels(f.target,{reference:'U1',direction:'right',alignAt:35,pins:[{pin:'1',net:'LONG_SIGNAL'}]})
 assert.equal(f.wires[0]!.to[0],35)
 assert.deepEqual(result.warnings,[{code:'LABEL_LEAD_SHORT',pins:['1']}])
})

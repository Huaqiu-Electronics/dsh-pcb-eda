/* ---- Node.js SSR polyfill ---- */
if(typeof HTMLElement==="undefined"){
  globalThis.HTMLElement=class{};
  globalThis.HTMLDivElement=class{};
  globalThis.HTMLSpanElement=class{};
  globalThis.HTMLImageElement=class{};
  globalThis.HTMLCanvasElement=class{};
  globalThis.HTMLTemplateElement=class{};
  globalThis.HTMLUnknownElement=class{};
  globalThis.customElements={define:function(){},get:function(){return null},whenDefined:function(){return Promise.resolve()}};
}
if(!globalThis.document){
  globalThis.document={
    createElement:function(){return{style:{},appendChild:function(){}}},
    createTextNode:function(){return{}},
    createDocumentFragment:function(){return{appendChild:function(){}}},
    head:{appendChild:function(){}},
    body:{appendChild:function(){}},
    querySelector:function(){return null},
    querySelectorAll:function(){return[]},
    importNode:function(n){return n&&n.cloneNode?n.cloneNode(true):n}
  };
}

import{a as n,g as k,h as R}from"./chunk-XMZBYKYV.js";var O=Symbol("Comlink.proxy"),D=Symbol("Comlink.endpoint"),V=Symbol("Comlink.releaseProxy"),P=Symbol("Comlink.finalizer"),h=Symbol("Comlink.thrown"),L=n(e=>typeof e=="object"&&e!==null||typeof e=="function","isObject"),v={canHandle:n(e=>L(e)&&e[O],"canHandle"),serialize(e){let{port1:t,port2:r}=new MessageChannel;return M(e,t),[r,[r]]},deserialize(e){return e.start(),U(e)}},I={canHandle:n(e=>L(e)&&h in e,"canHandle"),serialize({value:e}){let t;return e instanceof Error?t={isError:!0,value:{message:e.message,name:e.name,stack:e.stack}}:t={isError:!1,value:e},[t,[]]},deserialize(e){throw e.isError?Object.assign(new Error(e.value.message),e.value):e.value}},z=new Map([["proxy",v],["throw",I]]);function j(e,t){for(let r of e)if(t===r||r==="*"||r instanceof RegExp&&r.test(t))return!0;return!1}n(j,"isAllowedOrigin");function M(e,t=globalThis,r=["*"]){t.addEventListener("message",n(function d(s){if(!s||!s.data)return;if(!j(r,s.origin)){console.warn(`Invalid origin '${s.origin}' for comlink proxy`);return}let{id:o,type:g,path:u}=Object.assign({path:[]},s.data),l=(s.data.argumentList||[]).map(m),a;try{let i=u.slice(0,-1).reduce((c,w)=>c[w],e),f=u.reduce((c,w)=>c[w],e);switch(g){case"GET":a=f;break;case"SET":i[u.slice(-1)[0]]=m(s.data.value),a=!0;break;case"APPLY":a=f.apply(i,l);break;case"CONSTRUCT":{let c=new f(...l);a=q(c)}break;case"ENDPOINT":{let{port1:c,port2:w}=new MessageChannel;M(e,w),a=Y(c,[c])}break;case"RELEASE":a=void 0;break;default:return}}catch(i){a={value:i,[h]:0}}Promise.resolve(a).catch(i=>({value:i,[h]:0})).then(i=>{let[f,c]=x(i);t.postMessage(Object.assign(Object.assign({},f),{id:o}),c),g==="RELEASE"&&(t.removeEventListener("message",d),N(t),P in e&&typeof e[P]=="function"&&e[P]())}).catch(i=>{let[f,c]=x({value:new TypeError("Unserializable return value"),[h]:0});t.postMessage(Object.assign(Object.assign({},f),{id:o}),c)})},"callback")),t.start&&t.start()}n(M,"expose");function F(e){return e.constructor.name==="MessagePort"}n(F,"isMessagePort");function N(e){F(e)&&e.close()}n(N,"closeEndPoint");function U(e,t){let r=new Map;return e.addEventListener("message",n(function(s){let{data:o}=s;if(!o||!o.id)return;let g=r.get(o.id);if(g)try{g(o)}finally{r.delete(o.id)}},"handleMessage")),S(e,r,[],t)}n(U,"wrap");function E(e){if(e)throw new Error("Proxy has been released and is not useable")}n(E,"throwIfProxyReleased");function H(e){return y(e,new Map,{type:"RELEASE"}).then(()=>{N(e)})}n(H,"releaseEndpoint");var p=new WeakMap,b="FinalizationRegistry"in globalThis&&new FinalizationRegistry(e=>{let t=(p.get(e)||0)-1;p.set(e,t),t===0&&H(e)});function W(e,t){let r=(p.get(t)||0)+1;p.set(t,r),b&&b.register(e,t,e)}n(W,"registerProxy");function B(e){b&&b.unregister(e)}n(B,"unregisterProxy");function S(e,t,r=[],d=function(){}){let s=!1,o=new Proxy(d,{get(g,u){if(E(s),u===V)return()=>{B(o),H(e),t.clear(),s=!0};if(u==="then"){if(r.length===0)return{then:n(()=>o,"then")};let l=y(e,t,{type:"GET",path:r.map(a=>a.toString())}).then(m);return l.then.bind(l)}return S(e,t,[...r,u])},set(g,u,l){E(s);let[a,i]=x(l);return y(e,t,{type:"SET",path:[...r,u].map(f=>f.toString()),value:a},i).then(m)},apply(g,u,l){E(s);let a=r[r.length-1];if(a===D)return y(e,t,{type:"ENDPOINT"}).then(m);if(a==="bind")return S(e,t,r.slice(0,-1));let[i,f]=C(l);return y(e,t,{type:"APPLY",path:r.map(c=>c.toString()),argumentList:i},f).then(m)},construct(g,u){E(s);let[l,a]=C(u);return y(e,t,{type:"CONSTRUCT",path:r.map(i=>i.toString()),argumentList:l},a).then(m)}});return W(o,e),o}n(S,"createProxy");function G(e){return Array.prototype.concat.apply([],e)}n(G,"myFlat");function C(e){let t=e.map(x);return[t.map(r=>r[0]),G(t.map(r=>r[1]))]}n(C,"processArguments");var _=new WeakMap;function Y(e,t){return _.set(e,t),e}n(Y,"transfer");function q(e){return Object.assign(e,{[O]:!0})}n(q,"proxy");function x(e){for(let[t,r]of z)if(r.canHandle(e)){let[d,s]=r.serialize(e);return[{type:"HANDLER",name:t,value:d},s]}return[{type:"RAW",value:e},_.get(e)||[]]}n(x,"toWireValue");function m(e){switch(e.type){case"HANDLER":return z.get(e.name).deserialize(e.value);case"RAW":return e.value}}n(m,"fromWireValue");function y(e,t,r,d){return new Promise(s=>{let o=X();t.set(o,s),e.start&&e.start(),e.postMessage(Object.assign({id:o},r),d)})}n(y,"requestResponseMessage");function X(){return new Array(4).fill(0).map(()=>Math.floor(Math.random()*Number.MAX_SAFE_INTEGER).toString(16)).join("-")}n(X,"generateUUID");var A=class A{parse_board(t){let r=new TextDecoder().decode(t);return new k().parse(r)}parse_schematic(t){let r=new TextDecoder().decode(t);return new R().parse(r)}};n(A,"ParserWorker");var T=A;M(new T);export{T as ParserWorker};
/*! Bundled license information:

comlink/dist/esm/comlink.mjs:
  (**
   * @license
   * Copyright 2019 Google LLC
   * SPDX-License-Identifier: Apache-2.0
   *)
*/
//# sourceMappingURL=parser.worker.js.map

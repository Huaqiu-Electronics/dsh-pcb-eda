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

var ne=Object.defineProperty;var re=t=>{throw TypeError(t)};var Ae=(t,n,s)=>n in t?ne(t,n,{enumerable:!0,configurable:!0,writable:!0,value:s}):t[n]=s;var u=(t,n)=>ne(t,"name",{value:n,configurable:!0});var Yt=(t,n,s)=>Ae(t,typeof n!="symbol"?n+"":n,s),J=(t,n,s)=>n.has(t)||re("Cannot "+s);var en=(t,n,s)=>(J(t,n,"read from private field"),s?s.call(t):n.get(t)),ie=(t,n,s)=>n.has(t)?re("Cannot add the same private member more than once"):n instanceof WeakSet?n.add(t):n.set(t,s),tn=(t,n,s,i)=>(J(t,n,"write to private field"),i?i.call(t,s):n.set(t,s),s),A=(t,n,s)=>(J(t,n,"access private method"),s);var S=class S{constructor(n,s=null){this.type=n;this.value=s}};u(S,"Token"),S.OPEN=Symbol("opn"),S.CLOSE=Symbol("clo"),S.ATOM=Symbol("atm"),S.NUMBER=Symbol("num"),S.STRING=Symbol("str");var y=S;function G(t){return t>="0"&&t<="9"}u(G,"is_digit");function ae(t){return t>="A"&&t<="Z"||t>="a"&&t<="z"}u(ae,"is_alpha");function O(t){return t===""||t===" "||t===`
`||t==="\r"||t==="	"||t==="|"}u(O,"is_whitespace");function W(t){return ae(t)||G(t)||["_","-",":","!",".","[","]","{","}","@","*","/","&","#","%","+","=","~","$"].includes(t)}u(W,"is_atom");function R(t,n){let s=t.slice(0,n).lastIndexOf(`
`);s<0&&(s=0);let i=t.slice(n).indexOf(`
`);return i<0&&(i=20),t.slice(s,n+i)}u(R,"error_context");function*Ce(t){let n=new y(y.OPEN),s=new y(y.CLOSE),i=0,a=0,o=!1;for(let p=0;p<t.length+1;p++){let c=p<t.length?t[p]:"";if(i==0)if(c==="("){yield n;continue}else if(c===")"){yield s;continue}else if(c==='"'){i=1,a=p;continue}else if(c==="-"||c=="+"||G(c)){i=2,a=p;continue}else if(ae(c)||["*","&","$","/","%"].includes(c)){i=3,a=p;continue}else{if(O(c))continue;if(c==="|")continue;throw new Error(`Unexpected character at index ${p}: ${c}
Context: ${R(t,p)}`)}else if(i==3){if(W(c))continue;if(c===")"||O(c))yield new y(y.ATOM,t.substring(a,p)),i=0,c===")"&&(yield s);else continue}else if(i==2){if(c==="."||G(c))continue;if(c.toLowerCase()==="x"){i=4;continue}else if(["+","-","a","b","c","d","e","f"].includes(c.toLowerCase())){i=3;continue}else if(W(c)){i=3;continue}else if(c===")"||O(c)){yield new y(y.NUMBER,parseFloat(t.substring(a,p))),i=0,c===")"&&(yield s);continue}else throw new Error(`Unexpected character at index ${p}: ${c}, expected numeric.
Context: ${R(t,p)}`)}else if(i==4){if(G(c)||["a","b","c","d","e","f","_"].includes(c.toLowerCase()))continue;if(c===")"||O(c)){let d=t.substring(a,p).replace("_","");yield new y(y.NUMBER,Number.parseInt(d,16)),i=0,c===")"&&(yield s);continue}else if(W(c)){i=3;continue}else throw new Error(`Unexpected character at index ${p}: ${c}, expected hexadecimal.
Context: ${R(t,p)}`)}else if(i==1)if(!o&&c==='"'){yield new y(y.STRING,t.substring((a??0)+1,p).replaceAll("\\n",`
`).replaceAll("\\\\","\\").replaceAll('\\"','"')),i=0,o=!1;continue}else if(!o&&c==="\\"){o=!0;continue}else{o=!1;continue}else throw new Error(`Unknown tokenizer state ${i}
Context: ${R(t,p)}`)}}u(Ce,"tokenize");function*oe(t){let n,s;for(;;)switch(s=t.next(),n=s.value,n?.type){case y.ATOM:case y.STRING:case y.NUMBER:yield n.value;break;case y.OPEN:yield Array.from(oe(t));break;case y.CLOSE:case void 0:return}}u(oe,"listify_tokens");function z(t){let n=Ce(t);return Array.from(oe(n))}u(z,"listify");var B,j,M=class M{constructor(n,s=1){this.name=n;this.level=s;ie(this,B)}debug(...n){this.level>=2&&A(this,B,j).call(this,console.debug,...n)}info(...n){this.level>=1&&A(this,B,j).call(this,console.info.bind(console),...n)}warn(...n){this.level>=0&&A(this,B,j).call(this,console.warn,...n)}error(...n){this.level>=0&&A(this,B,j).call(this,console.error,...n)}};B=new WeakSet,j=u(function(n,...s){},"#log"),u(M,"Logger");var C=M,on=new C("kicad-parser");var se=new C("kicanvas:parser"),N=u(t=>typeof t=="string","is_string"),le=u(t=>typeof t=="number","is_number");var r={any(t,n,s){return s},boolean(t,n,s){switch(s){case"false":case"no":return!1;case"true":case"yes":return!0;default:return!!s}},string(t,n,s){if(N(s))return s},number(t,n,s){if(le(s))return s},item(t,...n){return(s,i,a)=>t(a,...n)},object(t,...n){return(s,i,a)=>{let o={};return t!==null&&(o=s[i]??t??{}),{...o,...m(a,e.start(i),...n)}}},vec2(t,n,s){let i=s;return{x:i[1]||0,y:i[2]||0}},vec4(t,n,s){let i=s;return{x:i[1]||0,y:i[2]||0,z:i[3]||0,w:i[4]||0}},color(t,n,s){let i=s;return{r:i[1]/255,g:i[2]/255,b:i[3]/255,a:i[4]??1}}},e={start(t){return{kind:0,name:t,fn:r.string}},positional(t,n=r.any){return{kind:1,name:t,fn:n}},pair(t,n=r.any){return{kind:2,name:t,accepts:[t],fn:u((s,i,a)=>n(s,i,a[1]),"fn")}},list(t,n=r.any){return{kind:3,name:t,accepts:[t],fn:u((s,i,a)=>a.slice(1).map(o=>n(s,i,o)),"fn")}},collection(t,n,s=r.any){return{kind:5,name:t,accepts:[n],fn:u((i,a,o)=>{let p=i[a]??[];return p.push(s(i,a,o)),p},"fn")}},mapped_collection(t,n,s,i=r.any){return{kind:5,name:t,accepts:[n],fn:u((a,o,p)=>{let c=a[o]??{},d=i(a,o,p),Le=s(d);return c[Le]=d,c},"fn")}},dict(t,n,s=r.any){return{kind:5,name:t,accepts:[n],fn:u((i,a,o)=>{let p=o,c=i[a]??{};return c[p[1]]=s(i,a,p[2]),c},"fn")}},atom(t,n){let s;return n?s=r.string:(s=r.boolean,n=[t]),{kind:4,name:t,accepts:n,fn(i,a,o){return Array.isArray(o)&&o.length==1&&(o=o[0]),s(i,a,o)}}},expr(t,n=r.any){return{kind:6,name:t,accepts:[t],fn:n}},object(t,n,...s){return e.expr(t,r.object(n,...s))},item(t,n,...s){return e.expr(t,r.item(n,...s))},vec2(t){return e.expr(t,r.vec2)},vec4(t){return e.expr(t,r.vec4)},color(t="color"){return e.expr(t,r.color)}};function Te(t){return Array.isArray(t)?t:[t]}u(Te,"as_array");function m(t,...n){N(t)&&(t=z(t),t.length==1&&Array.isArray(t[0])&&(t=t[0]));let s=new Map,i,a=0;for(let p of n)if(p.kind==0)i=p;else if(p.kind==1)s.set(a,p),a++;else for(let c of p.accepts)s.set(c,p);if(i){let p=Te(i.name),c=t.at(0);if(!p.includes(c))throw new Error(`Expression must start with ${i.name} found ${c} in ${t}`);t=t.slice(1)}let o={};a=0;for(let p of t){let c=null;if(N(p)&&(c=s.get(p)),!c&&(N(p)||le(p))){if(c=s.get(a),!c){se.warn(`no def for bare element ${p} at position ${a} in expression ${t}`);continue}a++}if(!c&&Array.isArray(p)&&(c=s.get(p[0])),!c){se.warn(`No def found for element ${p} in expression ${t}`);continue}let d=c.fn(o,c.name,p);o[c.name]=d}return o}u(m,"parse_expr");function b(t){let n=m(t,e.start("at"),e.vec2("position"),e.positional("x",r.number),e.positional("y",r.number),e.positional("rotation",r.number),e.atom("unlocked"));return{position:{x:n.position?.x??n.x??0,y:n.position?.y??n.y??0},rotation:n.rotation??0,unlocked:n.unlocked??!1}}u(b,"parseAt");function g(t){return m(t,e.start("stroke"),e.pair("width",r.number),e.pair("type",r.string),e.color())}u(g,"parseStroke");function h(t){return m(t,e.start("effects"),e.object("font",{},e.start("font"),e.pair("face",r.string),e.vec2("size"),e.pair("thickness",r.number),e.atom("bold"),e.atom("italic"),e.pair("line_spacing",r.number)),e.item("justify",n=>{let s="center",i="center",a=!1;if(Array.isArray(n))for(let o=1;o<n.length;o++){let p=n[o];typeof p=="string"&&(p==="left"||p==="right"?s=p:p==="top"||p==="bottom"?i=p:p==="mirror"&&(a=!0))}return{horiz:s,vert:i,mirror:a}}),e.atom("hide"),e.pair("href",r.string))}u(h,"parseEffects");function Z(t){return m(t,e.start("title_block"),e.pair("title",r.string),e.pair("date",r.string),e.pair("rev",r.string),e.pair("company",r.string),e.dict("comment","comment",r.string))}u(Z,"parseTitleBlock");function K(t){return m(t,e.start("paper"),e.positional("size",r.string),e.positional("width",r.number),e.positional("height",r.number),e.atom("portrait"))}u(K,"parsePaper");function Ee(t){return m(t,e.positional("ordinal",r.number),e.positional("canonical_name",r.string),e.positional("type",r.string),e.positional("user_name",r.string))}u(Ee,"parseLayer");function Oe(t){return m(t,e.positional("name",r.string),e.pair("type",r.string),e.pair("color",r.string),e.pair("thickness",r.number),e.pair("material",r.string),e.pair("epsilon_r",r.number),e.pair("loss_tangent",r.number))}u(Oe,"parseStackupLayer");function Re(t){return m(t,e.start("stackup"),e.collection("layers","layer",r.item(Oe)),e.pair("copper_finish",r.string),e.pair("dielectric_constraints",r.boolean),e.pair("edge_connector",r.string),e.pair("castellated_pads",r.boolean),e.pair("edge_plating",r.boolean))}u(Re,"parseStackup");function Ge(t){return m(t,e.start("pcbplotparams"),e.pair("layerselection",r.number),e.pair("disableapertmacros",r.boolean),e.pair("usegerberextensions",r.boolean),e.pair("usegerberattributes",r.boolean),e.pair("usegerberadvancedattributes",r.boolean),e.pair("creategerberjobfile",r.boolean),e.pair("gerberprecision",r.number),e.pair("svguseinch",r.boolean),e.pair("svgprecision",r.number),e.pair("excludeedgelayer",r.boolean),e.pair("plotframeref",r.boolean),e.pair("viasonmask",r.boolean),e.pair("mode",r.number),e.pair("useauxorigin",r.boolean),e.pair("hpglpennumber",r.number),e.pair("hpglpenspeed",r.number),e.pair("hpglpendiameter",r.number),e.pair("dxfpolygonmode",r.boolean),e.pair("dxfimperialunits",r.boolean),e.pair("dxfusepcbnewfont",r.boolean),e.pair("psnegative",r.boolean),e.pair("psa4output",r.boolean),e.pair("plotreference",r.boolean),e.pair("plotvalue",r.boolean),e.pair("plotinvisibletext",r.boolean),e.pair("sketchpadsonfab",r.boolean),e.pair("subtractmaskfromsilk",r.boolean),e.pair("outputformat",r.number),e.pair("mirror",r.boolean),e.pair("drillshape",r.number),e.pair("scaleselection",r.number),e.pair("outputdirectory",r.string),e.pair("plot_on_all_layers_selection",r.number),e.pair("dashed_line_dash_ratio",r.number),e.pair("dashed_line_gap_ratio",r.number),e.pair("pdf_front_fp_property_popups",r.boolean),e.pair("pdf_back_fp_property_popups",r.boolean),e.pair("plotfptext",r.boolean))}u(Ge,"parsePCBPlotParams");function Ne(t){return m(t,e.start("setup"),e.pair("pad_to_mask_clearance",r.number),e.pair("solder_mask_min_width",r.number),e.pair("pad_to_paste_clearance",r.number),e.pair("pad_to_paste_clearance_ratio",r.number),e.vec2("aux_axis_origin"),e.vec2("grid_origin"),e.item("pcbplotparams",Ge),e.item("stackup",Re),e.pair("allow_soldermask_bridges_in_footprints",r.boolean))}u(Ne,"parseSetup");function Ze(t){return m(t,e.start("net"),e.positional("number",r.number),e.positional("name",r.string))}u(Ze,"parseNet");function Ke(t){return m(t,e.start("net"),e.positional("number",r.number),e.positional("name",r.string))}u(Ke,"parseNetReference");function ce(t,n){return m(t,e.start(n),e.pair("layer",r.string),e.pair("tstamp",r.string),e.pair("uuid",r.string),e.atom("locked"),e.vec2("start"),e.vec2("end"),e.pair("width",r.number),e.item("stroke",g))}u(ce,"parseLine");function pe(t){return ce(t,"gr_line")}u(pe,"parse_gr_Line");function Fe(t){return ce(t,"fp_line")}u(Fe,"parse_fp_Line");function me(t,n){return m(t,e.start(n),e.pair("layer",r.string),e.pair("tstamp",r.string),e.pair("uuid",r.string),e.atom("locked"),e.vec2("center"),e.vec2("end"),e.pair("width",r.number),e.pair("fill",r.string),e.item("stroke",g))}u(me,"parseCircle");function _e(t){return me(t,"gr_circle")}u(_e,"parse_gr_Circle");function De(t){return me(t,"fp_circle")}u(De,"parse_fp_Circle");function X(t,n){return m(t,e.start(n),e.pair("layer",r.string),e.pair("tstamp",r.string),e.pair("uuid",r.string),e.atom("locked"),e.vec2("start"),e.vec2("mid"),e.vec2("end"),e.pair("angle",r.number),e.pair("width",r.number),e.item("stroke",g))}u(X,"parseArc");function fe(t){return X(t,"gr_arc")}u(fe,"parse_gr_Arc");function Ve(t){return X(t,"fp_arc")}u(Ve,"parse_fp_Arc");function He(t){return X(t,"arc")}u(He,"parse_poly_Arc");function F(t,n){return m(t,e.start(n),e.pair("layer",r.string),e.pair("tstamp",r.string),e.pair("uuid",r.string),e.atom("locked"),e.expr("pts",(s,i,a)=>m(a,e.start("pts"),e.collection("items","xy",r.vec2),e.collection("items","arc",r.item(He)))?.items),e.pair("width",r.number),e.pair("fill",r.string),e.atom("island"),e.item("stroke",g))}u(F,"parsePoly");function de(t){return F(t,"gr_poly")}u(de,"parse_gr_poly");function Je(t){return F(t,"fp_poly")}u(Je,"parse_fp_poly");function be(t){return F(t,"polygon")}u(be,"parse_polygon");function We(t){return F(t,"filled_polygon")}u(We,"parse_filled_polygon");function ge(t,n){return m(t,e.start(n),e.pair("layer",r.string),e.pair("tstamp",r.string),e.pair("uuid",r.string),e.atom("locked"),e.vec2("start"),e.vec2("end"),e.pair("width",r.number),e.pair("fill",r.string),e.item("stroke",g))}u(ge,"parseRect");function ye(t){return ge(t,"gr_rect")}u(ye,"parse_gr_Rect");function Me(t){return ge(t,"fp_rect")}u(Me,"parse_fp_Rect");function q(t){return m(t,e.start("render_cache"),e.positional("text",r.string),e.positional("angle",r.number),e.pair("uuid",r.string),e.collection("polygons","polygon",r.item(be)))}u(q,"parseTextRenderCache");function Ue(t){return m(t,e.start("fp_text"),e.atom("locked"),e.positional("type",r.string),e.positional("text",r.string),e.item("at",b),e.atom("hide"),e.atom("unlocked"),e.pair("uuid",r.string),e.object("layer",{},e.start("layer"),e.positional("name",r.string),e.atom("knockout")),e.pair("tstamp",r.string),e.item("effects",h),e.item("render_cache",q))}u(Ue,"parseFpText");function $e(t){return m(t,e.start("gr_text"),e.positional("text",r.string),e.item("at",b),e.object("layer",{},e.start("layer"),e.positional("name",r.string),e.atom("knockout")),e.atom("unlocked"),e.atom("hide"),e.atom("locked"),e.item("effects",h),e.pair("tstamp",r.string),e.pair("uuid",r.string),e.item("render_cache",q))}u($e,"parseGrText");function Xe(t){return m(t,e.start("dimension"),e.atom("locked"),e.positional("type",r.string),e.pair("layer",r.string),e.pair("tstamp",r.string),e.pair("uuid",r.string),e.collection("pts","pts",(n,s,i)=>m(i,e.collection("points","xy",r.vec2)).points),e.pair("height",r.number),e.pair("orientation",r.number),e.pair("leader_length",r.number),e.item("gr_text",$e),e.object("format",{},e.start("format"),e.pair("prefix",r.string),e.pair("suffix",r.string),e.pair("units",r.number),e.pair("units_format",r.number),e.pair("precision",r.number),e.pair("override_value",r.string),e.pair("suppress_zeroes",r.boolean)),e.object("style",{},e.start("style"),e.pair("thickness",r.number),e.pair("arrow_length",r.number),e.pair("text_position_mode",r.number),e.pair("extension_height",r.number),e.pair("text_frame",r.number),e.pair("extension_offset",r.number),e.pair("keep_text_aligned",r.boolean)))}u(Xe,"parseDimension");function qe(t){return m(t,e.start("pad"),e.positional("number",r.string),e.positional("type",r.string),e.positional("shape",r.string),e.atom("locked"),e.item("at",b),e.vec2("size"),e.vec2("rect_delta"),e.list("layers",r.string),e.pair("remove_unused_layers",r.boolean),e.pair("keep_end_layers",r.boolean),e.pair("roundrect_rratio",r.number),e.pair("chamfer_ratio",r.number),e.object("chamfer",{},e.start("chamfer"),e.atom("top_left"),e.atom("top_right"),e.atom("bottom_right"),e.atom("bottom_left")),e.pair("pinfunction",r.string),e.pair("pintype",r.string),e.pair("die_length",r.number),e.pair("solder_mask_margin",r.number),e.pair("solder_paste_margin",r.number),e.pair("solder_paste_margin_ratio",r.number),e.pair("clearance",r.number),e.pair("thermal_width",r.number),e.pair("thermal_gap",r.number),e.pair("thermal_bridge_angle",r.number),e.pair("zone_connect",r.number),e.object("drill",{},e.start("drill"),e.atom("oval"),e.positional("diameter",r.number),e.positional("width",r.number),e.vec2("offset")),e.item("net",Ke),e.object("options",{},e.start("options"),e.pair("clearance",r.string),e.pair("anchor",r.string)),e.expr("primitives",(n,s,i)=>m(i,e.start("primitives"),e.collection("items","gr_line",r.item(pe)),e.collection("items","gr_circle",r.item(_e)),e.collection("items","gr_arc",r.item(fe)),e.collection("items","gr_rect",r.item(ye)),e.collection("items","gr_poly",r.item(de)))?.items),e.pair("tstamp",r.string),e.pair("uuid",r.string))}u(qe,"parsePad");function ve(t){return m(t,e.start("model"),e.positional("filename",r.string),e.object("offset",{},e.start("offset"),e.collection("xyz","xyz",r.number)),e.object("scale",{},e.start("scale"),e.collection("xyz","xyz",r.number)),e.object("rotate",{},e.start("rotate"),e.collection("xyz","xyz",r.number)),e.atom("hide"),e.pair("opacity",r.number))}u(ve,"parseModel");function Qe(t){return m(t,e.start("property"),e.positional("name",r.string),e.positional("value",r.string),e.item("at",b),e.atom("unlocked"),e.object("layer",{},e.start("layer"),e.positional("name",r.string),e.atom("knockout")),e.atom("hide"),e.pair("uuid",r.string),e.item("effects",h),e.item("render_cache",q))}u(Qe,"parsePropertyKicad8");function Ye(t){return m(t,e.start("fill"),e.positional("fill",r.boolean),e.pair("mode",r.string),e.pair("thermal_gap",r.number),e.pair("thermal_bridge_width",r.number),e.object("smoothing",{},e.start("smoothing"),e.positional("style",r.string),e.pair("radius",r.number)),e.pair("radius",r.number),e.pair("island_removal_mode",r.number),e.pair("island_area_min",r.number),e.pair("hatch_thickness",r.number),e.pair("hatch_gap",r.number),e.pair("hatch_orientation",r.number),e.pair("hatch_smoothing_level",r.number),e.pair("hatch_smoothing_value",r.number),e.pair("hatch_border_algorithm",r.string),e.pair("hatch_min_hole_area",r.number),e.pair("uuid",r.string))}u(Ye,"parseZoneFill");function et(t){return m(t,e.start("keepout"),e.pair("tracks",r.string),e.pair("vias",r.string),e.pair("pads",r.string),e.pair("copperpour",r.string),e.pair("footprints",r.string),e.pair("uuid",r.string))}u(et,"parseZoneKeepout");function he(t){return m(t,e.start("zone"),e.atom("locked"),e.pair("net",r.number),e.pair("net_name",r.string),e.pair("name",r.string),e.pair("layer",r.string),e.list("layers",r.string),e.object("hatch",{},e.start("hatch"),e.positional("style",r.string),e.positional("pitch",r.number)),e.pair("priority",r.number),e.object("connect_pads",{},e.start("connect_pads"),e.positional("type",r.string),e.pair("clearance",r.number)),e.pair("min_thickness",r.number),e.pair("filled_areas_thickness",r.boolean),e.item("keepout",et),e.item("fill",Ye),e.collection("polygons","polygon",r.item(be)),e.collection("filled_polygons","filled_polygon",r.item(We)),e.pair("tstamp",r.string),e.pair("uuid",r.string))}u(he,"parseZone");function ue(t){return m(t,e.start("footprint"),e.positional("library_link",r.string),e.pair("version",r.number),e.pair("embedded_fonts",r.boolean),e.pair("generator",r.string),e.atom("locked"),e.atom("placed"),e.pair("layer",r.string),e.pair("tedit",r.string),e.pair("tstamp",r.string),e.item("at",b),e.pair("uuid",r.string),e.pair("descr",r.string),e.pair("tags",r.string),e.pair("sheetname",r.string),e.pair("sheetfile",r.string),e.pair("path",r.string),e.pair("autoplace_cost90",r.number),e.pair("autoplace_cost180",r.number),e.pair("solder_mask_margin",r.number),e.pair("solder_paste_margin",r.number),e.pair("solder_paste_ratio",r.number),e.pair("clearance",r.number),e.pair("zone_connect",r.number),e.pair("thermal_width",r.number),e.pair("thermal_gap",r.number),e.object("attr",{},e.start("attr"),e.atom("through_hole"),e.atom("smd"),e.atom("virtual"),e.atom("board_only"),e.atom("exclude_from_pos_files"),e.atom("exclude_from_bom"),e.atom("allow_solder_mask_bridges"),e.atom("allow_missing_courtyard")),e.dict("properties","property",r.string),e.collection("properties_kicad_8","property",r.item(Qe)),e.collection("drawings","fp_line",r.item(Fe)),e.collection("drawings","fp_circle",r.item(De)),e.collection("drawings","fp_arc",r.item(Ve)),e.collection("drawings","fp_poly",r.item(Je)),e.collection("drawings","fp_rect",r.item(Me)),e.collection("fp_texts","fp_text",r.item(Ue)),e.collection("zones","zone",r.item(he)),e.collection("models","model",r.item(ve)),e.collection("pads","pad",r.item(qe)))}u(ue,"parseFootprint");function tt(t){return m(t,e.start("segment"),e.vec2("start"),e.vec2("end"),e.pair("width",r.number),e.pair("layer",r.string),e.pair("net",r.number),e.atom("locked"),e.pair("tstamp",r.string),e.pair("uuid",r.string))}u(tt,"parseLineSegment");function nt(t){return m(t,e.start("arc"),e.vec2("start"),e.vec2("mid"),e.vec2("end"),e.pair("width",r.number),e.pair("layer",r.string),e.pair("net",r.number),e.atom("locked"),e.pair("tstamp",r.string),e.pair("uuid",r.string))}u(nt,"parseArcSegment");function rt(t){return m(t,e.start("via"),e.item("at",b),e.pair("size",r.number),e.pair("drill",r.number),e.list("layers",r.string),e.atom("remove_unused_layers"),e.atom("keep_end_layers"),e.atom("locked"),e.atom("free"),e.pair("net",r.number),e.pair("tstamp",r.string),e.pair("uuid",r.string),e.atom("type",["blind","micro","through-hole"]))}u(rt,"parseVia");function it(t){return m(t,e.start("group"),e.positional("name",r.string),e.pair("id",r.string),e.atom("locked"),e.collection("members","members",r.string))}u(it,"parseGroup");var v=class v{parse(n){let s=z(n),i=s.length===1&&Array.isArray(s[0])?s[0]:s;return m(i,e.start("kicad_pcb"),e.pair("version",r.number),e.pair("generator",r.string),e.pair("embedded_fonts",r.boolean),e.pair("generator_version",r.string),e.object("general",{},e.start("general"),e.pair("thickness",r.number),e.atom("legacy_teardrops")),e.item("paper",K),e.item("title_block",Z),e.item("setup",Ne),e.dict("properties","property",(a,o,p)=>{let c=p;return{name:c[1],value:c[2]}}),e.list("layers",r.item(Ee)),e.collection("nets","net",r.item(Ze)),e.collection("footprints","footprint",r.item(ue)),e.collection("footprints","module",r.item(ue)),e.collection("zones","zone",r.item(he)),e.collection("segments","segment",r.item(tt)),e.collection("segments","arc",r.item(nt)),e.collection("vias","via",r.item(rt)),e.collection("drawings","gr_line",r.item(pe)),e.collection("drawings","gr_circle",r.item(_e)),e.collection("drawings","gr_arc",r.item(fe)),e.collection("drawings","gr_poly",r.item(de)),e.collection("drawings","gr_rect",r.item(ye)),e.collection("drawings","gr_text",r.item($e)),e.collection("drawings","dimension",r.item(Xe)),e.collection("groups","group",r.item(it)))}};u(v,"BoardParser");var U=v;function _(t){return t===void 0?"":t.replaceAll("\\","\\\\").replaceAll('"','\\"').replaceAll(`
`,"\\n")}u(_,"escapeString");function x(t,n=0,s=!1){if(!t)return"(at 0 0 0)";let i=t.position?.x||0,a=t.position?.y||0,o=t.rotation||0;return s||o!==0?`(at ${f(i)} ${f(a)} ${f(o)})`:`(at ${f(i)} ${f(a)})`}u(x,"serializeAt");function k(t,n=0){let s=l(n),i=l(n+1),a=l(n+2),o="(effects";if(t.font&&(o+=`
${i}(font`,o+=`
${a}(size ${f(t.font.size?.x||0)} ${f(t.font.size?.y||0)})`,t.font.face&&(o+=`
${a}(name "${_(t.font.face)}")`),t.font.thickness!=null&&(o+=`
${a}(thickness ${f(t.font.thickness)})`),t.font.bold&&(o+=`
${a}(bold yes)`),t.font.italic&&(o+=`
${a}(italic yes)`),o+=`
${i})`),t.justify){let p=[];t.justify.horiz&&t.justify.horiz!=="center"&&p.push(t.justify.horiz),t.justify.vert&&t.justify.vert!=="center"&&p.push(t.justify.vert),t.justify.mirror&&p.push("mirror"),p.length>0&&(o+=`
${i}(justify ${p.join(" ")})`)}return t.hide&&(o+=`
${i}(hide yes)`),t.href&&(o+=`
${i}(href "${_(t.href)}")`),o+=`
${s})`,o}u(k,"serializeEffects");function f(t){return Number.isInteger(t)?String(t):t.toFixed(6).replace(/\.?0+$/,"")}u(f,"formatDouble");function Q(t){return t===0?"0.0000":f(t)}u(Q,"formatColorAlpha");function $(t,n=0){let s=l(n),i=l(n+1),a="(stroke";return t.width!==void 0&&(a+=`
${i}(width ${f(t.width)})`),t.type&&(a+=`
${i}(type ${t.type})`),t.color&&(a+=`
${i}(color ${Math.round(t.color.r*255)} ${Math.round(t.color.g*255)} ${Math.round(t.color.b*255)} ${Q(t.color.a)})`),a+=`
${s})`,a}u($,"serializeStroke");function I(t,n=0){if(!t)return"";let s=l(n),i=l(n+1),a="(fill";return t.type&&(a+=`
${i}(type ${t.type})`),t.color&&(a+=`
${i}(color ${Math.round(t.color.r*255)} ${Math.round(t.color.g*255)} ${Math.round(t.color.b*255)} ${Q(t.color.a)})`),a+=`
${s})`,a}u(I,"serializeFill");function at(t,n=0){return t.portrait?`(paper "${t.size}" portrait)`:`(paper "${t.size}")`}u(at,"serializePaper");function ot(t,n=0){let s=l(n),i=l(n+1),a=`${s}(title_block`;if(t.title&&(a+=`
${i}(title "${_(t.title)}")`),t.company&&(a+=`
${i}(company "${_(t.company)}")`),t.date&&(a+=`
${i}(date "${_(t.date)}")`),t.rev&&(a+=`
${i}(rev "${_(t.rev)}")`),t.comment)for(let[o,p]of Object.entries(t.comment))a+=`
${i}(comment ${o} "${_(p)}")`;return a+=`
${s})`,a}u(ot,"serializeTitleBlock");function D(t,n=0){let s=l(n),i=l(n+1),a=s+"(property";return t.private&&(a+=" private"),a+=' "'+_(t.name||"")+'" "'+_(t.text||"")+'"',a+=`
`+i+x(t.at,0,!0),a+=`
`+i+k(t.effects,n+1),t.show_name&&(a+=`
`+i+"(show_name yes)"),t.do_not_autoplace&&(a+=`
`+i+"(do_not_autoplace yes)"),t.hide&&(a+=`
`+i+"(hide yes)"),a+=`
`+s+")",a}u(D,"serializeProperty");function st(t,n=0){return`(alternate "${_(t.name)}" ${t.type} ${t.shape})`}u(st,"serializePinAlternate");function lt(t,n=0){let s=l(n),i=l(n+1),a=`${s}(pin ${t.type} ${t.shape}`;a+=`
${i}${x(t.at,0,!0)}`,a+=`
${i}(length ${f(t.length)})`,t.hide&&(a+=`
${i}(hide yes)`),a+=`
${i}(name "${_(t.name.text)}"`;let o=k(t.name.effects,n+2);a+=`
${l(n+2)}${o}`,a+=`
${i})`,a+=`
${i}(number "${_(t.number.text)}"`;let p=k(t.number.effects,n+2);if(a+=`
${l(n+2)}${p}`,a+=`
${i})`,t.alternates&&t.alternates.length>0)for(let c of t.alternates)a+=`
${i}${st(c)}`;return a+=`
${s})`,a}u(lt,"serializePin");function T(t,n=0){let s=l(n),i=`${s}(symbol "${_(t.name)}"
`;if(t.power&&(i+=`${l(n+1)}(power)
`),t.pin_numbers?.hide&&(i+=`${l(n+1)}(pin_numbers
`,i+=`${l(n+2)}(hide yes)
`,i+=`${l(n+1)})
`),t.pin_names&&(i+=`${l(n+1)}(pin_names
`,t.pin_names.offset!==void 0&&(i+=`${l(n+2)}(offset ${t.pin_names.offset})
`),t.pin_names.hide&&(i+=`${l(n+2)}(hide yes)
`),i+=`${l(n+1)})
`),t.exclude_from_sim!==void 0&&(i+=`${l(n+1)}(exclude_from_sim ${t.exclude_from_sim?"yes":"no"})
`),t.in_bom!==void 0&&(i+=`${l(n+1)}(in_bom ${t.in_bom?"yes":"no"})
`),t.on_board!==void 0&&(i+=`${l(n+1)}(on_board ${t.on_board?"yes":"no"})
`),t.properties&&t.properties.length>0)for(let a of t.properties)i+=`${D(a,n+1)}
`;if(t.children&&t.children.length>0)for(let a of t.children)i+=T(a,n+1);if(t.drawings&&t.drawings.length>0){for(let a of t.drawings)if(a.type==="arc"){let o=a;i+=`${l(n+1)}(arc (start ${o.start.x} ${o.start.y})
`,o.mid&&(i+=`${l(n+2)}(mid ${o.mid.x} ${o.mid.y})
`),i+=`${l(n+2)}(end ${o.end.x} ${o.end.y})
`,o.radius&&(i+=`${l(n+2)}(radius (xy ${o.radius.at.x} ${o.radius.at.y}) (length ${o.radius.length}) (angles ${o.radius.angles.x} ${o.radius.angles.y}))
`),o.stroke&&(i+=`${l(n+2)}${$(o.stroke,n+2)}
`),o.fill&&(i+=`${l(n+2)}${I(o.fill,n+2)}
`),o.uuid&&(i+=`${l(n+2)}(uuid "${_(o.uuid)}")
`),i+=`${l(n+1)})
`}else if(a.type==="bezier"){let o=a;i+=`${l(n+1)}(bezier (pts
`;for(let p of o.pts)i+=`${l(n+3)}(xy ${p.x} ${p.y})
`;i+=`${l(n+2)})
`,o.stroke&&(i+=`${l(n+2)}${$(o.stroke,n+2)}
`),o.fill&&(i+=`${l(n+2)}${I(o.fill,n+2)}
`),o.uuid&&(i+=`${l(n+2)}(uuid "${_(o.uuid)}")
`),i+=`${l(n+1)})
`}else if(a.type==="circle"){let o=a;if(i+=`${l(n+1)}(circle
`,i+=`${l(n+2)}(center ${o.center.x} ${o.center.y})
`,i+=`${l(n+2)}(radius ${o.radius})
`,o.stroke){i+=`${l(n+2)}(stroke
`;let c=$(o.stroke,n+3).split(`
`);for(let d=1;d<c.length-1;d++)i+=c[d]+`
`;i+=`${l(n+2)})
`}if(o.fill){i+=`${l(n+2)}(fill
`;let c=I(o.fill,n+3).split(`
`);for(let d=1;d<c.length-1;d++)i+=c[d]+`
`;i+=`${l(n+2)})
`}o.uuid&&(i+=`${l(n+2)}(uuid "${_(o.uuid)}")
`),i+=`${l(n+1)})
`}else if(a.type==="polyline"){let o=a;i+=`${l(n+1)}(polyline
`,i+=`${l(n+2)}(pts
`;for(let p=0;p<o.pts.length;p++){let c=o.pts[p];p===0?i+=`${l(n+3)}(xy ${c.x} ${c.y})`:i+=` (xy ${c.x} ${c.y})`}if(i+=`
`,i+=`${l(n+2)})
`,o.stroke){i+=`${l(n+2)}(stroke
`;let c=$(o.stroke,n+3).split(`
`);for(let d=1;d<c.length-1;d++)i+=c[d]+`
`;i+=`${l(n+2)})
`}if(o.fill){i+=`${l(n+2)}(fill
`;let c=I(o.fill,n+3).split(`
`);for(let d=1;d<c.length-1;d++)i+=c[d]+`
`;i+=`${l(n+2)})
`}o.uuid&&(i+=`${l(n+2)}(uuid "${_(o.uuid)}")
`),i+=`${l(n+1)})
`}else if(a.type==="rectangle"){let o=a;if(i+=`${l(n+1)}(rectangle
`,i+=`${l(n+2)}(start ${o.start.x} ${o.start.y})
`,i+=`${l(n+2)}(end ${o.end.x} ${o.end.y})
`,o.stroke){i+=`${l(n+2)}(stroke
`;let c=$(o.stroke,n+3).split(`
`);for(let d=1;d<c.length-1;d++)i+=c[d]+`
`;i+=`${l(n+2)})
`}if(o.fill){i+=`${l(n+2)}(fill
`;let c=I(o.fill,n+3).split(`
`);for(let d=1;d<c.length-1;d++)i+=c[d]+`
`;i+=`${l(n+2)})
`}o.uuid&&(i+=`${l(n+2)}(uuid "${_(o.uuid)}")
`),i+=`${l(n+1)})
`}else if(a.type==="text"){let o=a;i+=`${l(n+1)}(text "${_(o.text)}"`,o.exclude_from_sim!=null&&(i+=` (exclude_from_sim ${o.exclude_from_sim?"yes":"no"})`),i+=` ${x(o.at,0,!0)}
`,i+=`${l(n+2)}${k(o.effects,n+2)}
`,o.uuid&&(i+=`${l(n+2)}(uuid "${_(o.uuid)}")
`),i+=`${l(n+1)})
`}else if(a.type==="text_box"){let o=a;i+=`${l(n+1)}(text_box "${_(o.text)}" ${x(o.at,0,!0)} (size ${o.size.x} ${o.size.y})
`,o.exclude_from_sim!==void 0&&(i+=`${l(n+2)}(exclude_from_sim ${o.exclude_from_sim?"yes":"no"})
`),o.margins&&(i+=`${l(n+2)}(margins ${o.margins.x} ${o.margins.y} ${o.margins.z} ${o.margins.w})
`),i+=`${l(n+2)}${k(o.effects,n+2)}
`,o.stroke&&(i+=`${l(n+2)}${$(o.stroke,n+2)}
`),o.fill&&(i+=`${l(n+2)}${I(o.fill,n+2)}
`),o.uuid&&(i+=`${l(n+2)}(uuid "${_(o.uuid)}")
`),i+=`${l(n+1)})
`}}if(t.pins&&t.pins.length>0)for(let a of t.pins)i+=lt(a,n+1)+`
`;return t.embedded_fonts!==void 0&&(i+=`${l(n+1)}(embedded_fonts ${t.embedded_fonts?"yes":"no"})
`),t.embedded_files&&(i+=`${l(n+1)}(embedded_files "${_(t.embedded_files)}")
`),i+=`${s})
`,i}u(T,"serializeLibSymbol");function ut(t){let n="(wire (pts";for(let s of t.pts)n+=` (xy ${f(s.x)} ${f(s.y)})`;return n+=")",n+=` ${$(t.stroke)}`,n+=` (uuid "${_(t.uuid)}")`,n+=")",n}u(ut,"serializeWire");function ct(t){let n="(bus (pts";for(let s of t.pts)n+=` (xy ${f(s.x)} ${f(s.y)})`;return n+=")",n+=` ${$(t.stroke)}`,n+=` (uuid "${_(t.uuid)}")`,n+=")",n}u(ct,"serializeBus");function pt(t){let n="(bus_entry ";if(t.at){let s=t.at.position?.x||0,i=t.at.position?.y||0;n+=`(at ${f(s)} ${f(i)})`}else n+="(at 0 0)";return n+=` (size ${f(t.size.x)} ${f(t.size.y)})`,n+=` ${$(t.stroke)}`,n+=` (uuid "${_(t.uuid)}")`,n+=")",n}u(pt,"serializeBusEntry");function mt(t){let n="";if(t.members&&Array.isArray(t.members))for(let s of t.members)n.length>0&&(n+=" "),n+=`"${_(s)}"`;return`(bus_alias "${_(t.name)}" (members ${n}))`}u(mt,"serializeBusAlias");function _t(t){let n="(junction ";if(t.at){let s=t.at.position?.x||0,i=t.at.position?.y||0;n+=`(at ${f(s)} ${f(i)})`}else n+="(at 0 0)";return t.diameter!==void 0&&(n+=` (diameter ${f(t.diameter)})`),t.color&&(n+=` (color ${Math.round(t.color.r*255)} ${Math.round(t.color.g*255)} ${Math.round(t.color.b*255)} ${Q(t.color.a)})`),n+=` (uuid "${_(t.uuid)}")`,n+=")",n}u(_t,"serializeJunction");function ft(t){let n="(no_connect ";if(t.at){let s=t.at.position?.x||0,i=t.at.position?.y||0;n+=`(at ${f(s)} ${f(i)})`}else n+="(at 0 0)";return n+=` (uuid "${_(t.uuid)}")`,n+=")",n}u(ft,"serializeNoConnect");function dt(t){let n=`(label "${_(t.text)}" ${x(t.at,0,!0)} ${k(t.effects)}`;return n+=` (fields_autoplaced ${t.fields_autoplaced?"yes":"no"})`,t.uuid&&(n+=` (uuid "${_(t.uuid)}")`),n+=")",n}u(dt,"serializeNetLabel");function bt(t){let n=`(global_label "${_(t.text)}" ${x(t.at,0,!0)} ${k(t.effects)}`;if(n+=` (fields_autoplaced ${t.fields_autoplaced?"yes":"no"})`,t.uuid&&(n+=` (uuid "${_(t.uuid)}")`),n+=` (shape ${t.shape})`,t.properties&&t.properties.length>0)for(let s of t.properties)n+=` ${D(s)}`;return n+=")",n}u(bt,"serializeGlobalLabel");function gt(t){let n=`(hierarchical_label "${_(t.text)}" ${x(t.at,0,!0)} ${k(t.effects)}`;return n+=` (fields_autoplaced ${t.fields_autoplaced?"yes":"no"})`,t.uuid&&(n+=` (uuid "${_(t.uuid)}")`),n+=` (shape ${t.shape})`,n+=")",n}u(gt,"serializeHierarchicalLabel");function yt(t){let n="(pin ",s=["input","output","bidirectional","tri_state","passive","dot","round","diamond","rectangle","power_in","power_out","open_collector","open_emitter"];return t.number!==void 0&&t.number!==null?t.number.trim()!==""&&!s.includes(t.number)?n+=`"${_(t.number)}"`:t.number.trim()!==""&&s.includes(t.number)?n+=t.number:n+='""':n+="power_in",n+=` (uuid "${_(t.uuid)}")`,t.alternate&&(n+=` (alternate "${_(t.alternate)}")`),n+=")",n}u(yt,"serializePinInstance");function Ie(t,n=0){let s=l(n),i=`${s}(symbol
`;if(t.lib_name&&(i+=`${l(n+1)}(lib_name "${_(t.lib_name)}")
`),i+=`${l(n+1)}(lib_id "${_(t.lib_id)}")
`,i+=`${l(n+1)}${x(t.at,0,!0)}
`,t.mirror&&(i+=`${l(n+1)}(mirror ${t.mirror})
`),i+=`${l(n+1)}(unit ${t.unit||1})
`,t.exclude_from_sim!==void 0&&(i+=`${l(n+1)}(exclude_from_sim ${t.exclude_from_sim?"yes":"no"})
`),t.in_bom!==void 0&&(i+=`${l(n+1)}(in_bom ${t.in_bom?"yes":"no"})
`),t.on_board!==void 0&&(i+=`${l(n+1)}(on_board ${t.on_board?"yes":"no"})
`),t.dnp!==void 0&&(i+=`${l(n+1)}(dnp ${t.dnp?"yes":"no"})
`),typeof t.convert<"u"&&t.convert!==null&&(i+=`${l(n+1)}(convert ${t.convert})
`),i+=`${l(n+1)}(fields_autoplaced ${t.fields_autoplaced?"yes":"no"})
`,i+=`${l(n+1)}(uuid "${_(t.uuid)}")
`,t.properties&&t.properties.length>0)for(let a of t.properties)i+=`${D(a,n+1)}
`;if(t.pins&&t.pins.length>0)for(let a of t.pins)i+=`${l(n+1)}${yt(a)}
`;if(t.default_instance){let a=t.default_instance.reference&&t.default_instance.reference.trim()!=="",o=t.default_instance.unit!==void 0&&t.default_instance.unit!==null,p=t.default_instance.value&&t.default_instance.value.trim()!=="",c=t.default_instance.footprint&&t.default_instance.footprint.trim()!=="";if(a||o||p||c){if(i+=`${l(n+1)}(default_instance
`,a&&(i+=`${l(n+2)}(reference "${_(t.default_instance.reference)}")
`),o){let d=t.default_instance.unit!==void 0&&t.default_instance.unit!==null?t.default_instance.unit:1;i+=`${l(n+2)}(unit ${d})
`}p&&(i+=`${l(n+2)}(value "${_(t.default_instance.value)}")
`),c&&(i+=`${l(n+2)}(footprint "${_(t.default_instance.footprint)}")
`),i+=`${l(n+1)})
`}}if(t.instances){if(i+=`${l(n+1)}(instances
`,t.instances.projects&&t.instances.projects.length>0)for(let a of t.instances.projects){if(i+=`${l(n+2)}(project "${_(a.name)}"
`,a.paths&&a.paths.length>0)for(let o of a.paths)i+=`${l(n+3)}(path "${_(o.path)}"
`,o.reference&&(i+=`${l(n+4)}(reference "${_(o.reference)}")
`),o.value&&(i+=`${l(n+4)}(value "${_(o.value)}")
`),o.unit&&(i+=`${l(n+4)}(unit ${o.unit})
`),o.footprint&&(i+=`${l(n+4)}(footprint "${_(o.footprint)}")
`),i+=`${l(n+3)})
`;i+=`${l(n+2)})
`}i+=`${l(n+1)})
`}return i+=`${s})
`,i}u(Ie,"serializeSchematicSymbol");function $t(t){let n=`(pin "${_(t.name)}" ${t.shape} ${x(t.at,0,!0)} ${k(t.effects)}`;return n+=` (uuid "${_(t.uuid)}")`,n+=")",n}u($t,"serializeSheetPin");function ht(t,n=0){let s=l(n),i=t.size?.x||0,a=t.size?.y||0,o=`${s}(sheet
`;o+=`${l(n+1)}${x(t.at)}
`,o+=`${l(n+1)}(size ${f(i)} ${f(a)})
`,t.exclude_from_sim!==void 0&&(o+=`${l(n+1)}(exclude_from_sim ${t.exclude_from_sim?"yes":"no"})
`),t.in_bom!==void 0&&(o+=`${l(n+1)}(in_bom ${t.in_bom?"yes":"no"})
`),t.on_board!==void 0&&(o+=`${l(n+1)}(on_board ${t.on_board?"yes":"no"})
`),t.dnp!==void 0&&(o+=`${l(n+1)}(dnp ${t.dnp?"yes":"no"})
`),o+=`${l(n+1)}(fields_autoplaced ${t.fields_autoplaced?"yes":"no"})
`,o+=`${l(n+1)}${$(t.stroke)}
`;let p=I(t.fill);if(p&&(o+=`${l(n+1)}${p}
`),o+=`${l(n+1)}(uuid "${_(t.uuid)}")
`,t.properties&&t.properties.length>0)for(let c of t.properties)o+=`${l(n+1)}${D(c)}
`;if(t.pins&&t.pins.length>0)for(let c of t.pins)o+=`${l(n+1)}${$t(c)}
`;if(t.instances){if(o+=`${l(n+1)}(instances
`,t.instances.projects&&t.instances.projects.length>0)for(let c of t.instances.projects){if(o+=`${l(n+2)}(project "${_(c.name)}"
`,c.paths&&c.paths.length>0)for(let d of c.paths)o+=`${l(n+3)}(path "${_(d.path)}"
`,d.page&&(o+=`${l(n+4)}(page "${_(d.page)}")
`),o+=`${l(n+3)})
`;o+=`${l(n+2)})
`}o+=`${l(n+1)})
`}return o+=`${s})
`,o}u(ht,"serializeSchematicSheet");function It(t,n){let s=l(n),i=l(n+1),a=`${s}(table_cell "${_(t.text)}"`;return t.exclude_from_sim!==void 0&&(a+=` (exclude_from_sim ${t.exclude_from_sim?"yes":"no"})`),a+=`
${i}${x(t.at,0,!0)}`,a+=`
${i}(size ${f(t.size.x)} ${f(t.size.y)})`,t.margins&&(a+=`
${i}(margins ${f(t.margins.x)} ${f(t.margins.y)} ${f(t.margins.z)} ${f(t.margins.w)})`),t.span&&(a+=`
${i}(span ${t.span.rows} ${t.span.cols})`),t.stroke&&(a+=`
${i}${$(t.stroke,n+1)}`),t.fill&&(a+=`
${i}${I(t.fill,n+1)}`),a+=`
${i}${k(t.effects,n+1)}`,t.uuid&&(a+=`
${i}(uuid "${_(t.uuid)}")`),a+=`
${s})`,a}u(It,"serializeTableCell");function xt(t,n){let s=l(n),i=l(n+1),a=`${s}(table
`;if(a+=`${i}(column_count ${t.column_count})
`,t.border&&(a+=`${i}(border
`,t.border.external!==void 0&&(a+=`${l(n+2)}(external ${t.border.external?"yes":"no"})
`),t.border.header!==void 0&&(a+=`${l(n+2)}(header ${t.border.header?"yes":"no"})
`),t.border.stroke&&(a+=`${l(n+2)}${$(t.border.stroke,n+2)}
`),a+=`${i})
`),t.separators&&(a+=`${i}(separators
`,t.separators.rows!==void 0&&(a+=`${l(n+2)}(rows ${t.separators.rows?"yes":"no"})
`),t.separators.cols!==void 0&&(a+=`${l(n+2)}(cols ${t.separators.cols?"yes":"no"})
`),t.separators.stroke&&(a+=`${l(n+2)}${$(t.separators.stroke,n+2)}
`),a+=`${i})
`),t.column_widths&&t.column_widths.length>0&&(a+=`${i}(column_widths ${t.column_widths.map(o=>f(o)).join(" ")})
`),t.row_heights&&t.row_heights.length>0&&(a+=`${i}(row_heights ${t.row_heights.map(o=>f(o)).join(" ")})
`),t.uuid&&(a+=`${i}(uuid "${_(t.uuid)}")
`),t.cells&&t.cells.length>0){a+=`${i}(cells
`;for(let o of t.cells)a+=`${It(o,n+2)}
`;a+=`${i})
`}return a+=`${s})`,a}u(xt,"serializeTable");function l(t){return"	".repeat(t)}u(l,"indentString");function Y(t){let n=`(kicad_sch
`;if(n+=`${l(1)}(version ${t.version||20231129})
`,t.generator&&(n+=`${l(1)}(generator "${_(t.generator)}")
`),t.generator_version&&(n+=`${l(1)}(generator_version "${_(t.generator_version)}")
`),t.uuid&&(n+=`${l(1)}(uuid "${_(t.uuid)}")
`),t.paper&&(n+=`${l(1)}${at(t.paper)}
`),t.title_block&&(n+=`${ot(t.title_block,1)}
`),t.lib_symbols){n+=`${l(1)}(lib_symbols
`;for(let i of t.lib_symbols)n+=T(i,2);n+=`${l(1)})
`}if(t.wires&&t.wires.length>0)for(let i of t.wires)n+=`${l(1)}${ut(i)}
`;if(t.buses&&t.buses.length>0)for(let i of t.buses)n+=`${l(1)}${ct(i)}
`;if(t.bus_entries&&t.bus_entries.length>0)for(let i of t.bus_entries)n+=`${l(1)}${pt(i)}
`;if(t.bus_aliases&&t.bus_aliases.length>0)for(let i of t.bus_aliases)n+=`${l(1)}${mt(i)}
`;if(t.junctions&&t.junctions.length>0)for(let i of t.junctions)n+=`${l(1)}${_t(i)}
`;if(t.no_connects&&t.no_connects.length>0)for(let i of t.no_connects)n+=`${l(1)}${ft(i)}
`;if(t.net_labels&&t.net_labels.length>0)for(let i of t.net_labels)n+=`${l(1)}${dt(i)}
`;if(t.global_labels&&t.global_labels.length>0)for(let i of t.global_labels)n+=`${l(1)}${bt(i)}
`;if(t.hierarchical_labels&&t.hierarchical_labels.length>0)for(let i of t.hierarchical_labels)n+=`${l(1)}${gt(i)}
`;if(t.symbols&&t.symbols.length>0)for(let i of t.symbols)n+=Ie(i,1);if(t.drawings&&t.drawings.length>0){for(let i of t.drawings)if(i.type==="arc"){let a=i;n+=`${l(1)}(arc (start ${f(a.start.x)} ${f(a.start.y)})`,a.mid&&(n+=` (mid ${f(a.mid.x)} ${f(a.mid.y)})`),n+=` (end ${f(a.end.x)} ${f(a.end.y)})`,a.radius&&(n+=` (radius (xy ${f(a.radius.at.x)} ${f(a.radius.at.y)}) (length ${f(a.radius.length)}) (angles ${f(a.radius.angles.x)} ${f(a.radius.angles.y)}))`),a.stroke&&(n+=` ${$(a.stroke)}`),a.fill&&(n+=` ${I(a.fill)}`),a.uuid&&(n+=` (uuid "${_(a.uuid)}")`),n+=`)
`}else if(i.type==="bezier"){let a=i;n+=`${l(1)}(bezier (pts`;for(let o of a.pts)n+=` (xy ${f(o.x)} ${f(o.y)})`;n+=")",a.stroke&&(n+=` ${$(a.stroke)}`),a.fill&&(n+=` ${I(a.fill)}`),a.uuid&&(n+=` (uuid "${_(a.uuid)}")`),n+=`)
`}else if(i.type==="circle"){let a=i;n+=`${l(1)}(circle (center ${f(a.center.x)} ${f(a.center.y)}) (radius ${f(a.radius)})`,a.stroke&&(n+=` ${$(a.stroke)}`),a.fill&&(n+=` ${I(a.fill)}`),a.uuid&&(n+=` (uuid "${_(a.uuid)}")`),n+=`)
`}else if(i.type==="polyline"){let a=i;n+=`${l(1)}(polyline (pts`;for(let o of a.pts)n+=` (xy ${f(o.x)} ${f(o.y)})`;n+=")",a.stroke&&(n+=` ${$(a.stroke)}`),a.fill&&(n+=` ${I(a.fill)}`),a.uuid&&(n+=` (uuid "${_(a.uuid)}")`),n+=`)
`}else if(i.type==="rectangle"){let a=i;n+=`${l(1)}(rectangle (start ${f(a.start.x)} ${f(a.start.y)}) (end ${f(a.end.x)} ${f(a.end.y)})`,a.stroke&&(n+=` ${$(a.stroke)}`),a.fill&&(n+=` ${I(a.fill)}`),a.uuid&&(n+=` (uuid "${_(a.uuid)}")`),n+=`)
`}else if(i.type==="text"){let a=i;n+=`${l(1)}(text "${_(a.text)}"`,a.exclude_from_sim!=null&&(n+=` (exclude_from_sim ${a.exclude_from_sim?"yes":"no"})`),n+=` ${x(a.at,0,!0)} ${k(a.effects)}`,a.uuid&&(n+=` (uuid "${_(a.uuid)}")`),n+=`)
`}else if(i.type==="text_box"){let a=i;n+=`${l(1)}(text_box "${_(a.text)}" ${x(a.at,0,!0)} (size ${f(a.size.x)} ${f(a.size.y)})`,a.exclude_from_sim!==void 0&&(n+=` (exclude_from_sim ${a.exclude_from_sim?"yes":"no"})`),a.margins&&(n+=` (margins ${f(a.margins.x)} ${f(a.margins.y)} ${f(a.margins.z)} ${f(a.margins.w)})`),n+=` ${k(a.effects)}`,a.stroke&&(n+=` ${$(a.stroke)}`),a.fill&&(n+=` ${I(a.fill)}`),a.uuid&&(n+=` (uuid "${_(a.uuid)}")`),n+=`)
`}}if(t.images&&t.images.length>0)for(let i of t.images){let o=[];for(let p=0;p<i.data.length;p+=76)o.push(i.data.slice(p,p+76));n+=`${l(1)}(image
`,n+=`${l(2)}${x(i.at)}
`,n+=`${l(2)}(data ${o.join(" ")})
`,n+=`${l(2)}(scale ${f(i.scale)})
`,i.uuid&&(n+=`${l(2)}(uuid "${_(i.uuid)}")
`),n+=`${l(1)})
`}if(t.tables&&t.tables.length>0)for(let i of t.tables)n+=`${xt(i,1)}
`;if(t.sheets&&t.sheets.length>0)for(let i of t.sheets)n+=ht(i,1);if(t.sheet_instances&&t.sheet_instances.length>0){n+=`${l(1)}(sheet_instances
`;for(let i of t.sheet_instances)n+=`${l(2)}(path "${_(i.path)}"`,i.page&&(n+=` (page "${_(i.page)}")`),n+=`)
`;n+=`${l(1)})
`}if(t.symbol_instances&&t.symbol_instances.length>0){n+=`${l(1)}(symbol_instances
`;for(let i of t.symbol_instances)n+=`${l(2)}(path "${_(i.path)}" (reference "${_(i.reference)}") (unit ${i.unit}) (value "${_(i.value)}") (footprint "${_(i.footprint)}"))
`;n+=`${l(1)})
`}return t.embedded_fonts!==void 0&&(n+=`${l(1)}(embedded_fonts ${t.embedded_fonts?"yes":"no"})
`),n+=`)
`,n}u(Y,"serializeSchematic");function P(t){let n=m(t,e.start("fill"),e.color(),e.pair("type",r.string));return{type:n.type||"none",color:n.color}}u(P,"parseFill");function kt(t){return m(t,e.start("wire"),e.list("pts",r.vec2),e.item("stroke",g),e.pair("uuid",r.string))}u(kt,"parseWire");function St(t){return m(t,e.start("bus"),e.list("pts",r.vec2),e.item("stroke",g),e.pair("uuid",r.string))}u(St,"parseBus");function wt(t){return m(t,e.start("bus_entry"),e.item("at",b),e.vec2("size"),e.item("stroke",g),e.pair("uuid",r.string))}u(wt,"parseBusEntry");function Pt(t){return m(t,e.start("bus_alias"),e.positional("name",r.string),e.item("members",n=>Array.isArray(n)&&n.length>1?n.slice(1).map(s=>typeof s=="string"?s:""):[]))}u(Pt,"parseBusAlias");function zt(t){return m(t,e.start("junction"),e.item("at",b),e.pair("diameter",r.number),e.color(),e.pair("uuid",r.string))}u(zt,"parseJunction");function Bt(t){return m(t,e.start("no_connect"),e.item("at",b),e.pair("uuid",r.string))}u(Bt,"parseNoConnect");function xe(t){return{...m(t,e.start("polyline"),e.list("pts",r.vec2),e.item("stroke",g),e.item("fill",P),e.pair("uuid",r.string)),type:"polyline"}}u(xe,"parsePolyline");function w(t,n){if(Array.isArray(t)){if(t.length>=2&&Array.isArray(t[1])&&t[1][0]==="xy")return m(t,e.start(n),e.vec2("xy")).xy;if(t.length>=3&&typeof t[1]=="number"&&typeof t[2]=="number")return{x:t[1],y:t[2]}}return{x:0,y:0}}u(w,"parseCenterOrStartOrEnd");function ke(t){return{...m(t,e.start("rectangle"),e.item("start",s=>w(s,"start")),e.item("end",s=>w(s,"end")),e.item("stroke",g),e.item("fill",P),e.pair("uuid",r.string)),type:"rectangle"}}u(ke,"parseRectangle");function Se(t){return{...m(t,e.start("circle"),e.item("center",s=>w(s,"center")),e.pair("radius",r.number),e.item("stroke",g),e.item("fill",P),e.pair("uuid",r.string)),type:"circle"}}u(Se,"parseCircle");function we(t){return{...m(t,e.start("arc"),e.item("start",s=>w(s,"start")),e.item("mid",s=>w(s,"mid")),e.item("end",s=>w(s,"end")),e.object("radius",{},e.start("radius"),e.item("at",s=>w(s,"at")),e.pair("length"),e.item("angles",s=>w(s,"angles"))),e.item("stroke",g),e.item("fill",P),e.pair("uuid",r.string)),type:"arc"}}u(we,"parseArc");function Pe(t){return{...m(t,e.start("bezier"),e.list("pts",r.vec2),e.item("stroke",g),e.item("fill",P),e.pair("uuid",r.string)),type:"bezier"}}u(Pe,"parseBezier");function ze(t){return{...m(t,e.start("text"),e.positional("text",r.string),e.item("at",b),e.item("effects",h),e.pair("exclude_from_sim",r.boolean),e.pair("uuid",r.string)),type:"text"}}u(ze,"parseText");function Be(t){return{...m(t,e.start("text_box"),e.positional("text",r.string),e.item("at",b),e.vec2("size"),e.item("effects",h),e.item("stroke",g),e.item("fill",P),e.pair("exclude_from_sim",r.boolean),e.vec4("margins"),e.pair("uuid",r.string)),type:"text_box"}}u(Be,"parseTextBox");function Lt(t){let n="";for(let i of t)if(Array.isArray(i)&&i.length&&i[0]==="data"){n=i.slice(1).join("");break}let s=m(t,e.start("image"),e.item("at",b),e.pair("scale",r.number),e.pair("uuid",r.string));return{...s,data:n,ppi:null,scale:typeof s.scale=="number"?s.scale:1}}u(Lt,"parseImage");function At(t){let n=m(t,e.start("table_cell"),e.positional("text",r.string),e.item("at",b),e.vec2("size"),e.vec4("margins"),e.item("effects",h),e.item("fill",P),e.item("stroke",g),e.pair("exclude_from_sim",r.boolean),e.pair("uuid",r.string),e.expr("span",(s,i,a)=>{if(Array.isArray(a)&&a[0]==="span")return{rows:a[1],cols:a[2]}}));return{text:n.text||"",at:n.at,size:n.size,margins:n.margins,span:n.span,stroke:n.stroke,fill:n.fill,effects:n.effects,exclude_from_sim:n.exclude_from_sim,uuid:n.uuid}}u(At,"parseTableCell");function jt(t){let n=m(t,e.start("table"),e.pair("column_count",r.number),e.object("border",{},e.start("border"),e.pair("external",r.boolean),e.pair("header",r.boolean),e.item("stroke",g)),e.object("separators",{},e.start("separators"),e.pair("rows",r.boolean),e.pair("cols",r.boolean),e.item("stroke",g)),e.list("column_widths",r.number),e.list("row_heights",r.number),e.pair("uuid",r.string),e.item("cells",s=>m(s,e.start("cells"),e.collection("items","table_cell",r.item(At))).items||[]));return{column_count:n.column_count,border:n.border,separators:n.separators,column_widths:n.column_widths||[],row_heights:n.row_heights||[],cells:n.cells||[],uuid:n.uuid}}u(jt,"parseTable");function Ct(t){return m(t,e.start("label"),e.positional("text",r.string),e.item("at",b),e.item("effects",h),e.atom("fields_autoplaced"),e.pair("uuid",r.string))}u(Ct,"parseNetLabel");function H(t){let n=m(t,e.start("property"),e.positional("name",r.string),e.positional("text",r.string),e.pair("id",r.number),e.item("at",b),e.item("effects",h),e.atom("show_name"),e.atom("do_not_autoplace"),e.atom("hide"));return{name:n.name,text:n.text,id:n.id||0,at:n.at,show_name:n.show_name||!1,do_not_autoplace:n.do_not_autoplace||!1,hide:n.hide||!1,effects:n.effects}}u(H,"parseProperty");function Tt(t){return m(t,e.start("global_label"),e.positional("text",r.string),e.item("at",b),e.item("effects",h),e.atom("fields_autoplaced"),e.pair("uuid",r.string),e.pair("shape",r.string),e.collection("properties","property",r.item(H)))}u(Tt,"parseGlobalLabel");function Et(t){return m(t,e.start("hierarchical_label"),e.positional("text",r.string),e.item("at",b),e.item("effects",h),e.atom("fields_autoplaced"),e.pair("uuid",r.string),e.pair("shape",r.string))}u(Et,"parseHierarchicalLabel");function Ot(t){return m(t,e.start("alternate"),e.positional("name",r.string),e.positional("type",r.string),e.positional("shape",r.string))}u(Ot,"parsePinAlternate");function Rt(t){return m(t,e.start("pin"),e.positional("type",r.string),e.positional("shape",r.string),e.atom("hide"),e.item("at",b),e.pair("length",r.number),e.object("name",{},e.start("name"),e.positional("text",r.string),e.item("effects",h)),e.object("number",{},e.start("number"),e.positional("text",r.string),e.item("effects",h)),e.collection("alternates","alternate",r.item(Ot)))}u(Rt,"parsePin");function Gt(t){return m(t,e.start("pin"),e.positional("number",r.string),e.pair("uuid",r.string),e.pair("alternate",r.string))}u(Gt,"parsePinInstance");function V(t){return m(t,e.start("symbol"),e.positional("name",r.string),e.atom("power"),e.object("pin_numbers",{},e.start("pin_numbers"),e.atom("hide")),e.object("pin_names",{},e.start("pin_names"),e.pair("offset",r.number),e.atom("hide")),e.pair("exclude_from_sim",r.boolean),e.pair("in_bom",r.boolean),e.pair("embedded_fonts",r.boolean),e.pair("embedded_files",r.string),e.pair("on_board",r.boolean),e.collection("properties","property",r.item(H)),e.collection("pins","pin",r.item(Rt)),e.collection("children","symbol",r.item(V)),e.collection("drawings","arc",r.item(we)),e.collection("drawings","bezier",r.item(Pe)),e.collection("drawings","circle",r.item(Se)),e.collection("drawings","polyline",r.item(xe)),e.collection("drawings","rectangle",r.item(ke)),e.collection("drawings","text",r.item(ze)),e.collection("drawings","textbox",r.item(Be)))}u(V,"parseLibSymbol");function Nt(t){return m(t,e.start("symbol"),e.pair("lib_name",r.string),e.pair("lib_id",r.string),e.item("at",b),e.pair("mirror",r.string),e.pair("exclude_from_sim",r.boolean),e.pair("unit",r.number),e.pair("convert",r.number),e.pair("in_bom",r.boolean),e.pair("on_board",r.boolean),e.pair("dnp",r.boolean),e.atom("fields_autoplaced"),e.pair("uuid",r.string),e.collection("properties","property",r.item(H)),e.collection("pins","pin",r.item(Gt)),e.object("default_instance",{},e.start("default_instance"),e.pair("reference",r.string),e.pair("unit",r.string),e.pair("value",r.string),e.pair("footprint",r.string)),e.object("instances",{},e.start("instances"),e.collection("projects","project",r.object(null,e.start("project"),e.positional("name",r.string),e.collection("paths","path",r.object(null,e.start("path"),e.positional("path",r.string),e.pair("reference",r.string),e.pair("value",r.string),e.pair("unit",r.number),e.pair("footprint",r.string)))))))}u(Nt,"parseSchematicSymbol");function Zt(t){return m(t,e.start("pin"),e.positional("name",r.string),e.positional("shape",r.string),e.item("at",b),e.item("effects",h),e.pair("uuid",r.string))}u(Zt,"parseSheetPin");function Kt(t){let n=m(t,e.start("sheet"),e.item("at",b),e.vec2("size"),e.atom("fields_autoplaced"),e.pair("exclude_from_sim",r.boolean),e.pair("in_bom",r.boolean),e.pair("on_board",r.boolean),e.pair("dnp",r.boolean),e.item("stroke",g),e.item("fill",P),e.pair("uuid",r.string),e.collection("properties","property",r.item(H)),e.collection("pins","pin",r.item(Zt)),e.object("instances",{},e.start("instances"),e.collection("projects","project",r.object(null,e.start("project"),e.positional("name",r.string),e.collection("paths","path",r.object(null,e.start("path"),e.positional("path",r.string),e.pair("page",r.string)))))));return{at:n.at,size:n.size,fields_autoplaced:n.fields_autoplaced||!1,exclude_from_sim:n.exclude_from_sim||!1,in_bom:n.in_bom||!1,on_board:n.on_board||!1,dnp:n.dnp||!1,stroke:n.stroke,fill:n.fill,properties:n.properties||[],pins:n.pins||[],uuid:n.uuid,instances:n.instances||{projects:[]}}}u(Kt,"parseSchematicSheet");function Ft(t){return m(t,e.start("sheet_instances"),e.collection("paths","path",r.object(null,e.start("path"),e.positional("path",r.string),e.pair("page",r.string)))).paths}u(Ft,"parseSheetInstances");function Dt(t){return m(t,e.start("symbol_instances"),e.collection("paths","path",r.object(null,e.start("path"),e.positional("path",r.string),e.pair("reference",r.string),e.pair("unit",r.number),e.pair("value",r.string),e.pair("footprint",r.string)))).paths}u(Dt,"parseSymbolInstances");var te=class te{parse(n){let s=z(n),i=s.length===1&&Array.isArray(s[0])?s[0]:s;return m(i,e.start("kicad_sch"),e.pair("version",r.number),e.pair("generator",r.string),e.pair("generator_version",r.string),e.pair("uuid",r.string),e.item("paper",K),e.pair("embedded_fonts",r.boolean),e.item("title_block",Z),e.item("lib_symbols",a=>m(a,e.start("lib_symbols"),e.collection("symbols","symbol",r.item(V))).symbols??[]),e.collection("wires","wire",r.item(kt)),e.collection("buses","bus",r.item(St)),e.collection("bus_entries","bus_entry",r.item(wt)),e.collection("bus_aliases","bus_alias",r.item(Pt)),e.collection("junctions","junction",r.item(zt)),e.collection("no_connects","no_connect",r.item(Bt)),e.collection("net_labels","label",r.item(Ct)),e.collection("global_labels","global_label",r.item(Tt)),e.collection("hierarchical_labels","hierarchical_label",r.item(Et)),e.collection("symbols","symbol",r.item(Nt)),e.collection("drawings","polyline",r.item(xe)),e.collection("drawings","rectangle",r.item(ke)),e.collection("drawings","arc",r.item(we)),e.collection("drawings","text",r.item(ze)),e.collection("drawings","bezier",r.item(Pe)),e.collection("drawings","text_box",r.item(Be)),e.collection("drawings","circle",r.item(Se)),e.collection("images","image",r.item(Lt)),e.collection("tables","table",r.item(jt)),e.item("sheet_instances",Ft),e.item("symbol_instances",Dt),e.collection("sheets","sheet",r.item(Kt)))}save(n){return Y(n)}parseLibSymbols(n){let s=z(n),i=s.length===1&&Array.isArray(s[0])?s[0]:s;return m(i,e.start("kicad_symbol_lib"),e.pair("version",r.number),e.pair("generator",r.string),e.pair("generator_version",r.string),e.collection("symbols","symbol",r.item(V))).symbols??[]}saveLibSymbols(n){let s=`(kicad_symbol_lib
`;s+=`${"	".repeat(1)}(version 20251024)
`,s+=`${"	".repeat(1)}(generator "kicad_symbol_editor")
`,s+=`${"	".repeat(1)}(generator_version "10.0")
`;for(let a of n)s+=T(a,1);return s+=`)
`,s}};u(te,"SchematicParser");var ee=te;function Vt(t){return m(t,e.start("kicad_wks"),e.pair("version",r.number),e.pair("generator",r.string),e.item("setup",Ht),e.collection("drawings","line",r.item(Jt)),e.collection("drawings","rect",r.item(Wt)),e.collection("drawings","polygon",r.item(Mt)),e.collection("drawings","bitmap",r.item(Ut)),e.collection("drawings","tbtext",r.item(Xt)))}u(Vt,"parse_drawing_sheet");function Ht(t){return m(t,e.start("setup"),e.pair("linewidth",r.number),e.vec2("textsize"),e.pair("textlinewidth",r.number),e.pair("top_margin",r.number),e.pair("left_margin",r.number),e.pair("bottom_margin",r.number),e.pair("right_margin",r.number))}u(Ht,"parse_setup");function L(t){let n=m(t,e.positional("start_token"),e.positional("x",r.number),e.positional("y",r.number),e.positional("anchor",r.string));return{x:n.x,y:n.y,anchor:n.anchor}}u(L,"parse_coordinate");var E=[e.pair("name",r.string),e.pair("comment",r.string),e.pair("option",r.string),e.pair("repeat",r.number),e.pair("incrx",r.number),e.pair("incry",r.number),e.pair("linewidth",r.number)];function Jt(t){return m(t,e.start("line"),e.item("start",L),e.item("end",L),...E)}u(Jt,"parse_line");function Wt(t){return m(t,e.start("rect"),e.item("start",L),e.item("end",L),...E)}u(Wt,"parse_rect");function Mt(t){return m(t,e.start("polygon"),e.item("pos",L),e.pair("rotate",r.number),e.list("pts",r.vec2),...E)}u(Mt,"parse_polygon");function Ut(t){return m(t,e.start("bitmap"),e.item("pos",L),e.pair("scale",r.number),e.pair("pngdata",r.string),...E)}u(Ut,"parse_bitmap");function Xt(t){return m(t,e.start("tbtext"),e.positional("text"),e.item("pos",L),e.pair("incrlabel",r.number),e.pair("maxlen",r.number),e.pair("maxheight",r.number),e.item("font",qt),e.pair("rotate",r.number),e.pair("justify",r.string),...E)}u(Xt,"parse_tbtext");function qt(t){return m(t,e.start("font"),e.pair("face",r.string),e.atom("bold"),e.atom("italic"),e.vec2("size"),e.pair("linewidth",r.number),e.color("color"))}u(qt,"parse_font");export{u as a,Yt as b,en as c,ie as d,tn as e,A as f,U as g,ee as h,Vt as i};
//# sourceMappingURL=chunk-XMZBYKYV.js.map

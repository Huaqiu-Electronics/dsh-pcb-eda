# 审计结论 — `@huaqiu/dsh-tool-pcb-viewer`（JS → TS 重写）

> 对应 `AUDIT.md` 的任务单。分支 `feat/pcb-3d-viewer`（389d596），基线 `main`（90d5fac）。
> 参照基准：`~/projects/pcb-scatter` @ `feat/dsh-plugin`（ea1ba53）。

## 一句话结论

**渲染器移植是干净的；解析器适配层不是。** 焊盘几何（任务单列的最高风险项）经 5 个 fixture、
924 个焊盘逐字段比对**零差异**。但 `adapter.ts` 里有 **5 处严重缺陷**，全部源于同一个根因：
适配层用 `as unknown as Record<string, unknown>` + 鸭子类型去猜上游形状，而没有用 parser
**实际导出的**类型。5 处缺陷现有测试**一个都测不到**。

---

## 复验：任务单声称的证据全部成立

| 证据 | 结果 |
|---|---|
| `pnpm typecheck` | 0 错误 ✅ |
| `pnpm test` | 9/9 通过 ✅ |
| `pnpm build` | 3 × `Build complete`，无 `MISSING_GLOBAL_NAME` ✅（index.mjs 14.88 kB / standalone.js 2.55 MB / client.js 2.62 MB） |
| `alwaysBundle` 是否覆盖 `three/addons/*` | ✅ `/^three(\/|$)/` 覆盖；9 处 addon import，构建日志确认 three 已打入 client 与 standalone |
| 版本 0.3.10 全仓同步 | ✅ 9 个包一致 |
| `cordis.patch.yml` / exports / peerDeps / files | ✅ 与 `dsh-artifacts`、`dsh-tool-part-search` 同构 |

**但 typecheck 的 0 错误对 `adapter.ts` 是空头支票**——见 S0。

---

## 严重

### S0（根因）`adapter.ts:14-18` 的前提是错的：proto 类型**是**导出的

```ts
// The proto types aren't exported via the package's exports map; derive them
// from the parser's public API instead of deep-importing its internals.
type I_KicadPCB = ReturnType<InstanceType<typeof BoardParser>['parse']>
```

parser 的 `dist/index.d.ts` 里有 `export * as boardProto from "./proto/board"`。已实测可用：

```ts
import { boardProto } from '@huaqiu/kicad-sexpr-parser'
type L = boardProto.I_Layer   // ✅ 通过 strict tsc
```

因为绕开了真实类型，下面 S1/S3/S4 三处**本该是编译错误**的字段名错误全部静默通过。
**这是 S1–S5 的共同根因，建议先修这一处，其余四处会自动变成红字。**

### S1 `adapter.ts:132` — 层名字段名写错，**任何板子都被当成 2 层**

```ts
.map((l) => (l && (l as { name?: string; canonicalName?: string }).name) ?? (l as {...}).canonicalName ?? '')
```

parser 的 `I_Layer`（`proto/board.d.ts:2-8`）字段是 **`canonical_name`**（蛇形）。`name` 与
`canonicalName` 都不存在 → `names` 恒为 `[]` → 恒走 `['F.Cu','B.Cu']` 兜底。

**实测**（合成 4 层板）：

```
TS cuLayers: ["F.Cu","B.Cu"]
JS cuLayers: ["F.Cu","In1.Cu","In2.Cu","B.Cu"]
```

**影响面**：`buildBoard.ts:174` `n=2` → 内层铜箔 sheet 根本不生成，1.6mm 叠层算错；
`textures.ts:475` `innerLayers=[]` → 内层走线永不绘制；`view2d.ts:106` 2D 视图丢内层；
`index.ts:121` 工具结果与卡片上报 `layers: 2`。**≥4 层板的内层布线整体不可见。**

**为什么测试没抓到**：5 个 fixture 全是 2 层板，兜底值恰好等于真值。

**修**：`(l as boardProto.I_Layer).canonical_name`。

### S2 `adapter.ts:92-102` — Edge.Cuts 的 `gr_rect` 塌成一条对角线

`I_Rect` 有 `start`/`end`，先命中 :92 的 line 分支。:100 那个带
`// I_Rect (start/end corners) → 4 lines` 注释的 `else if (g.start && g.end)` 是**不可达死代码**。

**实测**（矩形 (10,10)-(60,40)）：

```
TS outline: [{"type":"line","a":[10,10],"b":[60,40]}]            ← 1 条对角线
JS outline: 4 条边 [10,10]→[60,10]→[60,40]→[10,40]→[10,10]
```

矩形板框是 KiCad 最常见的情形。`outlinePolygon` 拿到单段退化输入 → 阻焊/铜箔的裁剪路径
与挤出板形全错。**注意 bbox 仍然正确**（对角线张成同样的外接矩形），所以 bbox 断言检测不出这个 bug。

**修**：`I_Line` 与 `I_Rect` 结构同形，需要判别式。实测 parser 的键集合可用：

```
gr_line   → end,layer,start,stroke,tstamp
gr_rect   → end,fill,layer,start,stroke,tstamp     ← 多一个 fill
gr_circle → center,end,fill,layer,stroke,tstamp
```

即 `'fill' in g` 可区分 rect / line。

### S3 `adapter.ts:95` — Edge.Cuts 的 `gr_circle` **永远被丢弃**

```ts
else if (g.center && g.end && typeof g.radius === 'number')
```

`I_Circle`（`proto/board.d.ts:108-120`）只有 `center`/`end`/`width`/`fill`/`stroke`，
**没有 `radius`**（上表的实测键集合也印证了）。原 JS 是 `r = hypot(end - center)`。

**实测**（center (20,20)、end (23,20)）：TS 丢弃；JS 给出 `{type:'circle',c:[20,20],r:3}`。

**这条同时推翻了任务单 §2 的「已知 quirk」结论。** 任务单说「纯 circle 板框会回退成 bbox 矩形，
因为原 JS 在空判之前过滤了 circle」——在 TS 版里机制不是这个：**circle 压根没进 outline 数组**。
后果比 quirk 严重得多：**line + circle 混合的板框（圆形挖槽、安装孔）在 TS 版会静默丢圆，
而原 JS 不会。** 这是新引入的回归，不是继承的历史 quirk，不应按「不在本次范围」放过。

### S4 `adapter.ts:113` — 所有 `gr_text` 丝印文字被丢弃

```ts
const layer = typeof g.layer === 'string' ? g.layer : ''
```

`I_GrText extends I_Text`，而 `I_Text.layer` 是 **`{ name: string; knockout: boolean }` 对象**
（`proto/board.d.ts:170-173`），不是字符串 → `layer` 恒为 `''` → `''.includes('SilkS')` 恒 false。

**实测**（stickhub.kicad_pcb）：`TS texts=0` vs `JS texts=9`；parser 实际给出 `layer: {"name":"F.SilkS"}`。

**影响**：`textures.ts:186` 的 `drawSilk` 拿不到任何板级丝印文字。器件位号走的是另一个循环，
仍会绘制——所以**退化是静默的**，看上去板子还有字。

**修**：`const layer = typeof g.layer === 'string' ? g.layer : (g.layer as {name?:string})?.name ?? ''`

### S5 `adapter.ts:160` — zone 多边形含 arc 顶点时坐标变成 `undefined`

```ts
pts: (z.polygons?.[0]?.pts ?? []).map((p) => { const pt = p as unknown as { x: number; y: number }; return [pt.x, pt.y] })
```

`I_Poly.pts` 的类型是 `({x,y} | I_Arc)[]`（`proto/board.d.ts:139-142`）。`I_Arc` 元素没有
`x`/`y` → `[undefined, undefined]`。**这正是任务单点名要查的 `as unknown` cast——它的假设不成立。**

**实测**（zone 内含 `(arc (start 5 1)(mid 7 3)(end 9 1))`）：

```
TS: [[1,1],[null,null],[20,1],[20,20],[1,20]]
JS: [[1,1],[20,1],[20,20],[1,20]]              ← 原版 if (xy[0]==='xy') 干净滤掉
```

**影响**：`textures.ts:260` 的 `drawZones` 执行 `ctx.lineTo(NaN, NaN)` → canvas 丢弃整条子路径 →
**整块铜皮消失**。

**修**：按原版语义过滤 `typeof p.x === 'number' && typeof p.y === 'number'`（或真正细分该 arc）。

---

## 中

### M1 `adapter.ts:160` — 多 polygon 的 zone 只保留第一个

`z.polygons?.[0]`；原 JS 遍历所有 `(polygon …)` 子节点，每个产出一个 zone。

**实测**：含 2 个 polygon 的 zone → TS 1 个 zone，JS 2 个。第二块铜皮静默消失。

### M2 `adapter.ts:107-127` — `adaptTexts` 扫的是全部 drawings，不只 `gr_text`

原 JS 只读 `children(root,'gr_text')`。TS 接受任何带字符串 `text` 的 drawing，而 `drawings`
的联合类型里含 `I_Dimension`（`proto/board.d.ts:497`）。当前被 S4 掩盖（什么都过不来），
**修完 S4 后就会暴露**：标注在 `*.SilkS` 上的尺寸文字会被当成板级丝印画出来。建议与 S4 一并修。

### M3 `index.ts:112-113` — 同步读 + 解析最大 120 MB，阻塞 host 事件循环

`execute` 内 `fs.readFileSync` 后紧跟 `BoardParser().parse()`。按默认 `maxFileBytes = 120MB`，
这会把整个 DSH host（路由、其它工具、流式输出）卡住数秒。客户端半边正是为了避免这点才用
`/pcb-viewer/api/file` 流式取文件——统计这条路径漏了同样的处理。

### M4 `index.ts:56,87-93,277` — registry 无上限、key 可预测、不分会话

- `registry` 是模块级 `Map`，**从不逐出**（长会话泄漏；且 404 文案 `unknown or expired file key`
  是误导——key 永不过期）；
- key 形如 `pcb-<Date.now() base36>-<seq base36>`，**可枚举**；
- `isTrustedRequest` 只看 `Host`/`Origin`，本机任意进程都能自行设置；且 `Origin` 缺失时
  （`if (origin && …)`）整条检查被跳过，`curl -H 'Host: localhost'` 直接放行。

合起来：本机任意进程可枚举 key 读取已登记文件的内容；且 registry 不按会话隔离，A 会话能读
B 会话登记的板子。这也许在 DSH 的本机信任模型之内，但值得是个**有意决策**而不是意外。
建议 `crypto.randomUUID()` 做 key + 有界 LRU。

---

## 轻

- **L1 `adapter.ts:167-170` 过孔坐标不再取整。** 原 JS 是 `+at.x.toFixed(3)`。实测
  esp_mcb_routed 94 个过孔里 85 个不同、stickhub 87 个里 24 个不同（如 `25.47708` vs `25.477`）。
  亚微米级，无视觉影响，但**是与参照管线的数值偏移**，且导致无法与 JS 黄金值做逐字节比对。
- **L2 `adapter.ts:33-38` `padNet` 优先级反了。** TS 优先 pad 内联 `net.name`；原 JS 优先按编号
  查顶层 net 表、再回退内联名。文件自洽时等价（5 个 fixture 924 个焊盘全等），
  内联名过期的文件上会分叉。
- **L3 `client/panel.tsx:503-504` `void textOfBlocks` / `void outlinePolygon`。** 这两个在**原 JS
  里就已经是死代码**，所以是死代码的忠实移植而非回归；`adaptBoard`/`BoardParser`（:19-20）
  在 panel 里同样未被使用。旁边那句注释「渲染由 host 半边完成」写反了（渲染在浏览器半边）。
  建议连同 import 一起删掉。
- **L4 `client.js.map`（4.07 MB）会随包发布。** `files: ["lib", …]` + client 构建 `sourcemap: true`
  → 发布物在 2.6 MB bundle 之外再带 4 MB map。无同类兄弟包可比，建议明确取舍。
- **L5 `package.json` 的 `"./client"` 没有 `types` 条件**（`"."` 有）。该 entry `dts: false`，
  本来也无处可指，仅记录不对称。

---

## 复核通过（无需改动）

- **焊盘几何完全等价。** 5 个 fixture、924 个焊盘，`x/y/w/l/shape/net/top/bottom/th` **零差异**。
  `xform` 旋转方向、`Math.abs(totalRot-90)<45` 的 w/l swap、`toFixed(4)`、
  `*.Cu`/`thru_hole` 映射、net 解析，逐位复现原管线。**任务单的头号风险项是干净的。**
- traces / vias / comps / zones 计数与 bbox 在 5 个 fixture 上全部一致
  （但见 S2：bbox 对矩形板框的塌陷**不敏感**，不能用作检测手段）。
- **`buildBoard.ts` 的结构性改动成立。** 数值字面量除 `0`/`1`/`2` 的出现次数外完全一致；
  平行数组回填 z/ex/delay、`withMid()`、放宽的 `track()`、删除的 `tmpE` 均保行为；
  叠层算术逐行相同。抽查复跑与其字节级等价证明一致。
- **`components.ts`**：`toLocal` 的 P(−rot) 逆变换完好（未退化回 P(rot)）；自适应细分阈值
  （`<1.5` 直角盒 / `<4` 圆角盒 1 段 / 其余 3 段）一致；`clamp` 在位；阴影 traverse 保留。
- **`textures.ts`**：少掉的 68 行是 `buildOutlinePath` —— 该函数**在原 JS 里已是死代码**
  （被共享的 `outlinePolygon` 取代，原文件 `textures.js:523-525` 的注释自己说明了这点），
  删除正确。`appendArcCanvas` 数学一致；`ctx.scale(1,-1)` 丝印预翻转两处调用点均保留；
  `drawCopperNoise` 的 `?? 0` 对真实 `Uint8ClampedArray` 是 no-op；
  outline 兜底成 bbox 矩形的逻辑移进 catch，语义等价。
- **`view2d.ts` / `materials.ts` / `pcb/outline.ts`**：数值字面量逐字节相同；隐藏面板的 scale
  下限钳制保留。
- **`client/panel.tsx`**：`indexPreviews` 的 callId→turn 两趟索引、250MB 文本缓存与逐出、
  槽位注册（`conversation.session.header.actions` 观察器 + `conversation.chat.turnTail`
  chain 槽位、`priority: -1`、按回合号自选举的 `select`）与原版逐行一致。
- **`viewer.ts`**：TS 窄化修复（`loadBoard` 返回值赋给 `initialBoard`）两处使用点均正确。

---

## 测试覆盖缺口（元结论）

**S1–S5 五条，现有 `test/adapter.test.ts` 一条都测不到**，因为 5 个 fixture 共享同一个盲区：

| 缺口 | 漏掉的缺陷 |
|---|---|
| 全部是 2 层板 | S1 |
| Edge.Cuts 上无 `gr_rect` | S2 |
| Edge.Cuts 上无 `gr_circle` | S3 |
| 唯一有 `gr_text` 的 stickhub（9 条）**没有对 `texts` 的断言** | S4 |
| 无 arc 顶点的 zone、无多 polygon 的 zone | S5 / M1 |

黄金值本身**可信**（焊盘、计数、TH/SMD 双面判定都经得起复核），只是没覆盖真正断掉的接缝。

**建议**：加一个合成 fixture，同时含 4 层铜 + 矩形板框 + 圆形挖槽 + 丝印文字 +
「多 polygon 且含 arc 顶点」的 zone。这一个 fixture 可以一次抓住上述全部五条。

## 建议修复顺序

1. **S0** — 改用 `boardProto.*` 真实类型（S1/S3/S4 立刻变成编译错误）
2. **S1** → **S5** → **S4 + M2** → **S2** → **S3**（按影响面）
3. 补上述合成 fixture，先让它红、再让它绿
4. M3 / M4（host 侧韧性与信任边界），随后 L1–L5

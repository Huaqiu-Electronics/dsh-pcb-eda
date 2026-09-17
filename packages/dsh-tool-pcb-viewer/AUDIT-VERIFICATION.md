# 复核结论 — 对 `AUDIT-RESPONSE.md` / 修复提交 `573c880` 的独立验证

> 复核者：审计方。方法：**不采信响应表**，用独立的差分工具重跑
> 「TS 适配层 vs 原 JS `parseKicad` 管线」逐字段比对（7 个 fixture），
> 并独立复现红→绿。

## 总评

**14 条发现全部属实修复**（S0–S5 / M1–M4 / L1–L4；L5 明确记为不改）。
红→绿我独立复现了,而且比响应说的更强：**回退到旧 adapter 是 7 条红,不是 5 条**。

差分比对结果：7 个 fixture、1859 个焊盘、所有字段现在与原 JS 管线**等价**,
仅 3 处剩余差异——**全部有解释,其中 1 处是 TS 更正确,1 处是修复前就存在的**。

## 复核证据

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | 0 错误 ✅ |
| `pnpm test` | 20/20 ✅ |
| `pnpm build` | 3 产物 ✅，`client.js.map` 已消失（L4 确认生效） |
| **红→绿（独立复现）** | 把 `48d548b` 的旧 adapter 换回去 → **7 条红**：stickhub 丝印、S1/S2/S3/S4/S5+M1、CM5 六层。换回新 adapter → 20/20 绿。适配层已 `git checkout` 还原并逐字节校验 |
| 差分：cuLayers / outline(集合) / zones / traces / vias / bbox / pads | 7 个 fixture 全等 ✅ |
| 差分：pads 逐字段 | **1859 个焊盘,0 处不符** ✅ |

---

## 剩余 3 处差异（逐条定性）

### D1 stickhub 丝印文本：**TS 比 JS 正确**——不要往回改

```
TS = "REMOVE SLDR\nBRIDGE TO USE\nEXTERNAL\nPOWER SUPPLY"   ← 真实换行
JS = "REMOVE SLDRnBRIDGE TO USEnEXTERNALnPOWER SUPPLY"      ← 字面 n
```

根因在**原 JS 的 tokenizer**（`parseKicad.js:31`）：

```js
if (src[j] === '\\') { s += src[j + 1]; j += 2; continue }   // 反斜杠后的字符原样取走
```

`\n` 被吃成字面 `n`。已发布的 parser 正确解码转义。**这是原管线的 bug,TS 修对了。**
记录在案,免得日后有人拿 JS 黄金值把它「改回去」。

### D2 CM5 拼接外框绕向相反 —— **修复前就存在,非本次引入**

```
              areaOLD      areaNEW       areaJS
CM5_MINIMA_3  -3054.624    -3054.624     3054.624      ← old == new，符号与 JS 相反
其余 6 个       与 JS 完全一致（synth_full 见 D3）
```

`areaOLD == areaNEW` 证明**修复没有改变这个行为**,不在 `573c880` 的账上。

根因：原 JS 按**种类分批**收集 Edge.Cuts（先全部 `gr_line`,再 `gr_arc`,再 `gr_rect`,再 `gr_circle`）,
TS 适配层按**文档顺序**收集；而 `outline.ts:40` 的贪心拼接从 `polys.shift()`（数组第一段）起链,
起点不同 → 遍历方向可能相反。绝对值到小数点后 4 位一致,**是同一个环,只是反向**。

**是否有害：大概率无害,但这是个未经验证的假设。** 单个闭合环下,canvas 的 nonzero 填充与
`THREE.Shape` 的三角化都不区分绕向。但这是真实板子上**唯一残留的几何分歧**,
建议要么显式验一次（对比 CM5 的 3D 出图）,要么在 `outlinePolygon` 收尾处归一化绕向（强制 CCW）。

### D3 `synth_full` 拼接面积 1475(TS) / 1525(JS),而矩形真值是 1500 —— **fixture 自身的问题**

fixture 里那条 `gr_line (0,0)→(5,0)` 与 50×30 的矩形**完全不相连**。
`outlinePolygon` 的贪心「最近端点」链会把它并进环里,得到一个自交的环,
且结果取决于从哪一段起链——所以 TS 和 JS 各错一边（±25）。

现有断言查的是 outline **线段**（正确,5 段:4 边 + 1 独立线）,没查拼接后的多边形,所以测试是绿的。

**建议**：把「独立 `gr_line` 也能进 outline」这条覆盖挪到单独 fixture,或让这条线接进板框,
使 `synth_full` 代表一块**合法**的板子。否则它是唯一一个新管线拼接几何可证地偏离参照的 fixture。

---

## 新发现：S3 修在接缝上是对的,但端到端症状仍在

响应 S3 行写「circle (20,20) r=3 保留」——**对模型层面是准确的,但不能读作「圆形板框现在能渲染了」**。

`outline.ts:10-11`：

```ts
const segs    = (board.outline || []).filter((s) => s.type !== 'circle')   // 圆被剔掉
const circles = (board.outline || []).filter((s) => s.type === 'circle')   // ← 死变量，从未被用
```

`circles` 算出来就没人用（**原 JS 里也一样,是忠实移植,不是回归**）。而 `outlinePolygon` 是
2D 视图、贴图裁剪路径、3D 挤出板形的**唯一**几何来源。实测纯圆形板框：

```
outline : [{"type":"circle","c":[30,30],"r":10}]          ← S3 修好了，圆进了模型
bbox    : {"x0":20,"y0":20,"x1":40,"y1":40}                ← bbox 也对了
stitched: [[20,20],[40,20],[40,40],[20,40]]                ← 仍然是 bbox 矩形，不是圆
```

即 **AUDIT.md 原文点名的那个「已知 quirk」原样健在**,只是原因换了：不再是「适配层丢圆」,
而是「拼接器剔圆」。圆形板 / 圆形挖槽仍然渲染不出来。

这与原任务单的判断一致（「建议单独开 issue 修,不在本次审计范围」）——**本轮修复没有、也不需要
覆盖它**。此处仅确认：S3 关掉的是「混合板框静默丢圆」这个**新回归**,继承的老 quirk 还在,
需要另开 issue 修 `outline.ts`。

---

## 对修复本身的三点轻微观察

- **`index.ts` `registrySet` 的 FIFO 会逐出仍在使用的条目。** 一个会话里预览到第 33 块板时,
  第 1 块的独立页标签重新加载会拿到 404,而文案已改成 `unknown file key`,不再提示「过期」,
  用户看不出发生了逐出。32 条上限相当宽裕、客户端又有文本缓存,影响很低——只是有界化天然带来的取舍,
  记录一下。
- **`execute` 里的 `fs.existsSync` 仍是同步的**（可忽略）；`BoardParser().parse()` 仍是事件循环上的
  同步 CPU 计算——响应与代码注释都**如实标注了这是延后项**,不算隐瞒。
- **registry 仍未按会话隔离**（原 M4 的一半）。改用 `randomUUID` 之后跨会话读取需要猜中 UUID,
  实际风险基本关闭,可以接受。

---

## 结论

修复质量高:改在了正确的层（接缝用真实类型,而不是到处打补丁）,测试网确实能网住原缺陷
（我独立验了 7 条红）,并且自查修正了 CM5 丝印为 0 这个容易误判的点。

**建议合并。** 合并前可选做两件小事：

1. `synth_full.kicad_pcb` 里那条悬空 `gr_line` 挪走或接上（D3）;
2. 给 `outline.ts` 的圆形处理与绕向归一化开一个后续 issue（D2 + 老 quirk）。

两条都不阻塞本次修复。

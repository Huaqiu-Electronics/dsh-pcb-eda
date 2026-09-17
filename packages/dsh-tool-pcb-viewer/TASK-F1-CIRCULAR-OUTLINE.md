# 任务单 ④ — F1：圆形板框 / 圆形挖槽渲染不出来

> 交办对象：Claude（实现 + 自测）。基线分支：`ts`（= `feat/pcb-3d-viewer`，`379e6bf`）。
> 包路径：`packages/dsh-tool-pcb-viewer`

## 现状（先复现再动手）

`src/pcb/outline.ts:10-11`：

```ts
const segs    = (board.outline || []).filter((s) => s.type !== 'circle')   // 圆被剔除
const circles = (board.outline || []).filter((s) => s.type === 'circle')   // 算了，从未使用
```

`outlinePolygon()` 是**唯一的板框几何来源**，三个消费者：

| 消费者 | 位置 | 用途 |
|---|---|---|
| 纹理 | `src/scene/textures.ts:463` | 阻焊/铜箔/内层的 canvas 裁剪路径 |
| 3D | `src/scene/buildBoard.ts:122` | 挤出板形（THREE.Shape） |
| 2D | `src/viewer.ts:333` | 2D 视图板体填充 + 描边 |

**症状**：
- 纯圆形板框（Edge.Cuts 只有 `gr_circle`）→ `segs.length === 0` → 回退 bbox **矩形**，圆盘渲染成方板
- 矩形板 + 圆形挖槽（Edge.Cuts 上矩形环 + 圆）→ 圆被忽略，**挖槽不出现**，板子是实心的

这是**从 JS 版忠实移植的老 bug**（原版同样剔圆），不是本次移植引入的。

## 验收标准

1. `synth_circle_only`（只有 1 个 `gr_circle` 的板框）→ 2D/3D/纹理都是**圆盘**，不是矩形
2. `synth_circle_cutout`（矩形环 + 板内 1 个圆）→ 圆处**是洞**（2D 能看到、纹理裁剪掉、3D 挤出有孔）
3. 现有 38 个测试全绿（含 `test/parity.test.ts` 的双引擎一致性）
4. 真实板回归：CM5 / stickhub / esp_mcb / jetson 的**渲染结果与修复前一致**（这些板没有 Edge.Cuts 圆，走的是同一条环路径）
5. `pnpm typecheck` 0 错误、`pnpm build` 3 产物、`pnpm test` 全绿

## 建议实现（设计已定，按这个做）

**不要**把圆硬塞进主环点列表（会自交）。圆是**独立子路径**，语义是「洞」（或纯圆板时就是板体本身）：

### 1. `src/pcb/outline.ts` 新增结构化入口，保留旧签名

```ts
/** 板框几何：主环 + 洞（圆/内环）。ring 语义与旧 outlinePolygon 相同。 */
export interface OutlineParts { ring: Pt[]; holes: Pt[][] }
export function outlineParts(board: BoardModel): OutlineParts
export function outlinePolygon(board: BoardModel): Pt[]   // = outlineParts(board).ring（兼容保留）
```

- `ring`：现有缝合逻辑不变（含绕向归一化）
- `holes`：每个 `type: 'circle'` 的 outline 段 → 采样成 32~64 点的**圆环点列**（绕向与 ring 相反，THREE 的 hole 语义需要）；若将来支持内环线（非圆的封闭内环）也走这里
- **纯圆板特例**：若 `segs.length === 0` 且存在圆 → `ring` = 最大那个圆的采样点列（**不要回退 bbox**），其余圆进 `holes`
- 无圆时：`holes = []`，`ring` 与旧行为**逐点一致**（这点必须有测试钉住）

### 2. 三个消费者

| 文件 | 改法 |
|---|---|
| `src/scene/textures.ts:463` | `outlineParts()`；`Path2D` 里先画 `ring` 再 `moveTo`+`arc` 每个洞（canvas 多子路径 + 默认 `nonzero` 填充即天然挖空）。**注意绕向**：hole 与 ring 反向才能挖空；若不确定，用 `ctx.clip(path, 'evenodd')` 更稳 |
| `src/scene/buildBoard.ts:122` | `THREE.Shape` 用 `ring`，每个洞构造 `THREE.Path` 塞进 `shape.holes`；纯圆板时 `ring` 即圆盘 |
| `src/viewer.ts:333` | `v2d.setBoard(parsed, parts)`；`view2d.ts` 的 `renderBoard` 用小改动：填 `ring` 后对每个洞用 `globalCompositeOperation = 'destination-out'` 或 `evenodd` 填充挖空（**不要**破坏已做的离屏缓存与批量化） |

### 3. 新增 fixture 与断言（**先红后绿**）

`test/fixtures/synth_circle_only.kicad_pcb`：Edge.Cuts 只有 1 个 `gr_circle (center 20 20) (end 30 20)`
`test/fixtures/synth_circle_cutout.kicad_pcb`：Edge.Cuts 矩形环（4 条 gr_line）+ 板内 `gr_circle (center 25 25) (end 28 25)`

断言（加到 `test/adapter.test.ts` 或新建 `test/outline.test.ts`）：
```ts
// 纯圆板
const parts = outlineParts(load('synth_circle_only.kicad_pcb'))
expect(parts.holes.length).toBe(0)
expect(parts.ring.length).toBeGreaterThan(16)          // 采样点列，不是 4 点矩形
const r = 半径估算(parts.ring, [20,20]); expect(r).toBeCloseTo(10, 1)
// 带挖槽
const p2 = outlineParts(load('synth_circle_cutout.kicad_pcb'))
expect(p2.ring.length).toBe(4)                          // 矩形环
expect(p2.holes.length).toBe(1)
const hr = 半径估算(p2.holes[0], [25,25]); expect(hr).toBeCloseTo(3, 1)
```

**提交前自证**：把 `outline.ts` 回退到修复前 → 上述新断言应**红**；修好后应**绿**（和上一轮 S1–S5 一样的红→绿证据）。

## 不要动的部分

- 缝合算法本体（贪心链 + 绕向归一化）与 `arcPts` 采样
- 离屏缓存 / 2D 批量化 / 画质档位 / 解析缓存（都是刚做的性能优化）
- `src/parse.ts` 的引擎选择（默认自带 parser）
- `BoardModel` 的既有字段（可以加，不可以改语义）

## 完成后

1. `pnpm typecheck && pnpm test && pnpm build` 全绿
2. 更新 `FOLLOWUPS.md`：把 F1 标记为已修（附实现要点 + 遗留：非圆内环、多级洞暂不支持）
3. 提交（不要 push，等 ① 的统一推送流程（见 MILESTONE.md））

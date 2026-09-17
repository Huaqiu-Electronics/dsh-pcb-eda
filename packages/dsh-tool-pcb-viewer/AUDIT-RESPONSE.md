# 修复响应 — 对应 AUDIT-FINDINGS.md（复核用对照表）

> 修复提交：`573c880`（feat/pcb-3d-viewer）。复核基线：`AUDIT-FINDINGS.md` 的每条发现。
> 复核方式：`cd packages/dsh-tool-pcb-viewer && pnpm typecheck && pnpm test && pnpm build`
> （基线：tsc 0 错误 / vitest 20/20 / tsdown 3 产物）。

## 严重（5/5 已修）

| # | 发现 | 修复位置 | 复核证据 |
|---|---|---|---|
| S0 | proto 类型其实经 `boardProto` 导出 | `src/adapter.ts:12-22` 改 `import { BoardParser, boardProto }`，类型全部 `boardProto.I_*`；错误前提注释已删 | S1/S3/S4 对应的字段名若再写错会直接变红字（类型把关恢复了） |
| S1 | 层名字段 `canonical_name` | `adapter.ts` `cuLayerOrder()` 读 `l.canonical_name` | 合成 fixture 断言 4 层；CM5 断言 6 层 + 运行时冒烟 `layerCount: 6` |
| S2 | gr_rect 塌成对角线 | `adaptOutline()` 用 `'fill' in g` 判别 rect → 4 边（顶点顺序同原 JS） | 合成 fixture：5 条 line 段（4 边 + 1 独立 gr_line），span 正确 |
| S3 | gr_circle 被丢弃 | `adaptOutline()` 用 `center/end` → `r = hypot(end − center)` | 合成 fixture：circle (20,20) r=3 保留；**审计指出的"新回归非 quirk"已采纳** |
| S4 | gr_text layer 是对象 | `adaptTexts()` 读 `layer.name`（对象）或 string 兼容 | stickhub 真实数据断言 9 条丝印；合成 fixture 断言 SilkS 进 / CrtYd 滤 |

## 中（4/4 已修）

| # | 发现 | 修复位置 | 复核证据 |
|---|---|---|---|
| M1 | zone 只留第一个 polygon | `adaptBoard()` 遍历 `z.polygons` 全部 | 合成 fixture 双 polygon zone → 2 个 zone |
| M2 | adaptTexts 可能误收 dimension | 显式 `'gr_text' in d → continue`（I_Dimension 文本在嵌套层） | 合成 fixture 的 CrtYd 文本 + dimension 防护路径 |
| M3 | 同步读 120MB 阻塞事件循环 | `fs.promises.stat/readFile`（IO 异步化）；parse 仍是同步 CPU（进 Worker 另行评估，已在注释标注） | tsc 通过；`execute` 为 async |
| M4 | key 可枚举 / registry 无界 / 404 文案误导 | `crypto.randomUUID()` key + 32 条 FIFO 有界逐出 + 文案改 "unknown file key"；信任边界在注释中声明为有意决策 | 代码可查；Host/Origin 守卫保留 |

## 轻（4/5 已修）

| # | 发现 | 修复 |
|---|---|---|
| L1 | 过孔坐标未取整 | `adapter.ts` vias `+toFixed(3)`（与原管线一致，esp_mcb_routed/stickhub 逐位可比对了） |
| L2 | padNet 优先级反了 | 编号 → 顶层 net 表优先，内联名兜底（与原 JS 一致） |
| L3 | panel.tsx 死代码 + 注释写反 | 删 `void textOfBlocks`/`void outlinePolygon`/未用 import 与函数；注释改为「渲染在浏览器半边」 |
| L4 | client.js.map 4MB 随包发布 | client 构建 `sourcemap: false` |
| L5 | `./client` 无 types 条件 | **保留现状**：该 entry `dts: false`，本来无处可指（仅记录不对称，不改动） |

## 测试网（红→绿证据）

- 新增 `test/fixtures/synth_full.kicad_pcb`（合成：4 层铜 + gr_rect + gr_circle + gr_text×2 + 双 polygon 含 arc 顶点 的 zone）——审计推荐的"一网打尽"fixture
- 新增 `test/fixtures/CM5_MINIMA_3.kicad_pcb`（真实 6 层板回归）
- **红→绿已证**：`git show 48d548b:.../adapter.ts` 换回去 → 新测试 5 条全红；换回新 adapter → 20/20 绿
- 一个自查修正：CM5 的 131 条 gr_text 全在 Dwgs.User 层，SilkS 为 0 是**正确**行为（断言写的是"不误收"）

## 复核时要不要再跑一次等价证明

buildBoard 的字节级等价证明脚本在审计期间由移植子代理临时生成后已删；如需复跑可用同样方法
（stub materials/components/textures → 快照 4 fixture × 4 动画态）。渲染器部分本轮未动。

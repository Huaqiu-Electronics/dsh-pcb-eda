# Follow-ups（复核后遗留，非阻塞）

> 复核见 `AUDIT-FINDINGS.md`（发现）+ `AUDIT-RESPONSE.md`（修复响应）+ `AUDIT-VERIFICATION.md`（独立复核）。

## F1 — 圆形板框 / 圆形挖槽渲染不出来 —— ✅ 已修（见 `TASK-F1-CIRCULAR-OUTLINE.md`）

**修法**：圆不并进主环（会自交），而是作为**独立子路径**：

- `src/pcb/outline.ts` 新增 `outlineParts(board): { ring, holes }`；`outlinePolygon()`
  保留为 `parts.ring` 的兼容别名，既有调用方无需改动。
  - 有线段环时：圆 → `holes`（挖槽），`ring` 与修复前**逐点一致**
  - 只有圆时：**最大的圆即板体**（`ring` = 48 边采样），其余圆进 `holes`；不再回退 bbox 矩形
  - 无圆时：`holes = []`，`ring` 逐点不变（测试钉住）
  - 绕向：`ring` CCW（沿用既有归一化），`holes` CW
- 三个消费方：
  - `scene/textures.ts` — `Path2D` 主环 + 每个洞一条子路径，三处 `ctx.clip(path, 'evenodd')`
  - `scene/buildBoard.ts` — 每个洞构造 `THREE.Path` 推入 `shape.holes`
  - `scene/view2d.ts` + `viewer.ts` — `setBoard(parsed, parts)`，板体 `fill/clip` 用 `'evenodd'`，
    描边同时描主环与洞；离屏缓存与批量化未动

**证据**：`test/outline.test.ts`（19 条）。红→绿已证：把 `outline.ts` 回退到修复前行为，
恰好 6 条圆相关断言变红、10 条回归断言保持绿。端到端到 3D 几何也有断言（挖槽板
面积 = 900 − 采样圆面积；纯圆板面积 = 圆盘而非 400 的 bbox 方形）。
真实板（CM5 / stickhub / esp_mcb / esp_mcb_routed / mini-motor / simple_led）
无 Edge.Cuts 圆，`ring` 逐字节不变、`holes` 为空。

**遗留（本次不做）**：
- **非圆内环**（由线段/圆弧围成的封闭内环）仍不识别为洞——需要在缝合器里做多环分离，
  当前贪心链会把它们并进主环
- **多级洞**（洞中岛）不支持
- 纯圆板取「最大圆为板体」是启发式：若某板真的只有多个同级圆形轮廓，语义会判错

## F2 — registry FIFO 逐出仍在用的条目

第 33 块板之后，第 1 块板的「浏览器打开」独立页会 404（文案也不再提示过期）。
若觉得这是问题：LRU 改成按访问更新热度，或给路由返回一个「重新在会话里调用
pcb_preview 以重新登记」的明确指引文案。当前容量 32 对真实使用足够。

## F3 — parse() 仍是事件循环上的同步 CPU

IO 已异步化（M3），但大板 parse 本身仍是秒级同步 CPU。彻底解法是 Worker 线程
（`node:worker_threads`），另行评估。

## F4 — registry 不按会话隔离

A 会话能读 B 会话登记的板子。randomUUID 后实际枚举风险已基本关闭；如要严格隔离，
registry 的 value 记上 sessionId，路由校验 key 的归属会话。

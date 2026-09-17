# Audit brief — `@huaqiu/dsh-tool-pcb-viewer`（JS → TS 重写）

> 给审计者（Claude）的任务单。分支：`feat/pcb-3d-viewer`，基线：`main`（90d5fac）。

## 这是什么

把已实测定稿的 **kicad-3d-viewer**（JS 版，独立仓库）整体移植为本 monorepo 的新包，
**全部 TypeScript 化**，并把解析器换成已发布的 `@huaqiu/kicad-sexpr-parser`。

- 原始 JS 版（参照基准）：`/Users/eleven-macmini/projects/pcb-scatter`，分支 `feat/dsh-plugin`
  - `src/pcb/parseKicad.js`（自写 parser，已被 adapter 取代）
  - `src/scene/{materials,textures,components,buildBoard,view2d}.js`、`src/viewer.js`
  - `index.js`（host）、`client-src/{panel.jsx,standalone.js}`（client）
- 本包全部新文件都在 `packages/dsh-tool-pcb-viewer/` 下，不改动任何既有包。

## 一键验证

```bash
cd packages/dsh-tool-pcb-viewer
pnpm build        # tsdown：lib/index.mjs + lib/client.js + lib/standalone.js（应 3 个 Build complete，无 MISSING_GLOBAL_NAME）
pnpm test         # vitest：adapter 对齐测试 9/9 应通过
pnpm typecheck    # strict tsc：应 0 错误
```

## 审计重点（按风险排序）

### 1. 解析器适配层 — `src/adapter.ts`（最高风险）

这是换 parser 的唯一接缝。对照原始 `parseKicad.js` 重点核：

- **焊盘绝对坐标**：`xform()` 的旋转矩阵方向（KiCad CCW）；90°/270° 封装的 w/l swap 判定
  （`Math.abs(totalRot - 90) < 45`）；`toFixed(4)` 精度损失是否可接受。
- **pad 顶/底/通孔判定**：`layers.includes('*.Cu')`、`thru_hole` 的映射是否与原 parser 等价。
- **net 解析**：`pad.net` 可能是 `{}`（空对象）或 `{number,name}`；`board.nets` 可能缺省。
- **Edge.Cuts**：从 `drawings` 过滤 `layer === 'Edge.Cuts'`；arc 的 start/mid/end 字段名。
- **zone polygon**：`polygons[0].pts`（pts 元素可能带 arc 变体，已 `as unknown` 收窄——检查这个 cast 的假设）。
- **cuLayers 排序**：F.Cu, In1..InN, B.Cu 的 `rank()` 函数。
- **测试覆盖**：`test/adapter.test.ts` 的黄金值来自原管线实测（K1 继电器 (92,11) + 18.5×4.7 跨距、
  CN4 旋转连接器纵向分布、TH/SMD 双面判定、routed 板 891 traces/94 vias）。黄金值本身是否可信
  可对照 `~/projects/pcb-scatter/tests/` 里的原 parser 测试。

### 2. 渲染器移植（逐文件对照原 JS）

每个文件都应与原版**数值/分支完全一致**。已知移植者为通过 strict 模式做的结构性改动：

- **`src/scene/buildBoard.ts`**（子代理移植，带字节级等价证明）：
  - outline 的 `...(o.m ? {m} : {})` spread 改成了 `withMid()` helper（narrowing 不穿透 spread）；
  - 层叠的 z/ex/delay 两轮赋值改成了平行数组回填；
  - `track()` 从 `BufferGeometry` 放宽到 `{ dispose?: () => void }`（原代码也 track 材质）；
  - 删了死变量 `tmpE`；
  - 证明方式：4 fixture × 4 动画态的快照 JSON 双侧字节一致（105468 bytes）。
  - **审计点**：这些结构性改动是否真的保行为（它的证明方式可信，但可抽查一两个 fixture 复跑）。
- **`src/scene/textures.ts`**：
  - Node 无 DOM 的 canvas/Path2D shim 用 `as unknown as Ctx` 收窄——检查 shim 表面是否覆盖了
    所有真实调用点；
  - `getImageData` 的像素回写用了 `?? 0` 兜底（`noUncheckedIndexedAccess`）——确认与原版数值一致；
  - 丝印文字的 `ctx.scale(1,-1)` 预翻转是实测修过的 bug，必须保留。
- **`src/scene/components.ts`**：
  - `toLocal` 的 P(−rot) 逆变换是修过的 bug（90°/270° 用错方向的 P(rot)）——对照注释确认没退化；
  - 焊盘质心重定心（re-centering shift）与 B.Cu 底部翻转块的顺序/作用域；
  - 自适应细分（<1.5mm 直角盒 / <4mm 圆角盒 1 段 / 其余 3 段）——这是 JS 版后期的性能改动，确认阈值一致。
- **`src/scene/view2d.ts`**：scale 下限钳制（隐藏面板 0×0 时 arc 负半径崩溃的修复）必须保留。
- **`src/viewer.ts`**：
  - **TS 窄化修复**：`loadBoard` 返回值赋给 `initialBoard`（原版读闭包变量，TS 下会窄化成 null/never）。
    确认两处（loadBoard 后、frame 循环）的 `board` 使用都正确；
  - `bokeh.uniforms` 的 `as Record<string, {value:number}>` cast；
  - `scene.fog` 提成了局部 `fog` 变量（Fog 类型收窄）；
  - 画质档位（TIERS/autoTier/setQuality/applyTier）与 FPS HUD；
  - `textures:false` 轻渲染路径。
- **已知 quirk（如实保留，未修）**：纯 circle 板框（Edge.Cuts 只有圆）会回退成 bbox 矩形——
  原 JS 在空判之前过滤了 circle。**这是个疑似历史 bug**，建议单独开 issue 修，不在本次审计范围拦它。

### 3. host 插件 — `src/index.ts`

- `defineTool` 契约：parameters/output.schema/render/presentCall/presentResult 的类型是否贴合
  `@deepseek-ai/dsh-tools` 的真实定义（用了 `type:'json'` schema + `as unknown as JsonValue` cast——
  检查这两个 cast 是否掩盖了真实的类型问题，还是确实是上游 JsonValue 不含 undefined 的已知摩擦）；
- `sessionCwdOf` 的防御性探测（`exec.sessionId ?? exec.session?.id ?? exec.context?.sessionId`）——
  上游 `ToolRunContext` 的类型不暴露 sessionId，运行时探测已实测有效，但值得确认正式类型路径；
- `ctx.webServer` 的声明合并依赖 `import type {} from '@deepseek-ai/dsh-host-webserver'`；
- 路由的 localhost Host/Origin 信任守卫；
- `bundleRev` 读 `lib/standalone.js` 的 mtime——构建产物不进 git，首次使用前要 `pnpm build`。

### 4. client 半边 — `src/client/`

- **`panel.tsx`**：DSH client 平台类型未作为依赖安装，用了本地最小接口（`ClientContext`/`SlotSpec`/
  `SessionNode` 等）。**如果以后装了真实的 DSH client 类型包**，`ctx.slots.register(...)` 与 turnTail
  的 `select` 两处是最可能暴露签名不匹配的点（移植者已标注）。
- 槽位：`conversation.session.header.actions`（观察器）+ `conversation.chat.turnTail`（chain 槽位，
  `select` 按回合号自我选举，`priority: -1` 先于官方 deliverables）。对照
  `dsh-src` 的 slot-catalog 确认槽位契约（chain 语义、TurnLocation 形状）。
- 文本缓存 250MB 上限 + 逐出最旧；大板（>8MB）轻渲染阈值 `THUMB_MAX_KB`。
- **`standalone.ts`**：纯 IIFE 入口，读 `?key&name&mode`。

### 5. 构建与打包 — `tsdown.config.ts` / `package.json`

- 三个 entry：node（esm + dts）、client（cjs + ModuleLoader banner/footer/intro）、standalone（iife 无包装）；
- `alwaysBundle: [/^three(\/|$)/, /^@huaqiu\/kicad-sexpr-parser/]`（client 与 standalone 都自包含 three+parser；
  react 与 @deepseek-ai 保持外部）——检查这个规则是否覆盖了 `three/addons/*` 的子路径（regex 里的 `(\/|$)`）；
- package.json：版本 0.3.10（全仓同步）、exports（`.`/`./client`/`./cordis.patch.yml`/`./package.json`）、
  dsh.bundle.patch + dsh.client、peerDeps 是否与其他包一致；
- `cordis.patch.yml` 的 insert 条目格式对照其他包。

## 已产出的验证证据（可复跑）

| 证据 | 命令 | 期望 |
|---|---|---|
| adapter 对齐 | `pnpm test` | 9/9 通过 |
| strict 类型 | `pnpm typecheck` | 0 错误 |
| 构建 | `pnpm build` | 3 个产物，无 MISSING_GLOBAL_NAME |
| 运行时冒烟（client bundle） | 假 ModuleLoader 下 `apply`/`inject` 存在 | 已在移植时验证过一次 |
| 运行时冒烟（standalone） | 真 HTTP + 假板文本整页渲染 | 已在移植时验证过一次（2D+3D 双视图截图） |

## 审计产出建议

请按「严重 / 中 / 轻」分级给出发现，每条带 文件:行号 + 与 JS 原版的对照结论（行为等价 / 偏移 / 风险）。
特别标注：任何**数值、阈值、坐标变换**上的不一致都是严重级。

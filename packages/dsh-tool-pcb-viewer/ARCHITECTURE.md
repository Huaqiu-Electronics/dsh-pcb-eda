# 架构总览 — `@huaqiu/dsh-tool-pcb-viewer`（ts 分支）

> 一份把「这个插件怎么运转」讲全的文档：分层、数据流、关键设计决策、DSH 集成面、
> 渲染管线、性能模型、边界与验证方式。代码规模约 4.2k 行 TS。

## 1. 一句话定位

把 KiCad 的 `.kicad_pcb` 变成**会话内可交互的 2D 走线视图 + 3D 板卡渲染**的 DSH 插件。
**一个渲染内核，三处入口**：会话卡片（回合末尾）、大屏面板（右侧悬浮）、独立整页（新标签页）。

## 2. 分层与依赖方向

依赖是单向的，从下往上：

```
                    ┌─────────────── src/index.ts (302) ───────────────┐
   host 半边        │ pcb_preview 工具 · /pcb-viewer/* 路由 · 提示词段 │
                    └──────────────────────┬──────────────────────────┘
                                           │ 只依赖解析层
                    ┌──────────────────────▼──────────────────────────┐
   解析层           │ src/parse.ts (24)  ← 唯一入口，可切换引擎       │
                    │   ├── src/pcb/parseKicad.ts (286)  自带线性 parser│
                    │   └── src/adapter.ts (237)         备选引擎适配   │
                    └──────────────────────┬──────────────────────────┘
                                           │ 两条路都产出 ↓
   契约层           ┌──────────────────────▼──────────────────────────┐
                    │ src/model.ts (91)  BoardModel —— 全包唯一数据契约 │
                    └──────────────────────┬──────────────────────────┘
                                           │
   渲染层           ┌──────────────────────▼──────────────────────────┐
   （纯浏览器）      │ src/viewer.ts (556)  createViewer() 门面          │
                    │   ├── scene/buildBoard.ts (333)  叠层 + 拆解动画  │
                    │   ├── scene/components.ts (480)  器件模板库(19 类) │
                    │   ├── scene/textures.ts  (506)   程序化板面纹理   │
                    │   ├── scene/materials.ts (23)    PBR 材质         │
                    │   ├── scene/view2d.ts    (301)   2D 走线视图      │
                    │   └── pcb/outline.ts     (115)   板框几何(环+洞)  │
                    └──────────────────────┬──────────────────────────┘
                                           │ 被三处入口复用
   入口层           ┌──────────────────────▼──────────────────────────┐
   （浏览器）        │ client/index.ts (6)   打包入口                   │
                    │ client/panel.tsx (496) 会话卡片 + 单例大屏面板    │
                    │ client/standalone.ts(35) 独立整页                │
                    └─────────────────────────────────────────────────┘
```

**关键点：渲染层完全不认识 DSH。** 它只是一个 `createViewer(container, opts)` 的库，
所以能同时被"会话内面板"和"独立整页"复用，也能脱离 DSH 单测。

## 3. 数据流（一次预览的完整生命周期）

```
用户在会话里发路径
      │
      ▼
[host] pcb_preview.execute(path)
      │  ① 路径解析：绝对路径 or 相对会话 cwd（ctx.sessions.get(sid).header.cwd）
      │  ② 校验：后缀 .kicad_pcb + 存在 + 体积 ≤ 120MB
      │  ③ 解析：parseBoard(text) → BoardModel（Jetson 81MB 约 1.3s）
      │  ④ 统计：comps/pads/traces/zones/vias/layers/W×H
      │  ⑤ 登记：registry[randomUUID key] = 绝对路径（有界 32 条 FIFO）
      ▼
   工具返回两块文本：① 人话摘要（给模型/用户）② JSON 载荷（给浏览器解析）
      │
      ├──▶ [官方即时卡片] presentCall/presentResult：工具事件一到就渲染，不等回合结束
      │
      ▼
[client] 回合结束 → turnTail chain 槽位自选举 → 推卡片
      │  ① 观察器（常驻、渲染 null）扫会话快照，维护 回合号 → 预览 映射
      │  ② 卡片的 select(owner) 用 owner.turn.turn 查表 → 命中才挂载
      ▼
   卡片：3D 缩略图（轻量路径）+ 文件名 + 参数 + 三按钮
      │
      ├─「显示 PCB」/「显示 3D」→ 单例大屏面板（mode: 2d | 3d）
      └─「浏览器打开」→ /pcb-viewer/view?key=… → 独立整页（standalone bundle，split 布局）
                                     │
                                     ▼
                      两条路都 fetch /pcb-viewer/api/file?key=…
                      → createViewer(container, { board: text, mode, cacheKey })
                      → parseBoard（有缓存）→ buildBoard → 2D/3D 渲染
```

## 4. 关键设计决策（为什么长这样）

### 4.1 `BoardModel` 作为唯一契约

`src/model.ts` 定义了渲染层看到的全部数据（comps/pads/traces/zones/vias/texts/outline/bbox/cuLayers）。
好处：**解析引擎可以换，渲染层完全不用动**。当前有两个引擎产出同一个模型：

| 引擎 | 位置 | 默认 | 说明 |
|---|---|---|---|
| 自带 | `pcb/parseKicad.ts` | ✅ | 随板子规模近似线性 |
| 备选 | `adapter.ts` + `@huaqiu/kicad-sexpr-parser` | — | 保留可用、测试常跑 |

`test/parity.test.ts` 用 7 个 fixture 把两者钉在同一模型上（**逐字段严格相等，含拼接外框环**），
所以切换是一行的事（`src/parse.ts`），且不会静默漂移。

### 4.2 host / client 两半的职责切分

| 职责 | host (`index.ts`) | client (`panel.tsx`/`standalone.ts`) |
|---|---|---|
| 读文件、校验、解析、统计 | ✅ | — |
| 登记 key、发文件文本 | ✅（只读路由） | — |
| 图形渲染、交互、动画 | — | ✅ |
| 会话里怎么呈现 | 只给数据（工具结果 + 即时卡片） | ✅（槽位、卡片、面板） |

**为什么板子文本走路由而不是塞进工具结果**：板子可能上百 MB，工具结果是给模型看的，
塞进去会炸上下文。所以工具只回**统计 + 一个 key**，浏览器拿 key 去路由取原文。

### 4.3 会话呈现：观察器 + chain 槽位自选举

DSH 的 `conversation.chat.turnTail` 是 **chain 槽位**：每个注册项带一个纯 `select`，
按顺序尝试、**第一个返回非 null 的胜出**。

- 一个**常驻观察器**（挂 `conversation.session.header.actions`，渲染 null）扫会话快照，
  维护 `回合号 → 预览` 映射（模块级）
- 卡片注册在 turnTail，`select(owner)` 只做一次查表，**priority: -1**（该回合有预览时优先于
  官方"产出文件"行；没有预览就返回 null 让位）

这样卡片**只在该出现的那一轮**出现，且不悬浮遮挡正文（悬浮是早期踩过的坑）。

### 4.4 大板策略：预加载 + 轻渲染 + 三级缓存

| 机制 | 位置 | 作用 |
|---|---|---|
| 轻量渲染路径 | `viewer.ts` 的 `hud:false / post:false / interactive:false` | 缩略图只建几何、无后处理、不绑交互 |
| 大板降级 | `panel.tsx` 的 `THUMB_MAX_KB = 8MB` 阈值 | 超阈值走 `textures:false`（跳过全部 canvas 纹理） |
| 文本缓存 | `TEXT_CACHE_CAP = 250MB`（逐出最旧） | 卡片/面板/独立页之间共享板文本 |
| 解析缓存 | `viewer.ts` 的 `modelCache`（`MODEL_CACHE_CAP = 6`，按 `cacheKey`） | 切 2D/3D、开面板不重复解析 |

### 4.5 画质档位（运行时自适应）

```ts
high   { ssao: true,  bloom: true,  bokeh: true,  dpr: 2   }   // 器件 ≤ 450
medium { ssao: false, bloom: true,  bokeh: false, dpr: 1.5 }   // 450 < 器件 ≤ 900
low    { ssao: false, bloom: false, bokeh: false, dpr: 1   }   // 器件 > 900
```

`auto` 按器件数自动选档；HUD 上的 FPS 芯片实时显示帧率并点击循环切档。
三档都保留电影级调色 pass（只是砍最贵的 SSAO/DOF/Bloom）。

## 5. 渲染管线

### 5.1 3D（three.js）

1. **镜像**：`buildBoard` 入口先对整模型做 Y 轴镜像（KiCad +y 向下），使渲染朝向与 KiCad 一致
2. **叠层**：阻焊(2) + 铜(每层) + FR4 芯(层数-1)，按 1.6mm 归一化分配厚度
3. **板形**：`outlineParts()` → 主环（`THREE.Shape`）+ 洞（`shape.holes`，圆形挖槽）
4. **纹理**：`makeBoardTextures()` 程序化生成（焊盘/走线/铜皮/丝印/过孔），
   `px=(x-x0)*S` 映射；内层用**半分辨率**（夹在叠层里几乎看不见）
5. **器件**：`components.ts` 19 类参数化模板（WROOM/继电器/USB-C/IC/QFN/阻容…），
   **按尺寸自适应细分**（<1.5mm 直角盒、<4mm 1 段圆角、其余 3 段）
6. **后处理**：SSAO → Bloom → DOF → 调色，按画质档位逐 pass 开关
7. **动画**：`update(u, speed)` 按拆解度分层展开 + 器件抬升 + 过孔淡出（staggered）

### 5.2 2D（canvas 2D，KiCad 编辑器风格）

- 按层着色的走线/铜皮 + 金色焊盘 + 过孔 + 丝印 + 位号 + 板框描边
- **批量化**：走线/铜皮/焊盘/过孔各合并进 `Path2D` 桶，一次 `stroke`/`fill`（原来每条走线一次调用）
- **离屏缓存**：整板渲染一次进离屏画布，**平移只做一次 `drawImage`**（10 步平移实测 1ms）
- 缩放级别变化才重画；`setBoard` 时强制失效（防同尺寸换板残留）

### 5.3 板框几何（`pcb/outline.ts`）

```
Edge.Cuts 段（line/arc/rect/circle）
   ├─ 非圆段 → 弧线展平 → 贪心链按最近端点缝合 → 绕向归一化（恒 CCW）
   └─ 圆     → 独立子路径（48 边形采样）
产物 OutlineParts { ring, holes }
   · 环 + 圆     → 圆是「洞」
   · 只有圆      → 最大圆就是板体（不再退化成 bbox 矩形）
   · 无圆        → holes=[]，ring 与历史行为逐点一致
```
三个消费者：纹理裁剪（canvas `evenodd`）、3D 挤出（`shape.holes`）、2D 视图（挖空填充）。

## 6. DSH 集成面（契约清单）

| 类型 | 名称 | 说明 |
|---|---|---|
| 工具 | `pcb_preview` | `defineTool`：参数 `{ path }`；`output.render` 回两块文本 |
| 即时卡片 | `presentCall` / `presentResult` | 工具事件到达即渲染（标题 + 参数行） |
| 服务 | `inject = ['tools','systemPrompt','webServer','sessions']` | host 依赖 |
| 提示词段 | `systemPrompt.section({ name:'tool:pcb_preview', order:107 })` | 何时调用 |
| 路由 | `/pcb-viewer/api/file?key=` | 只读板文本（localhost Host/Origin 守卫） |
| 路由 | `/pcb-viewer/view` · `/pcb-viewer/standalone.js` | 独立整页 + 自包含 bundle（rev 按 mtime） |
| 槽位 | `conversation.session.header.actions` | 观察器（渲染 null，维护回合索引） |
| 槽位 | `conversation.chat.turnTail` | 卡片（chain 槽位，`select` 自选举，priority −1） |
| 打包 | `dsh.bundle.patch` + `dsh.client` | cordis.patch.yml + client-only 注入 |
| 导出 | `.` / `./client` / `./cordis.patch.yml` / `./package.json` | exports 映射 |

## 7. 性能模型（实测）

| 项 | 数字 |
|---|---|
| 解析 81MB / 10 层板 | **~1.3s**（自带 parser）；工具端到端 ~1.8s |
| 几何顶点 | 自适应细分后 **54.6 万**（原 512 万） |
| 纹理 | 内层半分辨率（像素 1/4） |
| 2D 平移 | 10 步 **1ms**（离屏缓存） |
| 画质档位（软渲染） | high 3.6 / medium 6.0 / low 7.2 FPS（真 GPU 成比例更高） |
| 传输（loopback） | 84.8MB / **0.13s** |

## 8. 边界与限制

- 单文件上限 120MB（`maxFileBytes`）；key registry 有界 32 条 FIFO（超出逐出最旧）
- 圆形板框/挖槽已支持；**非圆内环、嵌套洞**未支持（`FOLLOWUPS.md` F1 遗留）
- 传输仍是整份文本（已规划服务端只传精简几何，见 `PLAN-TRANSPORT.md`）
- 权限：路由仅信任 localhost Host/Origin；registry 不按会话隔离（key 不可枚举已缓解）

## 9. 验证方式（这个包怎么被证明是对的）

| 手段 | 内容 |
|---|---|
| 单元/契约测试 | 56 例（adapter 对齐、双引擎 parity、outline 圆形/回归） |
| **红→绿证据** | 每次修 bug 都先把代码回退证明断言会红，再证明修好变绿 |
| **逐像素回归** | 关键改动前后用 git worktree 双份构建，对真实板 2D 画布做 SHA-256 对比 |
| 独立审计 | 移植过程由第三方审计：`AUDIT.md → AUDIT-FINDINGS.md → AUDIT-RESPONSE.md → AUDIT-VERIFICATION.md`（14/14 属实） |
| 门禁 | `pnpm typecheck`（strict 0 错误）· `pnpm test` · `pnpm build`（3 产物） |

# @huaqiu/dsh-tool-pcb-viewer

KiCad `.kicad_pcb` → 会话内嵌的 **2D 走线视图 + 3D 板卡渲染** DSH 插件。

在 DSH 会话里给出板子路径，模型调用 `pcb_preview` 工具：

1. **工具调用瞬间** → 官方即时信息卡（标题 + 参数行：`180×100mm · 10 层 · 1125 器件 · 22151 走线`）
2. **该回合结束** → 回合末尾推送可交互卡片：实时 **3D 缩略图** + 文件名 + 参数 + 三个按钮
   - 「显示 PCB」→ 右侧大屏只看 2D 走线视图（可拖拽平移 · 滚轮缩放）
   - 「显示 3D」→ 只看 3D 渲染（可轨道旋转 · 滑杆拆解 · AUTO DEMO）
   - 「浏览器打开」→ 新标签页整页（左板子 + 右 3D，可分享）
3. 大板（>8MB）走**预加载 + 轻渲染**：卡片出现即后台拉数据，缩略图先出无纹理轻量 3D，
   点开详情时解析结果已缓存

## 解析引擎

`src/parse.ts` 是唯一解析入口，两条引擎产出同一个 `BoardModel`：

| 引擎 | 位置 | 说明 |
|---|---|---|
| **自带（默认）** | `src/pcb/parseKicad.ts` | 随板子规模保持线性；多 MB 大板上有明显优势 |
| 备选 | `src/adapter.ts` + `@huaqiu/kicad-sexpr-parser` | 保留可用、测试常跑；适合板子规模较大时不一定适用，实测大板上明显更慢 |

选择理由：本插件要应对十 MB 级真实板，解析必须随规模近似线性。
`test/parity.test.ts` 用 7 个 fixture 把两条路钉在**同一个模型**上（逐字段严格相等，含拼接外框环），
所以这个选择是**可逆的**——需要时改 `src/parse.ts` 一行即可切换。

## 性能要点

| 项 | 做法 |
|---|---|
| 器件几何 | 按尺寸自适应细分（<1.5mm 直角盒 / <4mm 1 段圆角 / 其余 3 段）：Jetson 512 万顶点 → **54.6 万** |
| 画质档位 | `high / medium / low`（SSAO/Bloom/DOF 逐 pass 开关 + 像素比），按器件数自动选；HUD 实时 FPS 芯片可点击循环切档 |
| 2D 视图 | 走线/铜皮/焊盘/过孔批量成 `Path2D`；整板渲染进**离屏缓存**，平移只做一次 `drawImage`（10 步平移 1ms） |
| 内层纹理 | 内层夹在叠层里几乎不可见 → **半分辨率**（像素 1/4） |
| 解析缓存 | 卡片缩略图 ↔ 大屏面板 ↔ 2D/3D 切换**共享一次解析** |
| 缩略图 | `hud:false / post:false / interactive:false` 轻量路径，只建几何 |

## 安装与开发

```bash
pnpm install
pnpm build        # tsdown → lib/index.mjs（host）+ lib/client.js + lib/standalone.js
pnpm test         # vitest：adapter 对齐 + 双引擎 parity（38 例）
pnpm typecheck    # strict tsc
```

登记进 DSH profile（`~/.dsh/profiles/<name>/package.json`）：依赖加
`"@huaqiu/dsh-tool-pcb-viewer": "link:<本包绝对路径>"`，`dsh.profile.bundles` 加包名，
然后 `pnpm install` → **重启 DSH** → 刷新浏览器。

## 架构

```
src/
├── model.ts          # 扁平板模型（BoardModel）——全包契约
├── parse.ts          # 唯一解析入口（默认自带 parser，一行可切上游）
├── adapter.ts        # 上游 parser（I_KicadPCB）→ BoardModel
├── viewer.ts         # createViewer()：split/2d/3d + 画质档位 + FPS HUD + 轻量模式
├── index.ts          # host：pcb_preview 工具 + /pcb-viewer/* 路由 + 即时卡片
├── pcb/              # parseKicad（线性解析）+ outline（板框缝合 + 绕向归一化）
├── scene/            # 纹理 / 器件模板库 / 叠层组装 / 2D 视图
└── client/           # 会话卡片 + 单例大屏面板 + 独立整页
```

审计与后续文档：`AUDIT.md`（任务单）→ `AUDIT-FINDINGS.md`（发现）→ `AUDIT-RESPONSE.md`（修复响应）
→ `AUDIT-VERIFICATION.md`（独立复核 14/14 属实）→ `FOLLOWUPS.md`（遗留）→ `MILESTONE.md`（阶段范围与验收）。

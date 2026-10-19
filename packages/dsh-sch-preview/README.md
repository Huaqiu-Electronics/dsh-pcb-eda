# dsh-sch-preview — DSH 原理图预览插件（@huaqiu/dsh-sch-preview）

基于 vendored **kicanview**（ECAD Viewer 的 schematic 渲染引擎，位于 `vendor/kicadpreview/`）的
**DSH 插件**：在**无头模式**（headless Chromium，不弹任何窗口）下渲染 KiCad 原理图 `.kicad_sch`，
把**截图 + 结构化内容**（图纸列表、BOM）传回 DSH agent 上下文。

```
agent 调用 sch_preview 工具
   → 插件 node 半（本包 lib/index.js）
      → Playwright 启动无头 Chromium（bundled chromium → chrome → msedge 自动回退）
         → 环回 HTTP 服务 vendor/kicadpreview/dist（kicadpreview ESM bundle）
            → 页面加载 .kicad_sch 内容 → SchematicViewer 渲染 → fitScreen
      → 截取画布 PNG + 收集 sheets/BOM
   → 工具结果 = 文本信封（sheets/capturedSheet/bom/savedTo）+ 图片块（attachment store）
```

## 目录结构

本包位于 dsh-pcb-eda monorepo 的 `packages/` 下（与 `dsh-tool-*` 等同级），由仓库根 pnpm
workspace（`packages/*`）统一管理依赖：

```
packages/dsh-sch-preview/
  package.json              dsh.bundle.patch 声明 + files（含包内 vendor）+ peerDependencies
  cordis.patch.yml          bundle patch：insert 工具条目（id: dsh-sch-preview）
  src/index.ts              插件 node 半：注册 sch_preview 工具
  src/render/renderer.ts    无头渲染器（Playwright + 环回静态服务 + 截图/内容收集）
  src/cli.ts                独立 CLI（不依赖 DSH，直接出图）
  lib/                      tsc 构建产物（gitignore，不入库）
  vendor/kicadpreview/      vendored kicanview dist + design_blocks 样例（随包发布；
                            仓库根 .gitignore 对本目录的 dist/ 有定向豁免）
  test/                     smoke、多图纸回归夹具（fixtures/multi-sheet）、像素级验证脚本（verify/）
```

## 构建

```sh
pnpm install                                     # 仓库根（playwright + peers，auto-install-peers=true）
pnpm --filter @huaqiu/dsh-sch-preview run build  # tsc → lib/
```

`@deepseek-ai/*` 以 **peerDependencies + semver** 声明（对齐 `@huaqiu/dsh-tool-*`
的发布形态），由 DSH 宿主环境在运行时提供解析上下文。

## 发布（registry / tarball）

包已按可发布形态组织：`files` 含 `lib/`、`cordis.patch.yml` 和**包内 vendor**
（`vendor/kicadpreview/dist/**`，排除 `.map`；`design_blocks` 样例保留）。
`defaultVendorDir()` 优先解析包内副本，回退到旧 workspace 根布局。

```sh
# 本包内
pnpm --filter @huaqiu/dsh-sch-preview run build
npm publish                 # 公共 npm（或 publishConfig.registry 指向私有 registry）

# 目标机器：一条命令安装并自动 reconcile dsh.profile.bundles
dsh plugin --profile web add @huaqiu/dsh-sch-preview
# 重启 dsh web
```

不走 registry 也可以：`pnpm pack` 出 tarball → 目标机
`dsh plugin --profile web add ./huaqiu-dsh-sch-preview-0.1.0.tgz`。
DSH 加载器按标准 node_modules 查找解析 bundle（registry 包与 link: 包等价），
安装后声明了 `dsh.bundle.patch` 的依赖自动进层栈，无需手改 profile。

已验证：干净目录模拟 profile（hoisted linker + autoInstallPeers:false）装 tarball
后，从 node_modules 安装位置直接渲染成功（确定性输出 + 像素级取景校验）；
宿主提供 @deepseek-ai/* 时 `lib/index.js` 工具模块完整加载。

## 独立 CLI（无需 DSH）

```sh
node packages/dsh-sch-preview/lib/cli.js <file.kicad_sch | dir> [更多文件...] \
    [--sheet 文件名] [--width 1600] [--height 1000] \
    [--out .sch-preview-out] [--channel chrome] [--json]
```

输出 PNG 到 out 目录，并打印 JSON（sheets、capturedSheet、BOM 摘要）。
浏览器按 bundled chromium → `chrome` → `msedge` 顺序自动回退。

## 挂载到 DSH web profile

与 `@huaqiu/dsh-tool-*` 相同的模式——profile 的 package.json 声明依赖并列入
`dsh.profile.bundles`（或直接用 `dsh plugin --profile <name> add`，自动 reconcile），
插件包内的 `dsh.bundle.patch` 把工具条目插入层栈：

1. profile 的 package.json（本机 web profile 示例，link 到本 monorepo）
   - dependencies: `"@huaqiu/dsh-sch-preview": "link:E://dsh-pcb-eda//packages//dsh-sch-preview"`
   - `dsh.profile.bundles`: 含 `"@huaqiu/dsh-sch-preview"`
2. `cd <profile 目录> && pnpm install`
3. **重启 dsh web**（工具注册发生在启动时，热更新不生效）

验证组合：`pnpm dsh web --dump-config`（在 DSH checkout 下）应出现：

```yaml
# == @huaqiu/dsh-sch-preview
- id: dsh-sch-preview
  name: '@huaqiu/dsh-sch-preview'
  inject: [tools]
```

profile 侧配置覆盖（如 `attachImage`）在 profile 的 cordis.patch.yml 里按条目 id
`dsh-sch-preview` 声明。备用方式（不改 profile）：`pnpm dsh web --patch <本包>/cordis.patch.yml`。

## 工具 API（模型侧）

`sch_preview`：

| 参数 | 说明 |
|---|---|
| `file_path`（必填） | `.kicad_sch/.kicad_pro` 文件或包含设计文件的目录；相对路径按会话工作目录解析 |
| `sheet` | 捕获指定图纸（文件名），默认第一页 |
| `width` / `height` | 视口 CSS px（默认 1600×1000） |
| `save_dir` | PNG 落盘目录（默认 `<cwd>/.sch-preview-out`） |

返回：文本信封（sheets / capturedSheet / bom / savedTo）+ 图片块
（部署挂载 attachment store 且支持 image/png 时；否则仅文本 + 磁盘路径）。

### 插件配置（cordis `config`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `vendorDir` | 包内 `vendor/kicadpreview`（见 `defaultVendorDir`） | kicadpreview dist 目录；发布布局下解析自安装位置，本地开发可回退 workspace 根 |
| `browserChannel` / `executablePath` | 自动回退 | bundled chromium → chrome → msedge |
| `timeoutMs` | 90000 | 单次渲染预算（ms） |
| `defaultWidth` / `defaultHeight` | 1600 / 1000 | 视口 CSS px |
| `attachImage` | true | **模型不支持图像输入时设 false**：结果只含文本信封 + savedTo 路径（PNG 照常落盘）。本部署已在 `C:\Users\ws\.dsh\profiles\web\cordis.patch.yml` 中设为 false（当前模型不接受 image 块）；换用图像模型后改回 true 并重启 |

## 已知限制

- 每次调用启动一次无头浏览器（约 1–3s），不适合高频并发；工具默认独占执行。
- vendored bundle 跟随拷贝时的分支：当前 vendor 来自 ecad-viewer **main**（经典彩色主题）；
  要支持 dark 主题需从 `feat/theme` 分支重新构建并替换 vendor/dist。
- 渲染页固定使用 SchematicViewer（PCB/3D 视图未接入，可按 renderer.ts 模式扩展）。

## 截图取景（fitWithPaper）

kicanvas 的 `zoom_fit_top_item`（即 `fitScreen`）只按**内容包围盒**适配相机。
当设计内容超出纸张范围（例如内容比 A4 更大、或远离原点）时，图框/标题栏会被
裁出截图之外。`renderer.ts` 的渲染页因此改为：等待内部 fit 真正落到相机后
（`kicanvas:sheet:loaded` 事件先于 fit 触发，需轮询相机 bbox），再通过
**setter** `camera.bbox = {...}`（getter 返回副本，直接改无效）把相机范围扩展为
「内容 ∪ 纸张 [0..W]×[0..H]」，保证整张图纸（含图框）完整入镜。
AD 转换文件（`is_converted_from_ad`）不画图框，跳过纸张合并以免多出空白边距。

## 多图纸（hierarchical sheets）

kicanview 的 `page.filename` 对每一页都是通用的 `"schematic"`，真正的每页身份在
`sheet_path`（文件名字段）。插件因此把信封里的 sheets 列表与 `sheet` 参数匹配键
都改用 `sheet_path ?? filename`：目录加载多图纸工程时，sheets 显示各真实文件名
（如 `sub1.kicad_sch`），`--sheet sub1.kicad_sch` 可切换到对应页再截图
（`switchPage` → `file_by_name` 按文件名解析）。回归样例见
`test/fixtures/multi-sheet/`（root + 2 子页，各含特征标记）；像素级验证脚本见
`test/verify/`（verify-items / ink-bbox / check-wires / debug-bbox）。


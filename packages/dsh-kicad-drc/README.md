# dsh-kicad-drc

DeepSeek Harness (DSH) 插件：为 AI agent 注册 `kicad_drc_run` 工具，对 `.kicad_pcb` 文件执行 KiCad DRC（设计规则检查）并返回结构化结果；Web GUI 中还会在对话轮次尾部渲染**分页报告卡片**。

## 功能

- 一次工具调用执行 `kicad-cli pcb drc --format json`，返回：
  - `drcSummary` — 错误/警告/排除数量、按类型分类计数、前 5 条示例错误、已忽略检查项
  - `drcJsonPath` — 完整报告持久化在 PCB 文件同目录（`<pcb名>_drc.json`），可直接读取
  - `drcJson` — 原始 JSON，**默认不回传**（可能数百 KB），传 `includeFullJson=true` 才包含
- 两种执行模式：
  - **local** — 本地 subprocess 直接调 kicad-cli；可执行文件多级自动探测（插件配置 → `KICAD_CLI_PATH`/`KICAD_PATH` 环境变量 → PATH → Windows 注册表 → 常见安装目录扫描 → PowerShell 全盘浅层搜索）
  - **remote**（默认）— PCB 文件 multipart 上传到 pcblint-java 服务，由其转发 cli-runner 执行；本机无需安装 KiCad
- HTTP 瞬时失败自动重试一次（网络错误 / 5xx；超时中止不重试）
- kicad-cli 懒解析：本机没装 KiCad 不会拖垮插件启动，首次调用工具时才探测并返回结构化错误

## 工具：kicad_drc_run

| 参数 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `pcbPath` | string | ✅ | `.kicad_pcb` 文件绝对路径（必须存在于本机文件系统） |
| `severityAll` | boolean | – | 报告所有严重级别，默认 true |
| `refillZones` | boolean | – | DRC 前重绘填充区，默认 true |
| `allTrackErrors` | boolean | – | 报告所有走线错误，默认 false |
| `includeFullJson` | boolean | – | 输出中包含 drc.json 原始 JSON（可能很大），默认 false |
| `timeoutSeconds` | number | – | 超时秒数，默认 600 |

输出字段：`success`、`exitCode`、`timedOut`、`elapsedMs`、`stdout`、`stderr`、`kicadCliPath`、`command`，以及可选的 `drcJsonPath` / `drcSummary` / `drcJson` / `viewUrl`（未生成报告时省略）。

> **`success` 语义**：表示 DRC 运行是否正常完成（KiCad 10 实测：有无违规退出码都是 0），**不代表板子没有违规**——有无违规请判断 `drcSummary.totalIssues`。

## Web GUI 报告卡片

DRC 成功生成报告后，工具输出会附带一个 `viewUrl`（形如 `/drc-report/api/report?key=…`）。Web GUI 的浏览器半边（`lib/client.js`，经 `exports["./client"]` + `dsh.client` 声明加载）会：

1. 遍历会话树，把每轮 `kicad_drc_run` 成功的结果索引到对应 turn；
2. 在该轮对话尾部渲染一张报告卡片：错误/警告计数、级别筛选（全部 / 错误 / 警告）、**分页表格**（每页 10 行：序号 / 级别 / 类型 / 描述 / 坐标）；
3. 表格数据经 `viewUrl` 从 host 端 `/drc-report` 路由拉取（仅信任 localhost 来源），报告全文不进会话上下文。

兼容 KiCad 旧版（按检查类型分顶层数组）与 KiCad 10（统一 `violations` 数组，坐标在 `items[0].pos`）两种报告格式。headless / 无 webServer 环境下自动降级：不注册路由、输出省略 `viewUrl`，工具功能不受影响。

## 插件配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `executorMode` | `remote` | `local` 或 `remote` |
| `kicadCliPath` | `''` | local 模式：kicad-cli 绝对路径，留空自动探测 |
| `pcblintBaseUrl` | `http://47.100.4.100:8080` | remote 模式：pcblint-java 服务地址 |
| `cliRunnerWorkDirRoot` | `/data/kicad/drc` | remote 模式：cli-runner 工作目录根（共享磁盘） |
| `fileBaseUrl` | `http://www.fdatasheets.com` | 静态文件服务器域名；配置后通过 HTTP 下载 drc.json，**显式设为空字符串**则从共享磁盘直读（同机/同 PV 部署） |
| `defaultTimeoutSeconds` | `600` | DRC 默认超时秒数 |

## 开发

```bash
pnpm install        # 安装依赖
pnpm run typecheck  # 类型检查（tsc --noEmit，含 src/client React 代码）
pnpm test           # 单元测试（node:test，零额外依赖；31 用例）
pnpm run build      # tsdown 双入口编译 → lib/index.js（host ESM）+ lib/client.js（浏览器 CJS factory）
pnpm pack           # 打包 tgz（prepack 自动触发 build）
```

client bundle 是 `window.__ModuleLoader__.load({id, factory})` 包装的 CJS（与 `@huaqiu/dsh-tool-pcb-viewer` 同机制）；`react` / `react/jsx-runtime` 不打进 bundle，运行时从 DSH 模块表 require。

安装 / 更新 / 卸载到 DSH 的完整步骤与踩坑记录见 [BUILD_GUIDE.md](./BUILD_GUIDE.md)。

## 已知限制

- `--refill-zones` 已在 KiCad 10.0 实测**不会写回原 .kicad_pcb 文件**（仅内存重绘用于检查），但其他版本行为未逐一验证
- remote 模式的工作目录 `/data/kicad/drc/<jobId>` 插件不主动清理（服务端职责）
- pcblint-java 接口目前无鉴权，公网暴露时务必在服务端加访问控制；其 `command` 参数由客户端拼接，服务端应做命令白名单校验
- 并发对同一块 PCB 跑 DRC 会互相覆盖 `<pcb名>_drc.json`
- kicad-cli 的 stdout 按 UTF-8 解码，中文 Windows 下摘要行可能乱码（不影响 JSON 报告）
- dsh-tools 的类型声明引用了未声明为依赖的 `@deepseek-ai/dsh-llm` 等包，pnpm 布局下部分类型退化为 `any`（靠 `skipLibCheck` 掩盖）；工具名因此用本仓库的 `TOOL_NAME` 常量而非 `tool.name`

## License

MIT

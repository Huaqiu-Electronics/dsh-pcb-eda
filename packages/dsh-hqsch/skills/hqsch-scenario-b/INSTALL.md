# 安装说明 — HQ EDA Scenario B Skill

自包含 skill 包：内含全部文档 + System Prompt，无需 monorepo、无需运行组装脚本。

## 包内文件

| 文件 | 用途 |
| --- | --- |
| `SKILL.md` | Agent Skills 标准入口 |
| `SYSTEM-PROMPT.md` | System Prompt 正文（权威来源） |
| `AGENTS.md` | Codex CLI / 项目根指令（与 SYSTEM-PROMPT 相同） |
| `CLAUDE.md` | Claude / Work Buddy UI 粘贴用（与 SYSTEM-PROMPT 相同） |
| `docs/` | LLM 知识库（工程规范 + 常用 RPC） |
| `template/` | 本地脚本工程 + 连通性测试 |

**没有组装脚本。** 本目录（`packages/dsh-hqsch/skills/hqsch-scenario-b/`）就是权威来源，
`docs/` 与 `template/` 直接在此维护；`@huaqiu/dsh-hqsch` 在加载时通过
`ctx.skills.register` 把整个目录注册为 DSH 内建 skill（`resourceBase = <本目录>`）。

```

`build:scenario-b` 会从 monorepo 拷贝 guides + RPC 文档（含 **set-page-size / place-rect / place-text** 等模块化 RPC）、`modular-placement` 长文，再合并 `onboarding/scenario-b/docs/`（含 **modular-layout**、**layout-quality-audit**）与 `onboarding/scenario-b/template/`（含 `modular-lib.ts`、`layout-audit.ts`）。

同步到 DSH 插件：

```bash
cd skills/hqeda && pnpm run build:scenario-b:dsh
```

目标目录：`dsh-pcb-eda/packages/dsh-hqsch/skills/hqsch-scenario-b/`（SKILL 名改为 `hqsch-scenario-b`）。

---

## 环境前提

| 项 | 要求 |
| --- | --- |
| HQ EDA | 桌面版已安装并运行；目标原理图工程已打开 |
| Node.js | ≥ 18 |
| npm | 可访问**公网 npm**（安装 `@huaqiu/huaqiu-client`） |
| 推荐版本 | `@huaqiu/huaqiu-client` ^0.1.7；可选 `@huaqiu/hqeda` ^0.2.7 |
| 多开编辑器 | 设置环境变量 `HQ_INSTANCE_ID`（见 hello.ts 输出） |

Skill 包**不包含** HQ EDA 软件本身。

---

## 一、Work Buddy / Codex（推荐）

适用于编码 Agent **自动在终端执行脚本**的场景。

### 1. 解压

将 zip 解压到项目根，例如：

```
my-project/
├── AGENTS.md          ← 从本包复制或合并
├── hqsch-scenario-b/  ← 或解压内容直接放在根目录
│   ├── docs/
│   ├── template/
│   └── ...
```

### 2. 配置 System Prompt

| 平台 | 操作 |
| --- | --- |
| **Codex CLI** | 将 `AGENTS.md`（或 `SYSTEM-PROMPT.md`）复制到**项目根** `AGENTS.md` |
| **Work Buddy** | 将 `CLAUDE.md` 或 `SYSTEM-PROMPT.md` **全文粘贴**到平台 System Prompt；若支持项目文件，也可使用根目录 `AGENTS.md` |

确保 Agent 能读取 `docs/`（放在工作区仓库内即可，无需上传）。

### 3. 安装依赖并冒烟测试

```bash
cd template    # 或你的 hqsch-scenario-b/template
npm install
npx tsx scripts/hello.ts
```

输出应包含 `connected:`、`active project:`、`OK — ready`。

### 4. 使用

在 Agent 对话中描述电路需求。Agent 会：

1. 读取 `docs/` 中的规范
2. 在 `template/scripts/` 生成 TypeScript
3. **自动执行** `npx tsx scripts/xxx.ts` 并汇报结果

---

## 二、Claude Desktop（Projects）

1. Project Knowledge → 上传 `docs/` 下所有 `.md`（含 `docs/rpc/`）
2. Custom Instructions → 粘贴 `CLAUDE.md` 全文
3. 本机完成第三节环境准备

---

## 三、用户本机运行环境

```bash
cd template
npm install
npm install @huaqiu/huaqiu-client   # package.json 已声明时可省略
npx tsx scripts/hello.ts
```

多开 HQ EDA：

```bash
# Windows
set HQ_INSTANCE_ID=你的instanceId

# macOS / Linux
export HQ_INSTANCE_ID=你的instanceId
```

---

## 四、skills.sh / Agent Skills 宿主

```bash
npx skills add <git-url> --path hqeda/scenario-b
```

宿主加载 `SKILL.md`；仍将 `AGENTS.md` / `CLAUDE.md` 设为 system instructions（若宿主支持分离配置）。

---

## 五、分发给他人

将整个 `hqsch-scenario-b/` 打成 `hqsch-scenario-b.zip`：

```
hqsch-scenario-b.zip
├── SKILL.md
├── SYSTEM-PROMPT.md
├── AGENTS.md          ← Codex 项目根
├── CLAUDE.md          ← Work Buddy / Claude UI
├── INSTALL.md
├── docs/
│   └── script-lifetime.md   ← 进程生命周期（必读）
└── template/
    └── scripts/lib/hq.ts    ← 所有脚本的运行时外壳（必用）
```

附一句：**「解压 → 配置 AGENTS.md 或粘贴 CLAUDE.md → 跑 template/hello.ts → 开始描述电路」**

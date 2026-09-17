# 小阶段版本（milestone）— TS 版预览插件

> 分支：`ts`（云效 + 个人 GitHub 已推，`379e6bf` 起）。工作副本：`~/projects/dsh-pcb-eda`。
> 本文件定义这一阶段的**范围与验收**，之后按 ① 的流程小心推送。

## 范围

| # | 事项 | 状态 |
|---|---|---|
| — | JS 版整体 TS 化进 monorepo（`packages/dsh-tool-pcb-viewer`） | ✅ 完成并独立复核（14/14） |
| — | 解析引擎：默认自带线性 parser，备选保留且 parity 常跑 | ✅ 完成 |
| — | 会话卡片 + 大屏面板 + 独立整页 + 画质档位 + 性能优化 | ✅ 完成 |
| **④** | **F1：圆形板框 / 圆形挖槽渲染** | ⏳ **交 Claude 做**（任务单 `TASK-F1-CIRCULAR-OUTLINE.md`） |
| ~~②~~ | ~~上游 parser 相关动作~~ | ❌ **取消**（不打 patch、也不出报告——不评论别人维护的包） |
| ③ | 传输优化 | 📋 仅规划（`PLAN-TRANSPORT.md`），不在本阶段实现 |
| ① | 推公司仓库 / 开 MR | ⏳ 本阶段收尾时**小心推** |

## 本阶段验收（④ 完成后）

1. `pnpm typecheck` 0 错误 · `pnpm test` 全绿（新增圆形板框断言）· `pnpm build` 3 产物
2. ④ 的**红→绿证据**：把 `outline.ts` 回退 → 新断言红；修好 → 绿
3. 真实板回归：CM5 / stickhub / esp_mcb / jetson 渲染与修复前一致（这些板无 Edge.Cuts 圆）
4. 新增 fixture 渲染正确：纯圆板 = 圆盘（非 bbox 矩形）、矩形板带圆挖槽 = 有洞
5. 本机 DSH 实测：发大板路径 → 工具 1~2s 返回、卡片正常、三按钮可用

## ① 小心推送流程（等本阶段验收通过后再执行）

**推送前检查（缺一不可）**

```bash
cd ~/projects/dsh-pcb-eda
git status --short                      # 必须干净
pnpm -r typecheck 2>&1 | tail -5        # 确认没弄坏其他包
cd packages/dsh-tool-pcb-viewer
pnpm typecheck && pnpm test && pnpm build
git log --oneline origin/main..HEAD     # 复核将推送的提交清单
git diff --stat origin/main...HEAD      # 只应有本包新增文件 + pnpm-lock.yaml
```
- ⚠️ **确认没有把别人的包改动带上去**（diff 里不应出现其他 `packages/*` 的源码改动）
- ⚠️ **确认没有提交构建产物**（`lib/` 已被 .gitignore 忽略；`git status` 干净即满足）
- ⚠️ **确认没有提交探针/临时文件**（`__*.mjs`、`test/__tmp/` 等）

**推送**

```bash
git push origin feat/pcb-3d-viewer          # 公司 GitHub（Huaqiu-Electronics/dsh-pcb-eda）
git push yunxiao feat/pcb-3d-viewer:ts
git push mine    feat/pcb-3d-viewer:ts
```

**开 MR（对公司仓库）**

- 源：`feat/pcb-3d-viewer` → 目标：`main`
- 标题：`feat: add @huaqiu/dsh-tool-pcb-viewer — KiCad PCB 2D+3D preview DSH plugin (TS)`
- 描述要点：一句功能；解析引擎决策（自带为默认、备选保留、parity 保证可逆）；审计链（AUDIT → FINDINGS →
  RESPONSE → VERIFICATION 14/14）；测试 38 例；性能实测；**不含**任何其他包的改动；未发布 npm
- 评审关注点：① 是否接受"自带 parser 为默认、上游为可切换备选"；② 后续项优先级（PLAN-TRANSPORT / FOLLOWUPS）

## 不在本阶段

- npm 发布（等 MR 通过）
- 传输优化（③）、非圆内环与多级洞（F1 遗留）、registry 会话隔离（F4）

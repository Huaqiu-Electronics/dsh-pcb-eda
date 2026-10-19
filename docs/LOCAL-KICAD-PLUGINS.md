# 本地 KiCad 插件迁移

两个私有插件从 D:/kicad/plugins/packages 复制到本仓库 packages/，保留 @local 包名；不参与 npm 发布。旧源码目录保留，实际安装链接切换到新目录。

- dsh-plugin-manager：管理器统一扫描本仓库 packages，以单一列表管理所有 DSH 插件；普通辅助库不显示。选择保存在当前 profile/kicad-plugin-state.json，旧 builtin-state.json 停用选择迁入；更新保留开关。
- dsh-tool-kicad-schematic-gen：保留 12 个工具、设计 skill、builder.js 和概览卡片。skill 的编程示例指向新目录。历史概览快照复制到新包 .overview-cache；不要提交缓存或开关状态。

```powershell
cd D:/kicad/dsh-pcb-eda
pnpm --filter @local/dsh-plugin-manager --filter @local/dsh-tool-kicad-schematic-gen build
pnpm --filter @local/dsh-plugin-manager --filter @local/dsh-tool-kicad-schematic-gen typecheck
node packages/dsh-plugin-manager/scripts/test-local-kicad-plugins.mjs
pnpm check:local-kicad-plugins
```

全仓库 pnpm build/typecheck/test 会包含这两个包。update-bundled-plugins:kicad 自动发现它们，并同时更新其他华秋插件；本次迁移只重新注册这两个包，没有运行全量更新。

## KiCad 启动时的本地覆盖兼容

`scripts/update-bundled-plugins-kicad.mjs` 已内置开关保存和宿主兼容逻辑，不依赖
根 scripts 下的额外维护脚本。当前仓库没有
HQ Edge 宿主源码，因此它对安装目录 `bin/hq-edge-server.cjs` 应用一个带代码位置
检查的补丁，并保留 `.before-local-overrides` 备份。未知版本会停止。
升级宿主后重新运行更新脚本会检查并重新应用兼容补丁。

宿主只对 profile 里显式 `link:` 注册、且包名、主入口、bundle patch 均有效的
内置插件采用本地覆盖。覆盖插件由 profile 单独加载，宿主 overlay 不再重复插入，
但仍给启用的账号插件传入宿主地址配置。关闭的覆盖插件不会被内置 overlay
重新启用；没有显式本地覆盖的插件仍使用原有内置加载方式。
安装结束检查本地链接登记和入口/patch 文件，不再只提示未经检查的安装完成。

```powershell
node --test packages/dsh-plugin-manager/test/local-overrides.test.mjs
pnpm update-bundled-plugins:kicad
```

更新后重启 KiCad，不使用“重置智能体”。重置会把整个用户数据目录移到备份目录，
丢失当前插件注册、开关及其他配置。

旧项目脚本中已经写死旧 builder 路径的导入仍可工作，因为旧目录保留。后续新设计使用新 skill 中的路径。重启 KiCad 并开启新会话后加载迁移后的技能和前端。

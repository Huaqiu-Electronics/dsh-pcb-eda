# @huaqiu/dsh-huaqiu-about

An installable DSH Web profile plugin that contributes an **About** row to the
DSH settings page, following the reference prototype
(`dsh-pcb-eda/reference.html`): the HuaQiu brand mark, the platform slogan, a
`DSH 运行时 0.1.0` runtime badge, a metadata box (Distribution version, plugin
type, copy-metadata action, `deepseek-harness` link), and the copyright /
attribution lines. All text lines are localised (`zh` / `en`).

## Install

```powershell
dsh plugin --profile web add file:C:/Downloads/huaqiu-dsh-huaqiu-about-<version>.tgz
```

Restart the Web profile after installing. Remove it with:

```powershell
dsh plugin --profile web remove @huaqiu/dsh-huaqiu-about
```

## What it renders

The row registers into the `settings.section` slot (the same mechanism the
community `dsh-market` plugin uses for its settings page) and shows, per the
prototype:

```
[HuaQiu brand mark]
{电子设计智能体平台 / Electronic Design Agent Platform}
[DSH 运行时 0.1.0]                      ← runtime label + this plugin's version
┌─────────────────────────────────────┐
│ 发行版本       0.1.5-rc.2            │ ← Distribution label + bundled DSH version
│ 插件类型       DSH Standalone Plugin │
│ 复制元数据     deepseek-harness ↗    │
└─────────────────────────────────────┘
© 2026 深圳华秋智联股份有限公司
由 DSH 提供支持
```

The runtime version is this plugin's declared version; the Distribution
version is the DSH version bundled with the running harness.

## Implementation

The package is a dual-half plugin:

- **Node half** (`src/index.ts`) mounts a same-origin version route on
  `ctx.webServer` (`GET /api/v1/huaqiu/about` → `{ version, dshVersion }`) —
  the same browser→node channel `@huaqiu/dsh-auth` uses for its credential
  routes. `version` is this plugin's own declared version, read from the
  package manifest next to the entry (`../package.json` relative to
  `import.meta.url`); `dshVersion` is resolved the same way the community
  `dsh-market` plugin resolves the host version (walking up from the CLI entry
  for `node_modules/@deepseek-ai/dsh/package.json`, also recognising a
  workspace checkout whose own `package.json` carries the `@deepseek-ai/dsh`
  name, then a `require.resolve` probe, then environment fallbacks).
- **Browser half** (`src/client/index.ts`) registers the settings section and
  fetches the two versions from the node route when the About row renders. It
  does not depend on cross-end `ctx.provide`/`ctx.get` service sync (which is
  unavailable within a single plugin's two halves).

When a version is unreachable, its slot is simply left empty; everything else
always renders.

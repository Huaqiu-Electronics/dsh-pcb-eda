# @huaqiu/dsh-huaqiu-about

An installable DSH Web profile plugin that contributes an **About** row to the
DSH settings page, showing the original DSH fish mark, the DSH version bundled
with the running harness, and the "Powered by DSH" claim.

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
community `dsh-market` plugin uses for its settings page) and shows:

- the original DSH mark (`FishLogo` from `@deepseek-ai/dsh-client-ui-primitives`);
- the DSH version bundled with the running harness;
- the claim text "Powered by DSH".

## Implementation

The package is a dual-half plugin:

- **Node half** (`src/index.ts`) mounts a same-origin version route on
  `ctx.webServer` (`GET /api/v1/huaqiu/about` → `{ version }`) — the same
  browser→node channel `@huaqiu/dsh-auth` uses for its credential routes.
  The version is resolved the same way the community `dsh-market` plugin
  resolves the host version: walking up from the CLI entry for
  `node_modules/@deepseek-ai/dsh/package.json` (also recognising a workspace
  checkout whose own `package.json` carries the `@deepseek-ai/dsh` name), then
  a `require.resolve` probe, then environment fallbacks
  (`DSH_CLIENT_VERSION` / `DSH_VERSION`).
- **Browser half** (`src/client/index.ts`) registers the settings section and
  fetches the version from the node route when the About row renders. It does
  not depend on cross-end `ctx.provide`/`ctx.get` service sync (which is
  unavailable within a single plugin's two halves).

When no DSH installation is locatable, the version line is simply omitted; the
mark and the claim always render.

# @huaqiu/hardware-engineering

The Huaqiu Hardware Engineering **product bundle** for DeepSeek Harness.

It is not a plugin. It is the package a DSH profile selects so that the eleven
Huaqiu plugins ship with the installation and activate on first launch, offline,
without HQ Edge.

```jsonc
// $DSH_HOME/profiles/<profile>/package.json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@huaqiu/hardware-engineering"
      ]
    }
  }
}
```

## What it owns

| Concern | Where |
|---|---|
| Product-level composition and activation order | `cordis.patch.yml` |
| The machine-readable copy of that composition | `src/index.ts` (`HARDWARE_ENGINEERING_PLUGINS`) |
| Exact plugin versions tested together | `package.json` `dependencies` |
| The DSH runtime compatibility gate | `package.json` `engines.dsh` |

Everything else — tools, services, client halves, host capability boundaries —
belongs to the individual plugin packages. This package must never import them.

## Why one row per plugin lives here

DSH resolves a loader row's module name from the runtime resolution table, which
is built by walking the **installation** dependency graph: `apps/cli` →
`@huaqiu/hardware-engineering` → this package's `dependencies`. That is why the
plugins are reachable from the installation anchor with no profile-local install
and no network access at boot.

Declaring a dependency installs a package. It does not activate it. The patch is
what inserts the rows.

## Row order

Row order carries no load semantics in DSH: activation is service-availability
driven, so a consumer waits in `pending` until its provider provides the service.
Providers are nevertheless written first so the file reads in dependency order.

The edges that matter:

- `huaqiu-tool-symbol-footprint` → `huaqiuAuth`, `huaqiuArtifacts`, `webServer`
- `huaqiu-eda-selection` → `systemPrompt`
- all capability rows → `tools` / `skills` / `fs` / `webServer`

## Deliberately excluded

| Package | Why |
|---|---|
| `@huaqiu/dsh-eda-host` | Its 11 tools read an HQ Edge HTTP bridge that does not exist in the target runtime. |
| `@huaqiu/dsh-tool-plugin-update` | Update discovery/install is HQ Edge-owned business logic with no DSH-native equivalent. |
| `@huaqiu/dsh-hqsch` | Teaches TypeScript against HQ EDA; outside this product's workflow. |
| `@huaqiu/dsh-analytics` | Telemetry; not required to prove the product. |

## Verification

```bash
pnpm --filter @huaqiu/hardware-engineering test    # patch ↔ ledger contract
pnpm --filter @huaqiu/hardware-engineering build
pnpm pack --filter @huaqiu/hardware-engineering    # then inspect the tarball
```

The contract test does not prove activation. That needs a real DSH boot; see
`M1-hardware-engineering-poc-report.md`.

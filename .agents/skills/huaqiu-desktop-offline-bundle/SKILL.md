---
name: huaqiu-desktop-offline-bundle
description: Bundle the @huaqiu hardware-engineering product bundle into a DSH Desktop build from local .tgz artifacts instead of npm. Use when the product packages cannot be published (unreleased or private code, air-gapped build host, pre-release validation) or when a Desktop installer must not fetch @huaqiu/* from a registry. Covers packing the dsh-pcb-eda workspace closure, pinning local file overrides and the desktop package set, rebuilding the runtime closure, and verifying the eleven bundle rows.
---

# Offline Huaqiu bundle for DSH Desktop

Two repositories are involved and both must agree:

- `C:\code\dsh-pcb-eda` — source of the `@huaqiu/*` product packages (workspace).
- `C:\code\deepseek-harness` — Desktop shell, package-set builder, runtime materializer.

The default (and current) distribution path resolves the bundle from npm: `apps/cli/package.json` pins `@huaqiu/hardware-engineering`, `prepare-package-set.ts` packs only shell-owned packages, and `prepare-dsh.ts` installs the closure with `pnpm --prod --frozen-lockfile`. This skill replaces that one leg with local tarballs; everything else (branding, `cordis.patch.yml`, profile template, gates) stays identical.

Read `references/pitfalls.md` before changing anything — every failure mode below has already cost a full rebuild cycle at least once.

## Prerequisites

```powershell
$HARNESS = 'C:\code\deepseek-harness'
$PRODUCT = 'C:\code\dsh-pcb-eda'
$PNPM    = 'C:\node\node.exe C:\code\deepseek-harness\node_modules\pnpm\bin\pnpm.mjs'
```

- Node x64 at a space-free path (`C:\node\node.exe`), pnpm ≥ 10, `git` and `powershell.exe` on `PATH` (the Windows packer shells out to both).
- The product workspace must build: `pnpm --dir $PRODUCT build` (or at least the 16 bundle packages) before packing.
- Never publish to npm for this flow, and never commit `product/`.

## Step 1 — pack the product closure

```powershell
& "$PRODUCT\.agents\skills\huaqiu-desktop-offline-bundle\scripts\pack-product-packages.ps1" `
  -Repo $PRODUCT -OutDir "$HARNESS\product\huaqiu" -DryRun     # inspect the closure first
& "$PRODUCT\.agents\skills\huaqiu-desktop-offline-bundle\scripts\pack-product-packages.ps1" `
  -Repo $PRODUCT -OutDir "$HARNESS\product\huaqiu" -Install
```

`-Install` runs `pnpm install --frozen-lockfile` in the product workspace when its dependency links are missing; without it the script aborts up front with that instruction. `pnpm pack` rewrites `workspace:*` by reading the **installed** graph, so a fresh clone fails on the bundle package after every other tarball was already written.

The closure is computed from `@huaqiu/hardware-engineering` through `dependencies`/`peerDependencies`/`optionalDependencies`, intersected with the workspace, so a version bump needs no edit here. Expect **16** workspace packages for the current bundle. `pnpm pack` runs each package's `prepack`, so tarballs carry fresh `lib/`.

Output: `<Harness>\product\huaqiu\*.tgz` plus `ledger.json` (`name`, `version`, `file`, `bytes`, `sha256`). The ledger is the contract for the rest of this procedure — read filenames from it, never reconstruct them by hand (`@huaqiu/dsh-auth` packs as `huaqiu-dsh-auth-<version>.tgz`).

Sanity-check one tarball before wiring:

```powershell
tar -tzf "$HARNESS\product\huaqiu\huaqiu-hardware-engineering-0.7.11.tgz" | Select-String 'cordis.patch.yml|package/package.json'
```

## Step 2 — point the harness workspace at the tarballs

```powershell
& "$PRODUCT\.agents\skills\huaqiu-desktop-offline-bundle\scripts\wire-local-bundle.ps1" -HarnessRepo $HARNESS -Check
& "$PRODUCT\.agents\skills\huaqiu-desktop-offline-bundle\scripts\wire-local-bundle.ps1" -HarnessRepo $HARNESS
```

This writes one `overrides:` block into `pnpm-workspace.yaml`, delimited by `# >>> local-huaqiu-bundle` / `# <<< local-huaqiu-bundle`, mapping each ledger package to `file:./product/huaqiu/<file>.tgz`. It backs the file up to `pnpm-workspace.yaml.bak` and preserves the pre-existing `yauzl`/`cosmokit`/`schemastery` overrides. Re-running is idempotent.

Then, by hand:

1. `pnpm-workspace.yaml` `packages:` globs must not match `product/**` (the tarballs are artifacts, not workspace members).
2. `apps/cli/package.json` must declare **exactly** the ledger versions:

```json
"@huaqiu/component-gen-app": "0.7.11",
"@huaqiu/hardware-engineering": "0.7.11"
```

`component-gen-app` is a `peerDependency` of `dsh-tool-symbol-footprint`; pnpm does not install peers into the hoisted runtime tree, so it must be an explicit dependency or the runtime closure silently loses it.

3. `apps/desktop/scripts/prepare-package-set.ts`: add the product directory to `defaultInputs`, reusing the `REPOSITORY_ROOT` constant already imported there:

```ts
const defaultInputs = [
  buildPaths.packedDsh,
  buildPaths.packedVendor,
  buildPaths.packedLandlock,
  resolve(REPOSITORY_ROOT, 'product', 'huaqiu'),
]
```

Keep `product/huaqiu` in the same `*.tgz`-flat layout: `prepareDesktopPackageSet` reads every `*.tgz` in each input directory, extracts `package/package.json`, distinguishes workspace members from external packages by the `packages` globs, and walks the closure from `ROOT_PACKAGES`. A package that is packed but unreachable is ignored; a required package that is absent throws `desktop package set: packed inputs omit required package <name>`.

If you prefer not to edit `defaultInputs`, pass every directory at build time — `--from` **replaces** the defaults, it does not append:

```powershell
& $PNPM --dir $HARNESS --filter @deepseek-ai/dsh-desktop exec tsx scripts/prepare-package-set.ts `
  --from 'apps/desktop/.desktop-build/targets/win-x64/packed/dsh' `
  --from 'apps/desktop/.desktop-build/targets/win-x64/packed/vendor' `
  --from 'apps/desktop/.desktop-build/targets/win-x64/packed/landlock' `
  --from 'product/huaqiu'
```

## Step 3 — re-resolve the harness lockfile

pnpm will not re-resolve an existing `@huaqiu/*` entry (from `link:` or registry) into a `file:` spec, and neither `--force` nor `--fix-lockfile` helps. Use the removal-first order:

```powershell
# 1. temporarily drop the two product dependencies from apps/cli/package.json
& $PNPM --dir $HARNESS install --lockfile-only
# 2. restore both dependency lines at the ledger version
& $PNPM --dir $HARNESS install
```

Verify the root tree now resolves the bundle from disk:

```powershell
(Get-Content "$HARNESS\pnpm-lock.yaml" -Raw) | Select-String "hardware-engineering"
# expect a `file:product/huaqiu/...tgz` resolution, not a registry integrity line
```

## Step 4 — refresh the packed CLI tarball

The runtime closure is built from `apps/desktop/.desktop-build/targets/win-x64/packed/dsh/*.tgz`, produced by `pack-local-packages.ts` — **not** by `prepare:packages`. Editing `apps/cli/package.json` without repacking leaves a tarball whose manifest still lacks the bundle, and the closure drops from 16 `@huaqiu` packages to 15 (or 0) with no error.

```powershell
& $PNPM --dir $HARNESS exec tsx apps/desktop/scripts/pack-local-packages.ts `
  --out apps/desktop/.desktop-build/targets/win-x64/packed/dsh
```

Check the tarball timestamp changed and its manifest lists the bundle:

```powershell
tar -xOzf "$HARNESS\apps\desktop\.desktop-build\targets\win-x64\packed\dsh\deepseek-ai-dsh-0.2.2-rc.1.tgz" package/package.json |
  Select-String '@huaqiu'
```

## Step 5 — materialize the runtime

```powershell
$env:DSH_DESKTOP_TARGET_PLATFORM='win32'; $env:DSH_DESKTOP_TARGET_ARCH='x64'
& $PNPM --dir "$HARNESS\apps\desktop" run prepare:packages
& $PNPM --dir "$HARNESS\apps\desktop" run prepare:dsh -- --defer-runtime-smoke
```

`prepare:dsh` copies the package set into a scratch project whose dependencies and `overrides` are all `file:./desktop-packages/<file>.tgz`, then runs `pnpm install --lockfile-only`, `verifyDesktopCoreLockfile`, and `pnpm install --prod --frozen-lockfile --trust-lockfile`. A `file:` closure means no registry is touched for `@huaqiu/*` at install time.

`--defer-runtime-smoke` is mandatory on hosts without ConPTY (see pitfalls); a smoke failure deletes `targets/win-x64/dsh` outright.

## Step 6 — verify before packaging

```powershell
# package set carries the product
$ledger = Get-Content "$HARNESS\product\huaqiu\ledger.json" -Raw | ConvertFrom-Json
$set = Get-Content "$HARNESS\apps\desktop\.desktop-build\targets\win-x64\package-set\desktop-packages.json" -Raw | ConvertFrom-Json
($set.packages | Where-Object name -like '@huaqiu/*').Count            # expect 16
# every selected record must match the ledger byte-for-byte source
foreach ($record in $ledger.packages) {
  $hit = $set.packages | Where-Object name -eq $record.name
  if (-not $hit -or $hit.file -ne $record.file -or $hit.bytes -ne $record.bytes) { "MISMATCH $($record.name)" }
}

# installed runtime carries the product
Get-ChildItem "$HARNESS\apps\desktop\.desktop-build\targets\win-x64\dsh\node_modules\@huaqiu" -Directory | Measure-Object   # expect 16

# profile activates the eleven rows
$home = Join-Path $env:TEMP 'hq-offline-probe'
$env:DSH_HOME = $home
node "$HARNESS\apps\desktop\.desktop-build\targets\win-x64\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile probe --dump-config > "$env:TEMP\hq-offline-dump.yml"
Select-String -Path "$env:TEMP\hq-offline-dump.yml" -Pattern "@huaqiu/" | Measure-Object   # expect 11
Select-String -Path "$env:TEMP\hq-offline-dump.yml" -Pattern "hqEdge"                       # expect 0
```

`--profile desktop --dump-config` is refused by the CLI ("managed exclusively by the Electron application"); always probe with a throwaway profile.

## Step 7 — build the installer

```powershell
& $PNPM --dir $HARNESS run build
Set-Location "$HARNESS\apps\desktop"
Get-Content .env.windows | ForEach-Object { if ($_ -match '^([^#=]+)=(.*)$') { Set-Item "env:$($matches[1])" $matches[2] } }
$env:DSH_DESKTOP_UNSIGNED='1'
& $PNPM exec electron-builder --config electron-builder.config.mjs --win --x64
```

`electron-builder` is a dev dependency of `apps\desktop` (not the repo root), so run it from that directory or `--dir` into it. `--win` alone fails with `Unknown argument: win` — always `--win --x64`.

Before shipping, run the static gate and read its failures carefully:

```powershell
& $PNPM --dir $HARNESS run verify-huaqiu-desktop-distribution
```

The gate currently encodes the **registry** contract: checks that assert "no `file:`/`link:` artifact remains" and "exact registry integrity in the lockfile" fail by design in this mode. Treat bundle-row, patch-row, profile-template, sandbox-default and branding checks as authoritative; classify the local-artifact checks as expected-fail and record them in the build report. Do not silently pass the build by deleting those checks — if the offline path is meant to become permanent, invert the assertion instead.

## Step 8 — return to the registry path

```powershell
# 1. drop the two product dependency lines from apps/cli/package.json by hand, then
& $PNPM --dir $HARNESS install --lockfile-only
# 2. re-add them at the registry version and install
& $PNPM --dir $HARNESS install
# 3. refresh the packed CLI tarball so the closure picks the new manifest
& $PNPM --dir $HARNESS exec tsx apps/desktop/scripts/pack-local-packages.ts `
  --out apps/desktop/.desktop-build/targets/win-x64/packed/dsh
```

Then delete the marker block from `pnpm-workspace.yaml` (or restore the `.bak`), remove `product/huaqiu`, revert the `defaultInputs` entry, and re-run `prepare:packages` + `prepare:dsh`. Confirm 0 `file:` references remain:

```powershell
Select-String -Path "$HARNESS\pnpm-workspace.yaml", "$HARNESS\apps\cli\package.json" -Pattern 'product/huaqiu|file:'
```

## Report honestly

State which leg was used, the ledger (bytes + SHA-256 per tarball), the package-set and runtime `@huaqiu` counts, the probe dump path, the installer size and hash, and the expected-fail gate list. A local-tarball build is not a published release: say so explicitly.

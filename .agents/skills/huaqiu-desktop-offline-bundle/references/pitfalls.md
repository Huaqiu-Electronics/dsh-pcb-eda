# Offline bundle pitfalls

Each entry: symptom → cause → fix. All were hit on a real Windows x64 build.

## 1. `pack` aborts on `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`

Symptom: the first N packages pack fine, then `Cannot resolve workspace protocol of dependency "@huaqiu/dsh-hardware-ui" because this dependency is not installed`.

Cause: `pnpm pack` rewrites `workspace:*` to concrete versions by reading the **installed** workspace graph. A cloned-but-not-installed tree has no links, so the bundle package (the one with the most workspace deps) fails last, leaving a partial tarball set.

Fix: install first, then repack — never reuse the partial output.

```powershell
C:\node\node.exe <harness>\node_modules\pnpm\bin\pnpm.mjs --dir C:\code\dsh-pcb-eda install --frozen-lockfile
```

## 2. `'pnpm' is not recognized` inside `pnpm pack`

Symptom: the pack command itself runs, then dies in the package's `prepack` (`$ pnpm build`).

Cause: npm lifecycle hooks spawn `cmd.exe`, which resolves `pnpm` from `PATH` — not from the node process you launched `pnpm.mjs` with. Hitting `node .../pnpm.mjs` directly does not put `pnpm` on `PATH`.

Fix: materialize a `pnpm.cmd` shim (`"<node>" "<pnpm.mjs>" %*`) on a directory you prepend to `PATH`; `pack-product-packages.ps1` does this automatically.

## 3. `Cannot find module 'C:\...\C'`

Symptom: node reports a module path of a single character.

Cause: `@splatting` a bare string enumerates its characters, so a prefix array that collapsed to one string became `C`, `:`, `\`, ….

Fix: cast the splat target to `[string[]]`. Guarded in the script; worth remembering for any wrapper that builds argv from a command string.

## 4. Overrides written but the closure still comes from npm

Symptom: `desktop-packages.json` lists `@huaqiu/*` with `spec: 0.7.x` and `integrity` instead of `file:./desktop-packages/...`, or the runtime tree has an empty `node_modules/@huaqiu`.

Cause A: the `apps/cli` version disagrees with the tarball version — the closure walker cannot match the spec, quietly resolving a registry package.
Cause B: the lockfile still holds the old resolution.

Fix: pin `apps/cli` to the ledger version exactly, then run the removal-first lockfile order:

1. delete the two `@huaqiu/*` dependency lines from `apps/cli/package.json`
2. `pnpm install --lockfile-only`
3. re-add both lines at the ledger version
4. `pnpm install`

`pnpm install` alone will reuse the stale entry; `--force`, `--fix-lockfile` and manual `--lockfile-only` mid-way do not break it either.

## 5. Closure loses packages after editing `apps/cli/package.json`

Symptom: 16 `@huaqiu` packages expected, 15 (or fewer) installed; no error anywhere.

Cause: the runtime closure is built from `apps/desktop/.desktop-build/targets/win-x64/packed/dsh/*.tgz`. That tarball is produced by `pack-local-packages.ts` during `package-target.ts`, **not** by `prepare:packages`. A stale CLI tarball still carries the pre-edit manifest.

Fix: repack the CLI tarball after every `apps/cli/package.json` change, then re-run `prepare:packages` + `prepare:dsh`:

```powershell
pnpm exec tsx apps/desktop/scripts/pack-local-packages.ts --out apps/desktop/.desktop-build/targets/win-x64/packed/dsh
```

Confirm the tarball mtime and the `@huaqiu` lines inside `package/package.json`.

## 6. Invoking `prepare-package-set.ts` with `--from` drops the shell's own packages

Symptom: `desktop package set: packed inputs omit required package @deepseek-ai/...`.

Cause: `--from` replaces `defaultInputs`; it does not append.

Fix: pass all four directories (`packed/dsh`, `packed/vendor`, `packed/landlock`, `product/huaqiu`), or edit `defaultInputs` once.

## 7. Peer dependency never reaches the runtime

Symptom: `@huaqiu/dsh-tool-symbol-footprint` activates but its generation UI is missing; `node_modules/@huaqiu` has 15 entries.

Cause: `@huaqiu/component-gen-app` is only a `peerDependency`. The runtime tree is hoisted (no `.pnpm` linker), so peers are not installed implicitly.

Fix: declare it explicitly in `apps/cli/package.json` at the ledger version. A gate check (`product-peer-closure`) exists for the registry mode; in offline mode verify the count by hand.

## 8. Runtime smoke deletes the prepared tree

Symptom: `Cannot launch conpty`, then `targets/win-x64/dsh` disappears.

Cause: ConPTY is unavailable in this environment and `prepare-dsh.ts` removes the output root on smoke failure.

Fix: `prepare:dsh -- --defer-runtime-smoke`, then build with `electron-builder` by hand (Step 7 of the skill) — and say so in the report. Do not interpret the smoke failure as a closure problem: prebuilds for `node-pty` are present.

## 9. Windows packaging aborts before it starts

| Symptom | Fix |
| --- | --- |
| `spawnSync git ENOENT` | add `C:\Program Files\Git\cmd` to `PATH` |
| `spawn powershell.exe ENOENT` (NSIS) | add `C:\Windows\System32\WindowsPowerShell\v1.0` |
| Node path with spaces breaks scripts | junction at `C:\node`, call `C:\node\node.exe ...\pnpm\bin\pnpm.mjs` |
| `Unknown argument: win` | use `--win --x64` |
| `electron-builder` not found at repo root | it lives in `apps/desktop/node_modules` |

## 10. The static gate fails on legitimate offline artifacts

Symptom: `verify-huaqiu-desktop-distribution` reports failures about `file:` / `link:` overrides and missing registry integrity in the lockfile.

Cause: the gate encodes the current **registry** contract on purpose (it also guards against leftovers from the earlier local-tarball phase).

Fix: treat row/profile/sandbox/branding checks as authoritative, list the local-artifact checks as expected-fail in the report, and invert the assertion if offline distribution becomes a supported mode. Never delete the checks to make a build pass.

## 11. Probing the packaged profile

`dsh --profile desktop --dump-config` is refused ("managed exclusively by the Electron application"). Create a throwaway profile with its own `DSH_HOME` and dump that instead; the eleven bundle rows and the absence of `hqEdge` are the useful signals.

## 12. Repo hygiene

- `product/huaqiu/` is build output: never commit it, never add it to `packages:` globs, never publish these tarballs.
- Keep `ledger.json` — it is the only record of what shipped (bytes + SHA-256).
- The `# >>> local-huaqiu-bundle` block must be removed (or restored from `pnpm-workspace.yaml.bak`) when switching back to registry consumption; a half-reverted tree resolves some `@huaqiu` packages locally and others from npm, which produces brand-new failure modes.
- `pnpm pack` implies `prepack` → `build`, so packing rewrites each package's `lib/` and, for the UI packages, `dist/`. That is intended (the tarball must ship built code), but it dirties the product working tree: build outputs stay untracked, and a pack started from a stale tree ships a stale build. Pack from a freshly built tree, or re-run `pnpm pack` after any source change.

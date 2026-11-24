---
name: dsh-product-bundle-integration
description: Integrate a new or changed Huaqiu plugin into the DSH product bundle on the dsh-pcb-eda master branch, and understand why the harness `desktop` branch is a release branch rather than an integration target. Use when adding a package under packages/, adding/removing/reordering a row in packages/hardware-engineering/cordis.patch.yml, wiring a bundle dependency, fixing "entry did not activate"/duplicate row id at boot, or deciding where a product change belongs (master vs desktop).
agent_created: true
---

# Product bundle integration (master integrates, desktop releases)

How the Huaqiu DSH product is composed, and where a change belongs. The short
version: **`dsh-pcb-eda` master is the integration mainline; the harness
`desktop` branch is a release branch that only pins an already-published
version.** No product feature work happens on `desktop`.

## Topology

```
dsh-pcb-eda (master)                       npm                       deepseek-harness (desktop)
  packages/<plugin>/                       @huaqiu/dsh-*             apps/cli/package.json
    src/index.ts     (node half)  build    @huaqiu/hardware-    ──►     "@huaqiu/hardware-
    src/client/      (browser half) ───►    engineering x.y.z               engineering": "x.y.z"
    cordis.patch.yml                       (the release unit)       offline bundle + verifiers
  packages/hardware-engineering/
    cordis.patch.yml (the rows)
    src/index.ts     (the ledger)
```

- `dsh-pcb-eda` master: plugin code + **the composition** (which rows mount, in
  what order, with what injects). This is where features, tests and UI changes land.
- npm: the release unit. All product packages move to one version together
  (`scripts/bump.mjs`), because the tool packages peer-depend on auth/artifacts.
- harness `desktop`: holds only what a shipped build needs — the pinned
  `@huaqiu/hardware-engineering` dependency in `apps/cli`, the offline bundle
  scripts, and the activation/distribution verifiers. `master` in the harness has
  no `@huaqiu/*` dependency at all.

Consequence: **a product change never requires a harness checkout.** You can add a
plugin, a tool, or a whole navigation surface without touching `deepseek-harness`
master, and you only look at `desktop` when cutting a release.

## Invariants

1. **One bundle owns composition.** A profile selects
   `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@huaqiu/hardware-engineering']`
   and nothing else Huaqiu.
2. **Dependencies install, patches activate.** Listing a package in
   `packages/hardware-engineering/package.json` makes it resolvable from the
   installation anchor. It does **not** mount it; the `insert:` row does.
3. **Row ids are globally unique per profile.** A plugin's own
   `cordis.patch.yml` and the bundle patch must use the *same* id, so a
   double-mount surfaces as an id collision instead of two live copies.
4. **Rows never inject `hqEdge`.** That service exists only inside an HQ Edge
   runtime; a row waiting on it leaves boot in `pending` and aborts activation.
5. **The bundle never imports plugin code.** It is composition + a version
   ledger, nothing else.

## Add a plugin

1. **Scaffold** `packages/<name>/`: `src/index.ts` (cordis plugin: `name`,
   `inject`, `apply`), `tsdown.config.ts`, `test/`, `cordis.patch.yml`,
   `package.json` with
   `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` and
   `exports` for `.`, `./cordis.patch.yml`, `./package.json` (plus `./client`
   when there is a browser half).
2. **Dual-face packages** also need
   `"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-slots"] } }`
   and a `tsdown` client entry that emits `lib/client.js`. The node row's
   `inject` must list every service the node half actually waits on
   (`webServer`, `tools`, `skills`, `fs`, …).
3. **Register the row in three places** — they are a contract, not duplicates:
   - `packages/hardware-engineering/cordis.patch.yml` → `insert:` entry
   - `packages/hardware-engineering/src/index.ts` → `HARDWARE_ENGINEERING_PLUGINS`
   - `packages/hardware-engineering/package.json` → `dependencies: { "@huaqiu/…": "workspace:*" }`
4. **Run the contract test** — it parses the patch and compares it to the ledger:
   `pnpm --filter @huaqiu/hardware-engineering test`.
5. **Boot the web profile** (see the `dsh-web-profile-dev-loop` skill) and check
   the log for `pending` / `did not activate` / duplicate ids.
6. **Gate + release**: `pnpm -r typecheck && pnpm -r test`,
   `node scripts/check-publish.mjs`, then `scripts/bump.mjs` → commit → tag.

## Failure modes, and what they actually mean

| Symptom at boot | Cause | Fix |
|---|---|---|
| `duplicate entry id` / two live copies | the plugin is linked in the profile *and* mounted by the bundle | remove the profile-local `@huaqiu/*` dependency; the bundle is the only mount point |
| `N entries did not activate`, one row `pending` | row `inject`s a service nobody provides (`hqEdge`, a renamed provider) | drop the inject or ship the provider |
| Plugin installed but no tools/cards appear | dependency declared, `insert:` row missing | add the row (this is the deps-vs-activation mistake) |
| Patch test fails on order or count | patch and `HARDWARE_ENGINEERING_PLUGINS` drifted | edit both in the same commit |
| Works locally, missing in the shipped app | package absent from the desktop branch pin, or not in `files[]` | release step: republish, bump the pin on `desktop` |
| Boot resolves an old build | `link:` points at the checkout but `lib/` is stale | rebuild that package (the launcher's default `product` mode does three of them) |

## Where to look

- Composition + rationale: `packages/hardware-engineering/cordis.patch.yml` header
  and `packages/hardware-engineering/README.md`.
- Contract test: `packages/hardware-engineering/test/bundle.test.ts`.
- Why not-in-bundle packages stay out: the "deliberately NOT here" block in the patch.
- Release machinery: `README.md` § Releasing, `scripts/check-publish.mjs`,
  `release-manifest/`.

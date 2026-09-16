# dsh-ui-theme-huaqiu — why the sidebar icon stays dsh after migration

## Symptom

After migrating `@huaqiu/dsh-ui-theme-huaqiu` into
`dsh-pcb-eda/packages/dsh-ui-theme-huaqiu` (integrated from npm), only the
**slogan** and **theme color** take effect. The **sidebar brand icon** is still
the stock dsh mark (fish/whale from `ui-brand-official`), not the HuaQiu mark.

## What the plugin actually does (3 independent channels)

`src/client/index.ts` (identical in original and migrated copy):

| Channel | Mechanism | Survives normalization? |
|---|---|---|
| Slogan | DOM hack in `installLegacyHeroBranding` | ✅ (lives in `lib/`) |
| Theme color | `ctx.theme.overrideTokens(...)` | ✅ (lives in `lib/`) |
| Sidebar icon | `ctx.slots.inject("sidebar.brand.mark", ...)` into the `sidebar.brand.mark` slot | ⚠️ needs `ui-brand-official` disabled |

The sidebar (`@deepseek-ai/dsh-client-ui-sidebar`) renders
`renderSlot("sidebar.brand.mark", { size: 24 }, { fallback: <FishLogo/> })`. The
stock `ui-brand-official` plugin **also** fills that same slot. As long as
`ui-brand-official` is active it keeps painting the dsh mark, so our mark is
shadowed.

Disabling it is the job of the plugin's `cordis.patch.yml`:

```yaml
- id: ui-brand-official
  disabled: true            # <-- THE directive that makes our mark win

- insert:
    - id: ui-theme-huaqiu
      name: '@huaqiu/dsh-ui-theme-huaqiu'
```

## Root cause (confirmed)

The `@huaqiu/*` packages are bundled by `hq-edge`'s supervisor, which
**regenerates a single overlay** from each package's `cordis.patch.yml` at
startup (`apps/server/src/dsh/supervisor.ts` → `ensureHQBuiltinPlugins`). Two
facts combine to drop the `disabled` directive:

1. **The per-package `cordis.patch.yml` is intentionally NOT copied into the
   normalized bundle** (supervisor comment at `supervisor.ts:79`: *"we do NOT
   copy the package's patch file into the bundle"*). The generated
   `overlay.yml` is the only thing DSH loads.
2. **The overlay generator ignores `disabled:` entries.**
   `readPluginPatchEntry()` (was `supervisor.ts:183-234`) only parsed the first
   `insert` entry's `id`/`inject`; it never looked at the top-level
   `disabled: true` op. `buildHqPluginOverlay()` (was `supervisor.ts:330-357`)
   emitted only a single `- insert:` block. So `disabled: ui-brand-official`
   evaporated during normalization.

### Evidence

- Normalized bundle
  `/Users/admin/.hq-edge/1.8.8/dsh-home/hq/builtin-plugins/0.1.3-11-gbe07241/dsh-ui-theme-huaqiu/`
  has **no `cordis.patch.yml`** (only `lib/` + `package.json`) — by design.
- Its `../overlay.yml` contains `- id: "ui-theme-huaqiu"` but **no**
  `- id: "ui-brand-official" / disabled: true`. → stock mark survives.
- The npm-installed source
  `/Users/admin/code/hq-edge/dist/edge-headless/dsh-plugins/@huaqiu/dsh-ui-theme-huaqiu/cordis.patch.yml`
  **does** carry the `disabled` directive — proving the package is correct and
  the loss happens at normalization, not at publish.

**Conclusion:** our migrated package's `cordis.patch.yml` is already
byte-identical to the original/npm one. Nothing in the package needed changing
for the icon. The defect is in the **host** (`hq-edge` supervisor) dropping the
`disabled` directive during bundle normalization.

## Fix (applied in `hq-edge`)

File: `hq-edge/apps/server/src/dsh/supervisor.ts`

- `readPluginPatchEntry()` now returns `PluginPatchContract { id?, inject?, disabled? }`
  and captures top-level `disabled: true` ops (attributed to their `- id:`).
- `ensureHQBuiltinPlugins` collects every package's `disabled` ids into
  `disabledIds` while scanning siblings.
- `buildHqPluginOverlay(plugins, disabledIds)` now emits, **before** the
  `- insert:` block, one entry per disabled id:
  ```yaml
  - id: "ui-brand-official"
    disabled: true
  ```
- `tsc --noEmit` on `apps/server` passes.

After this, the regenerated overlay disables `ui-brand-official`, so our
`sidebar.brand.mark` slot wins and the HuaQiu icon renders — matching the
original npm behavior.

## Manual verification (user)

1. Rebuild hq-edge so the new supervisor ships (`apps/server` → `tsc`/build).
2. The running `1.8.8` bundle already has a stale `overlay.yml` (no disabled
   op). Either restart hq-edge (the fast-path re-compares overlay content and
   will regenerate since `desiredOverlay` now differs) **or** delete the stale
   normalized bundle dir
   `/Users/admin/.hq-edge/1.8.8/dsh-home/hq/builtin-plugins/0.1.3-11-gbe07241/`
   to force a clean re-materialize.
3. Confirm the generated `overlay.yml` now contains:
   ```yaml
   - id: "ui-brand-official"
     disabled: true
   - insert:
       ...
       - id: "ui-theme-huaqiu"
         name: "@huaqiu/dsh-ui-theme-huaqiu"
   ```
4. Load the web profile; the sidebar brand mark should be the HuaQiu logo
   (slogan + theme color already worked).

## Migration status

- Source files (`src/`, `cordis.patch.yml`, `package.json`) of
  `dsh-pcb-eda/packages/dsh-ui-theme-huaqiu` are **byte-identical** to the
  original `/Users/admin/code/dsh-ui-theme-huaqiu` (verified by `diff`). The
  migration itself is complete; only the host normalization bug prevented the
  icon from applying.
- No change required to the package. The fix lives in hq-edge (the integration
  host).

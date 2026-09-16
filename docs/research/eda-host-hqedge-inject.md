# dsh-eda-host: `cannot get property "hqEdge" without inject` — root cause & fix

**Date:** 2026-09-16
**Symptom:** `get_selection_netlist` (and the other netlist tools) return

```json
{ "ok": false, "scope": "selection", "error": { "kind": "INTERNAL", "message": "cannot get property \"hqEdge\" without inject" } }
```

**Status:** root cause confirmed; source fix applied. Pack + install + restart
left to the operator (manual test).

---

## 1. Root cause

`dsh-eda-host` resolves the HQ Edge endpoint **lazily from the `hqEdge`
service** (provided by the `edge-bridge` HOST plugin) at request time:

- `packages/dsh-eda-host/src/index.ts` → `apply()` builds
  `getHqEdgeBaseUrl = () => ctx.hqEdge?.baseUrl` and passes it as
  `baseUrlResolver` to the client.
- The client (`client.ts`) calls that resolver per request to compute the
  netlist URL.

But `dsh-eda-host` declared:

```ts
export const inject = ['tools'] as const   // ❌ missing 'hqEdge'
```

and its bundle overlay (`cordis.patch.yml`) declared `inject: ['tools']`.

Because `hqEdge` was **never in the inject list**, Cordis never provided the
`hqEdge` service into eda-host's fiber. So the first `ctx.hqEdge` access throws.

### 1.1 Why the throw happens (traced in `deepseek-harness` Cordis core)

Cordis wraps every plugin context in a **proxy whose `get` handler** walks the
fiber tree looking for the requested service in a fiber store:

- vendored in `deepseek-harness/apps/web/dist/assets/index-*.js` (minified
  Cordis core):

  ```js
  static handler = { get: (t, r, i) => {
    if (z0(r)) return Reflect.get(t, r, i);             // built-ins
    if (Reflect.has(t, r)) return bt(i, Reflect.get(t, r, i));
    const s = new Error(`cannot get property "${r}" without inject`);
    const a = t.reflect.props[r];
    return a?.type === "accessor" ? a.get.call(i, i[J.receiver], s)
      : i.fiber.runtime
        ? i.events.waterfall("internal/get", i, r, s, /*…*/)   // service exists upstream
        : (function () { throw s })();                          // ❌ root fiber → throw
  }}
  ```

- the equivalent literal is at
  `deepseek-harness/packages/session/session-persistence-jsonl/lib/worker.cjs:1438`
  (`new Error('cannot get property "${prop}" without inject')`).

`ctx.hqEdge` is not a built-in and not in any fiber store reachable from
eda-host (it was never injected), so the walk reaches the **root fiber**
(`fiber.runtime === null`) and throws. This is the exact same mechanism
documented in `deepseek-harness/docs/postmortem/0001-acp-default-export-drops-inject.md`
("apply ran in a fiber with no injected services").

### 1.2 Why `hqEdge` is the right service to inject

The node-side `hqEdge` service **does** expose the base URL. In the running
`edge-bridge` lib (`hq-edge/apps/server/dsh-plugins/edge-bridge/lib/index.js`):

```js
export function createNodeHqEdge(upstreamRoot, logTag, context) {
  const base = upstreamRoot.replace(/\/+$/, '');
  // …
  return {
    get baseUrl() { return base; },          // ← loopback HQ Edge endpoint
    project: { /* getCurrent / onChanged / getAuthToken */ },
    api: { /* request({method,path,body}) / stream(…) — node fetch by PATH */ },
  }
}
```

`upstreamRoot` is the `hqEdgeBaseUrl` the supervisor injects into the bridge.
So `ctx.hqEdge.baseUrl` returns e.g. `http://localhost:60521` — exactly what
the resolver needs. (Sibling plugins `dsh-artifacts` / `dsh-tool-symbol-footprint`
reach hq-edge the same way via `ctx.get('hqEdge')`; `erc`
`apps/server/dsh-plugins/erc/lib/index.js` declares `inject = ['hqEdge','tools']`
and is the reference for the correct pattern — which is why `erc` worked and
`eda-host` did not.)

**Operator confirmation:** "we'd always inject hqEdge — it's expected that the
eda-host plugin cannot work without hqEdge." So requiring `hqEdge` is by design;
the standalone-DSH degradation intent (for an *absent* `hqEdge` service) no
longer applies — but an *empty* `baseUrl` still degrades to a clear
`FAILED_PRECONDITION` at request time.

---

## 2. The fix (applied)

Two files in `packages/dsh-eda-host/`:

**`src/index.ts`**

```ts
export const inject = ['hqEdge', 'tools'] as const
```

Plus doc/comment updates: top-of-file resolution order, the `declare module`
`Context.hqEdge` augmentation changed from optional `hqEdge?:` to required
`hqEdge:` (with a note that it is a required inject), and the `getHqEdgeBaseUrl`
closure unchanged (still `ctx.hqEdge?.baseUrl`).

**`cordis.patch.yml`**

```yaml
- insert:
    - id: huaqiu-dsh-eda-host
      name: '@huaqiu/dsh-eda-host'
      inject: ['hqEdge', 'tools']
```

The overlay `inject` must match `export const inject` — the supervisor
(`hq-edge/.../dsh/supervisor.ts` `readPluginPatchEntry`) reuses the plugin's
own `cordis.patch.yml` to derive the overlay entry, so both must list
`hqEdge`.

After this, Cordis provides `hqEdge` into eda-host's fiber at activation;
`ctx.hqEdge` resolves; `.baseUrl` returns the loopback endpoint; the resolver
supplies it; and the netlist fetch succeeds.

---

## 3. Verification done

- `pnpm typecheck` (tsc --noEmit) — clean.
- `pnpm test` (`vitest run`) — 13/13 pass (resolver-wins / fallback / throw
  only-when-empty tests still valid; `inject` is a module-level export, not
  exercised by unit tests, but the change is type-safe).

## 4. Deployment (operator / manual test)

The running hq-edge loads plugins from a **materialized copy** under
`DSH_HOME` (`/Users/admin/.hq-edge`), re-derived from the pinned source via
`hq-plugins.ts`. Editing `src/` alone does not reach the running server. To
deploy + test:

1. From `dsh-pcb-eda`, pack the plugin:
   `pnpm --filter @huaqiu/dsh-eda-host pack --pack-destination <dist>` (or the
   repo's `pack:check`/dist flow) — version must stay `0.3.20` to match
   `hq-edge/config/dsh-plugins.lock.json` (exact-version pin; otherwise
   `acquireHqPlugins` throws).
2. Install the local tarball into the hq-edge dev plugins root:
   `cd hq-edge && pnpm dev:hq-plugins` (runs
   `tsx scripts/packaging/hq-plugins.ts --out apps/server/dsh-plugins`
   with `--local` pointing at the `dsh-pcb-eda` dist tarballs). The supervisor
   re-materializes on next boot because the bundle fingerprint changes.
3. Restart hq-edge (the supervisor respawns often; the dev path re-materializes
   on version/fingerprint change).
4. Confirm `apps/server/dsh-plugins/erc/...` no longer the only one with
   `hqEdge` injected, and call `get_selection_netlist` — expect a real netlist
   (or a `FAILED_PRECONDITION` only if `hqEdge.baseUrl` is genuinely empty),
   **not** the `without inject` INTERNAL error.

---

## 5. Related references

- Cordis throw site: `deepseek-harness/apps/web/dist/assets/index-*.js`,
  `deepseek-harness/packages/session/session-persistence-jsonl/lib/worker.cjs:1438`.
- Postmortem on this exact error class:
  `deepseek-harness/docs/postmortem/0001-acp-default-export-drops-inject.md`.
- Node `hqEdge` service shape (proof `baseUrl` exists):
  `hq-edge/apps/server/dsh-plugins/edge-bridge/lib/index.js`
  (`createNodeHqEdge` → `get baseUrl()`).
- Reference correct pattern: `erc` plugin injects `['hqEdge','tools']`
  (`hq-edge/apps/server/dsh-plugins/erc/lib/index.js:59`).
- Supervisor overlay derivation:
  `hq-edge/apps/server/src/dsh/supervisor.ts` `readPluginPatchEntry` +
  `ensureHQBuiltinPlugins`.

---

## 6. `edge-bridge/overlay.yml` — actual usage, outdated?, necessary?

This section answers the follow-up audit of
`hq-edge/apps/server/dsh-plugins/edge-bridge/overlay.yml`. Verified against the
**real bundled dsh-home** at
`/Users/admin/.hq-edge/1.8.7/dsh-home/hq/builtin-plugins/0.1.3-7-g2c412ba/overlay.yml`
(the copy DSH actually loads) and the supervisor source.

### 6.1 What DSH actually loads (materialized, not the checked-in file)

`ensureHQBuiltinPlugins()` (supervisor.ts:1419, called at :943) **regenerates**
the overlay from discovered packages + each package's own `cordis.patch.yml`:

- `bridgeSourceDir = path.dirname(this.config.patchFile)` — the parent dir of
  the checked-in `overlay.yml` (i.e. `.../dsh-plugins/edge-bridge/`) is the
  **plugins-root discovery anchor** (`discoverSiblingHqPlugins`).
- `buildHqPluginOverlay(plugins)` (supervisor.ts:330) **renders a brand-new
  overlay** — `- insert:` with one entry per discovered package, `inject`
  taken from each package's `cordis.patch.yml` via `readPluginPatchEntry`, and
  `config` (hqEdgeBaseUrl / targetHost / editorType) injected into the bridge
  (+ `dsh-auth`). This generated file is written into the versioned bundle and
  set as `this.materializedPatchFile`.
- `buildArgs` (supervisor.ts:1315) loads `this.materializedPatchFile ??
  this.config.patchFile`. Since `materializedPatchFile` is always set after
  `ensureHQBuiltinPlugins`, **DSH loads the materialized overlay, never the
  checked-in `edge-bridge/overlay.yml` content.**

So the checked-in file's **body is dead at runtime** — its entry list and
hardcoded `inject` values are overwritten by regeneration.

### 6.2 Real (materialized) overlay — note `dsh-eda-host` IS present

The bundled `0.1.3-7-g2c412ba/overlay.yml` contains (verbatim, ids as
generated):

```yaml
- insert:
    - id: "hq-edge-bridge"            # @hqedge/dsh-edge-bridge  (config: hqEdgeBaseUrl/targetHost/editorType)
    - id: "huaqiu-artifacts"          # @huaqiu/dsh-artifacts          inject: [webServer]
    - id: "huaqiu-auth"               # @huaqiu/dsh-auth               inject: [webServer]  + config.hqEdgeBaseUrl
    - id: "huaqiu-dsh-eda-host"       # @huaqiu/dsh-eda-host           inject: [hqEdge, tools]   ← our fix, correct
    - id: "huaqiu-tool-part-search"   # @huaqiu/dsh-tool-part-search    inject: [tools]
    - id: "huaqiu-tool-schematic-gen" # @huaqiu/dsh-tool-schematic-gen   inject: [tools, huaqiuArtifacts, webServer]
    - id: "huaqiu-tool-symbol-footprint" # @huaqiu/dsh-tool-symbol-footprint inject: [tools, huaqiuArtifacts, webServer]
    - id: "hq-erc"                    # @hqedge/dsh-erc               (NO inject line)
```

Key confirmations:

- **`huaqiu-dsh-eda-host` is mounted with `inject: [hqEdge, tools]`** — the
  supervisor derived this from the plugin's `cordis.patch.yml` (§2 fix). So the
  runtime is already correct; the earlier `without inject` error was against an
  older bundle that predated the materialization of our change.
- **`hq-erc` has NO `inject:` line.** Reasoning: `inject` in the overlay is
  *optional*. When absent, Cordis falls back to the plugin's module
  `export const inject` (`erc/lib/index.js:59` → `['hqEdge','tools']`). That is
  exactly why `erc` worked as the reference while `eda-host` (which had
  `inject:['tools']` in BOTH places) did not. Takeaway: a `@huaqiu/*` plugin
  MUST declare `inject` in `cordis.patch.yml` (the supervisor copies it into
  the overlay); a host plugin like `erc`/`edge-bridge` can rely on its module
  `export const inject` instead.
- The `@huaqiu/*` `inject` lists here are the **authoritative** ones (from each
  package's `cordis.patch.yml`), and they differ from the checked-in
  `edge-bridge/overlay.yml` — see §6.3.

### 6.3 Is the checked-in `edge-bridge/overlay.yml` outdated? — YES (as docs)

Compared with the materialized overlay (§6.2) it is **stale**:

1. **Missing `dsh-eda-host` entirely.** The checked-in file ends at
   `huaqiu-tool-symbol-footprint` and never lists `@huaqiu/dsh-eda-host` — the
   plugin this whole investigation fixed. The runtime generated overlay has it.
2. **Stale `inject` for `schematic-gen` / `symbol-footprint`.** Checked-in says
   `['tools','huaqiuAuth','huaqiuArtifacts','webServer']` /
   `['tools','huaqiuAuth','huaqiuArtifacts']`, but the real packages emit
   `['tools','huaqiuArtifacts','webServer']` (no `huaqiuAuth`; symbol-footprint
   also gains `webServer`). The checked-in values were hand-copied long ago and
   never tracked the packages' own `cordis.patch.yml`.
3. **Cosmetic id drift:** checked-in labels `erc` as `hq-tool-erc`; the
   generated id is `hq-erc` (derived `hq-${basename}`). Irrelevant — the
   supervisor regenerates ids.

(The checked-in file's own header already concedes this: it says the supervisor
"REGENERATES this overlay at boot" and the file is the "dev fallback anchor …
documents the full expected set." It just hasn't been kept in sync with the
package set.)

### 6.4 Is it necessary? — the FILE yes, the CONTENT no

- **The file (as `config.patchFile` anchor) is necessary.** `ensureHQBuiltinPlugins`
  early-returns `if (!this.config.patchFile) return` (supervisor.ts:1420), and
  `bridgeSourceDir = path.dirname(config.patchFile)` must resolve to a directory
  containing a `package.json` (guarded at :1425) so sibling discovery works.
  Without it, **no HQ plugin is materialized** and DSH runs without hq-edge.
  So `edge-bridge/overlay.yml` must keep existing at that path (it could even be
  a different filename inside `edge-bridge/`, but the convention is this file).
- **The file's CONTENT is not necessary** — it is fully regenerated and never
  loaded by DSH. Editing its `inject`/entry list has **zero runtime effect**;
  the single source of truth for each plugin's overlay contract is its own
  `cordis.patch.yml` (read by `readPluginPatchEntry`).

### 6.5 Action

- **No runtime fix needed here.** The fix for the `without inject` error is the
  `cordis.patch.yml` + module `inject` change in §2, already materialized (§6.2).
- **Hygiene only (optional):** the checked-in `edge-bridge/overlay.yml` should be
  updated to (a) add the `huaqiu-dsh-eda-host` entry and (b) sync the
  `schematic-gen` / `symbol-footprint` injects to match their `cordis.patch.yml`,
  so it stops misleading readers. This is documentation-only — it changes nothing
  DSH loads. Not done automatically; flag if you want it touched.
- **Deployment recap (unchanged from §4):** pack `@huaqiu/dsh-eda-host`
  (keep version `0.3.20`), `cd hq-edge && pnpm dev:hq-plugins`, restart. The
  supervisor re-materializes because the bundle fingerprint changes, and the new
  `huaqiu-dsh-eda-host` overlay entry (with `hqEdge`) is emitted automatically.

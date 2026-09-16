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

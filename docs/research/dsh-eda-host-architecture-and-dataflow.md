# `dsh-eda-host` — Implementation, Workflow & Dataflow

Purpose: a reference brief for building further features on top of
`@huaqiu/dsh-eda-host`. Covers what exists today, how control flows from build
time to an agent tool call, how data flows end-to-end (agent → DSH → hq-edge →
KiCad → back), and the gaps that will bite the next feature.

Sources verified at the paths cited below:

- plugin: `/Users/admin/code/dsh-pcb-eda/packages/dsh-eda-host`
- orchestrator: `/Users/admin/code/hq-edge`
- host: `/Users/admin/code/kicad` (`hq/`, `eeschema/hq/`)

---

## 1. What the package is

A single-purpose Cordis **node-half** DSH plugin — 5 source files, ~530 LOC. It
owns *DSH integration only*: it turns three agent tool calls into HTTP requests
against hq-edge and returns a semantic `SchematicNetlist`. It deliberately
contains no KiCad code, no schematic parsing, and no host IPC.

| File | Role |
|---|---|
| `src/index.ts` | Cordis entry. `export const inject = ['hqEdge','tools']`, `apply()` provides the `edaHost` service and registers 3 tools. |
| `src/config.ts` | Config resolution + URL building (`netlistUrlOf`), scope→route map. |
| `src/client.ts` | HTTP transport, HTTP status → semantic error kind. |
| `src/tools.ts` | Three `defineTool()` declarations + the agent-facing prompt contract. |
| `src/types.ts` | Structural mirror of `hq.ir.schematic.v1` and the `NetlistError` kinds. |
| `cordis.patch.yml` | Bundle patch: `id: huaqiu-dsh-eda-host`, `inject: [hqEdge, tools]`. |

Exposed tools: `get_project_netlist`, `get_selection_netlist`,
`get_active_page_netlist`. All three take **no parameters** and return
`{ ok, scope, netlist | error:{kind,message} }`.

---

## 2. Workflow — control flow

### 2.1 Build & package

1. `tsdown` builds `src/` → `lib/index.mjs` (`prepack` runs `pnpm build`).
2. `hq-edge/config/dsh-plugins.lock.json:10` pins `@huaqiu/dsh-eda-host: 0.3.24`.
3. `hq-edge/scripts/packaging/hq-plugins.ts:56,60-69` `npm pack`s it into
   `dist/edge-headless/dsh-plugins/@huaqiu/dsh-eda-host/`.

The lock file is **build-time only** — it is not shipped and not read at
runtime; the dist carries `dsh-plugins/manifest.json` instead.

### 2.2 Boot — how HQ Edge installs it

1. `DshSupervisor.ensureHQBuiltinPlugins` (`apps/server/src/dsh/supervisor.ts:1462`)
   takes the bridge dir as plugins root and calls `discoverSiblingHqPlugins`
   (`:124-162`, recurses one level into `@huaqiu/`).
2. For each package, `readPluginPatchEntry` (`:198-266`) line-parses
   `cordis.patch.yml` to extract `id` + `inject`.
3. Each package is symlinked into `<DSH_HOME>/profiles/web/node_modules/<name>`
   (`:1601-1607`) — this is why no pnpm is needed at runtime.
4. `buildHqPluginOverlay` (`:362-400`) regenerates `overlay.yml` into
   `<DSH_HOME>/hq/builtin-plugins/<version>/overlay.yml` (`:1552`).
5. DSH is spawned with `--patch <overlay.yml>` as a global option
   (`:1358-1361`, splice `:1376`, spawn `:1041-1052`).
6. The node Cordis loader imports `@huaqiu/dsh-eda-host` and calls
   `apply(ctx, config)`.

### 2.3 `apply()` — runtime wiring

```
resolveEdaHostConfig(config)          // config.hqEdgeBaseUrl ?? HQ_EDGE_BASE_URL
  ↓
getHqEdgeBaseUrl = () => ctx.hqEdge?.baseUrl   // LATE-BOUND, read per request
  ↓
createEdaHostClient(resolved, { baseUrlResolver: getHqEdgeBaseUrl })
  ↓
ctx.effect(() => ctx.provide('edaHost', client))
  ↓
for each of 3 tools: ctx.tools.register(tool)
  ↓
return disposer (unregisters all three, best-effort)
```

Endpoint resolution order, evaluated **per request**
(`client.ts:59-61`): `ctx.hqEdge.baseUrl` (from the edge-bridge HOST) →
static `config.hqEdgeBaseUrl` → `HQ_EDGE_BASE_URL` env → else
`FAILED_PRECONDITION`.

### 2.4 Request path

```
agent → DSH tool call
      → tools.ts runScope(scope)
      → client.fetchScope(scope)
          resolve base URL (ctx.hqEdge) → netlistUrlOf() → GET
      → hq-edge express /api/v1/netlist/<scope>
      → cppNetListClient.<scope>NetList(Empty)   [gRPC]
      → KiCad HQ_NETLIST_SERVICE
```

---

## 3. Dataflow — end to end

```
┌─────────────┐  tool call (no params)
│    Agent    │
└──────┬──────┘
       ▼
┌──────────────────────────────────────────────────────────────┐
│ DSH · @huaqiu/dsh-eda-host  (node half)                      │
│   tools.ts  runScope(scope)                                  │
│   client.ts fetchScope()  → GET {base}/api/v1/netlist/{scope} │
└──────┬───────────────────────────────────────────────────────┘
       │ HTTP/JSON  (loopback, no auth)
       ▼
┌──────────────────────────────────────────────────────────────┐
│ hq-edge  apps/server                                         │
│   routes/netlist.ts   GET /project | /selection | /active-page│
│   grpc/clients.ts     cppNetListClient (Connect gRPC)         │
│   EDA_GRPC_URL = http://localhost:50051  (default)            │
└──────┬───────────────────────────────────────────────────────┘
       │ gRPC  hq.ir.schematic.v1.NetListService
       ▼
┌──────────────────────────────────────────────────────────────┐
│ KiCad                                                        │
│   HQ_NETLIST_SERVICE::getNetList()      (gRPC worker thread)  │
│   HQ_DISPATCH::OnUIThread()             (wx event + condvar)  │
│   HQ_DISPATCH::TryEachHandler()         (std::set<HANDLER*>)  │
│   HQ_HANDLER_SCH::PopulateNetList()     (eeschema/hq/)        │
│     SCHEMATIC::ConnectionGraph() → GetNetMap()                │
│     SCH_SYMBOL / SCH_PIN → SchematicNetlist                   │
└──────────────────────────────────────────────────────────────┘
```

### 3.1 Forward path detail

**Hop 1–2 (plugin).** `SCOPE_ROUTE` maps `project→/project`,
`selection→/selection`, `active-page→/active-page`; the default prefix is
`/api/v1/netlist` (`config.ts:20-29`). Final URL e.g.
`http://localhost:3000/api/v1/netlist/project`.

**Hop 3 (hq-edge).** `routes/netlist.ts:61-71` — three GET handlers call
`fetchNetList`, which invokes the matching Connect client method with
`google.protobuf.Empty`. `cppNetListClient` is built on
`createGrpcTransport({ baseUrl: config.EDA_GRPC_URL })`
(`grpc/clients.ts:46,59`). Config module is
`apps/server/src/config/loadConfig.ts` (schema `:212-217`, default
`http://localhost:50051` at `:593`). Listen is loopback-only:
`apps/server/src/index.ts:115`.

**Hop 4 (KiCad).** `hq/runtime/src/hq_netlist_service.cpp:56-89`:
- `GetSelectionNetList` → `getNetList(resp, true)`; `GetProjectNetList` →
  `getNetList(resp, false)`.
- Marshals to the UI thread via `HQ_DISPATCH::OnUIThread`, then
  `TryEachHandler` invokes `PopulateNetList` on each handler until one
  returns `true` (`:66-75`).
- If nothing handled it, returns `grpc::Status::OK` **with the oneof unset**
  (`:80-86`).

**Real extraction** — `eeschema/hq/hq_handler_sch.cpp:720-863`:
- Components: project scope walks `BuildUnorderedSheetList()` +
  `SCH_SCREEN::Items()` filtering `SCH_SYMBOL_T` and de-dupes by refdes;
  selection scope uses `SCH_SELECTION_TOOL::GetSelection()` +
  `frame()->GetCurrentSheet()` only.
- Fields via `GetRef/GetValue/GetFootprintFieldText`, variant-aware.
- Nets via `ConnectionGraph()->GetNetMap()` → `CONNECTION_SUBGRAPH::GetNetName()`
  and `GetItems()` filtered to `SCH_PIN_T`.
- Sets `aResponse->mutable_netlist()` (`:731`).

### 3.2 Return path — error semantics (the good part)

The chain preserves "valid empty" vs "cannot answer":

| Origin | gRPC / Connect | HTTP | `error.kind` |
|---|---|---|---|
| no host / no live editor | `FailedPrecondition` | 412 | `FAILED_PRECONDITION` |
| scope not supported | `Unimplemented` | 501 | `UNIMPLEMENTED` |
| host unreachable | `Unavailable` | 503 | `UNAVAILABLE` |
| connection refused | (fetch throws) | — | `UNAVAILABLE` |
| anything else | — | 500 | `INTERNAL` |

`routes/netlist.ts:51-57` maps the code; `client.ts:42-47` maps the status
back. `tools.ts:62-69` wraps into `{ok:false, error:{kind,message}}`. Nothing
is ever coerced into a fake empty netlist.

---

## 4. Gaps to fix before building further features

Ordered by how likely they are to break the next feature.

### P0 — Response shape mismatch: every netlist comes back EMPTY

`routes/netlist.ts:40-42` serializes **`GetNetListResponse`**, whose payload is a
`oneof result { netlist | empty }`, and wraps it again:

```js
res.json({ netlist: toJson(GetNetListResponseSchema, response) })
```

Canonical proto3 JSON emits the set oneof case at the parent level, so the wire
body is double-nested. Verified empirically against the real generated schema
(`platform/sdk/ts/src/generated/hq/ir/schematic/v1/netlist_pb.ts`) with
`@bufbuild/protobuf` 2.15.0:

```
hq-edge body (populated): {"netlist":{"netlist":{"components":[...],"nets":[...]}}}
plugin result:            {"netlist":{"components":[...],"nets":[...]},"components":[],"nets":[]}
```

`client.ts:97-105` reads `body.netlist` (the **response**, not the netlist) and
`??= []`s the missing arrays. A fully populated netlist is therefore reported as
`ok:true` with `components:[]` / `nets:[]`.

This is maximally damaging because the tool contract explicitly tells the agent
that `ok:true` + empty arrays means *"a VALID empty design — do not treat it as
a failure"*. Silent, unflagged data loss.

**Why tests don't catch it:** `test/netlist.test.ts:27` mocks
`{ netlist: { components: [], nets: [] } }` — the flattened shape hq-edge never
actually emits.

**Fix:** unwrap in `client.ts` (`body.netlist?.netlist ?? body.netlist`) and/or
have hq-edge emit `toJson` of the inner `SchematicNetlist`. Add a fixture-based
test built from `GetNetListResponseSchema`, not a hand-written literal.

### P0 — `empty` vs "no handler" is indistinguishable

KiCad returns `OK` with the oneof **unset** when no handler populated
(`hq_netlist_service.cpp:80-86`); `mutable_empty()` appears nowhere in the tree.
That serializes to `{"netlist":{}}` → plugin yields `{components:[],nets:[]}` —
identical to a genuinely empty design. So "no schematic editor open" is
reported as "empty design" rather than `FAILED_PRECONDITION`, which is exactly
the distinction the design was built to preserve.

Also `hq_netlist_service.cpp:74`: the UI lambda always returns `true`, so
`OnUIThread` reports success regardless of handler outcome — real handler
failures are invisible.

### P1 — No timeout anywhere on the request path

- `HQ_DISPATCH::OnUIThread` defaults to `aTimeoutMs = 0` = **wait forever**
  (`hq_ui_marshal.h:105-106`); netlist passes no timeout
  (`hq_netlist_service.cpp:66`). A modal dialog or long menu in KiCad blocks
  the gRPC handler indefinitely.
- The plugin's `fetch` has no `AbortSignal`; `tools.ts:42-45` declares
  `ToolExecLike.signal` but `execute` ignores it.

Net effect: an agent tool call can hang forever. Add a deadline at every hop.

### P1 — `config.hqEdgeBaseUrl` is a dead channel

`buildHqPluginOverlay` sets `config` for exactly two ids — the bridge
(`supervisor.ts:1496-1500`) and `@huaqiu/dsh-auth` (`:1530-1537`). There is no
generic channel, so `@huaqiu/dsh-eda-host` **never** receives overlay config
and `HQ_EDGE_BASE_URL` is never set by hq-edge. The plugin works *only* via
`ctx.hqEdge.baseUrl`.

Consequence: the README ("the base URL arrives as overlay config … or
`HQ_EDGE_BASE_URL` env fallback") is wrong, and the plugin has no working
fallback if the bridge is absent.

### P1 — Silent failure if the bridge no-ops

`edge-bridge/lib/index.js:425-431` returns early (no-op) when
`hqEdgeBaseUrl` doesn't start with `http`. Then `ctx.provide('hqEdge', …)`
(`:540`) never runs. Because `hqEdge` is a **required** inject, the eda-host
fiber stays pending forever — the three tools simply never register, with no
error. `src/index.ts:170-176` assumes a throw, not a hang.

### P2 — Scope gaps

- **`get_active_page_netlist` is unimplemented.** `HQ_NETLIST_SERVICE` declares
  only two overrides; `GetActivePageNetList` has zero hits in the KiCad tree, so
  the generated base returns `UNIMPLEMENTED`. Currently documented as expected
  in the tool description — fine, but it is a real front-door gap.
- **Selection is current-sheet only** (`hq_handler_sch.cpp:740-756`); no
  cross-sheet selection.
- **PCB contributes nothing**: `HQ_HANDLER_PCB` does not override
  `PopulateNetList` (`pcbnew/hq/hq_handler_pcb.h:62`) → base returns `false`.
- **No connection-graph refresh** before extraction — stale-graph risk.
- Handler iteration is `std::set<HQ_HANDLER*>` (pointer-ordered), so with both
  editors open the winner is not semantically determined.
- Handlers register only under `#ifdef KICAD_IPC_API`
  (`sch_edit_frame.cpp:492-493`, `pcb_edit_frame.cpp:576-577`).

### P2 — Misc

- **Port discovery is inverted from the default.** KiCad binds a **dynamic**
  port (`HQ_NET_UTILS::AllocateFreeTcpPort()`) and reports it via
  `SetGrpcUrl("http://localhost:<port>")` (`hq_runtime.cpp:67-70`), while
  hq-edge's `EDA_GRPC_URL` defaults to a static `50051`. Something must feed
  the dynamic port back — worth confirming which mechanism is authoritative in
  your deployment before adding features.
- **No auth** on `/api/v1/netlist`; acceptable only because the server binds
  `localhost` (`index.ts:115`). Do not widen the bind without adding auth.
- `tools.ts:27-29` `asJson` does a full `JSON.parse(JSON.stringify(...))` —
  a redundant double serialization on every call; relevant for large designs.
- Stale hq-edge docs: `docs/edge-headless.md:107`, `README.md:170-173` omit
  `@huaqiu/dsh-eda-host` from the published-plugin tables though it is pinned
  and shipped. The checked-in `edge-bridge/overlay.yml` is a dev anchor only
  (regenerated at boot) and has no eda-host entry.

---

## 5. Where to extend

| Intent | Touch |
|---|---|
| New netlist scope (e.g. `page`, `hierarchical-subtree`) | proto `netlist.proto` → `SCOPE_ROUTE` (`config.ts`) → `routes/netlist.ts` → `HQ_NETLIST_SERVICE` override + handler |
| New **read** capability (BOM, ERC, placement) | new plugin or new tools here; follow the same client/route/gRPC ladder — do **not** put host logic in the plugin |
| Host-side **write / mutation** | new gRPC service + handler; note everything must marshal to the UI thread, so budget for the timeout work above |
| Pass config to this plugin | extend `buildHqPluginOverlay` (`supervisor.ts:362-400`) — currently bridge+auth only |

**Invariants to preserve:** the plugin stays free of `@hqedge/*` and KiCad
logic; `types.ts` remains the single place wire shapes are named; errors are
never converted into empty results; `ok:true` + empty arrays must mean a
genuinely empty design (which is exactly what P0 breaks today).

# @huaqiu/dsh-eda-host

DSH plugin exposing the current EDA host to agents through hq-edge: its
schematic netlist, and — without reimplementing anything — the environment and
capability facts the host already knows.

## What it provides

Netlist:

| Tool | Scope |
|---|---|
| `get_project_netlist` | complete logical netlist of the current project |
| `get_selection_netlist` | netlist of the currently selected components |
| `get_active_page_netlist` | netlist of the active schematic page |

EDA host discovery:

| Tool | Returns |
|---|---|
| `get_eda_host_info` | host identity, version, installation paths, `kicad-cli` path |
| `get_eda_host_capabilities` | capabilities the *current* host can actually provide |

Discovery is not implementation: a capability is advertised only when the host
can already provide it, and never because the EDA application is generally
known for it.

Each tool returns lossless JSON:

```json
{
  "ok": true,
  "scope": "project",
  "netlist": {
    "components": [
      { "referenceDesignators": ["R1"], "value": "10k", "footprint": "R_0603",
        "manufacturerPartNumber": "", "description": "", "pins": [
          { "pinNumber": "1", "pinName": "1", "electricalType": "ELECTRICAL_TYPE_PASSIVE" }
        ] }
    ],
    "nets": [
      { "name": "GND", "pinReferences": [
        { "referenceDesignator": "R1", "pinNumber": "2" }
      ] }
    ]
  }
}
```

A valid-but-empty design is `ok: true` with empty `components`/`nets` — it is
NOT an error. On failure the tool returns `ok: false` with a semantic
`error.kind`:

- `FAILED_PRECONDITION` — no EDA host / no live editor (ask the user to open
  the design first).
- `UNIMPLEMENTED` — the host does not support this scope (e.g. active page on
  KiCad). Do not retry.
- `UNAVAILABLE` — hq-edge host unreachable.
- `DEADLINE_EXCEEDED` — the host did not answer within the request budget.
- `INTERNAL` — host-side failure or a malformed response.

`ok:true` with empty `components`/`nets` means exactly one thing: a genuinely
empty design. It never means "the parse failed" or "the host is unavailable" —
those are always `ok:false` with a `kind`.

## Architecture

```
DSH
 ↓
dsh-eda-host      (this plugin: DSH integration only, self-contained)
 ↓ hq-edge HTTP
hq-edge           (semantic protocol + orchestration; /api/v1/netlist/*)
 ↓ gRPC
EDA Host          (hq.ir.schematic.v1.NetListService — KiCad / HQ EDA)
 ↓
native EDA model
```

- No `@hqedge/*` dependency: the base URL is read from `ctx.hqEdge.baseUrl`
  (provided by the edge-bridge), falling back to overlay config
  (`hqEdgeBaseUrl`) or `HQ_EDGE_BASE_URL`.
- No KiCad code, no schematic parsing, no host IPC in this package.
- Errors are propagated with semantic kinds — never converted into fake empty
  netlists.

## EDA host discovery

Host info crosses the same boundary as the netlist, using the EDA-independent
`hq.host.v1` contract — not KiCad-shaped messages:

```text
get_eda_host_info ─┐
                   ├─→ hq-edge /api/v1/host/* ─→ hq.host.v1.EdaHostInfoService ─→ host
get_eda_host_capabilities ─┘
```

The host adapts its native facts (version, install path, `kicad-cli` location,
which editors are open) into that contract. hq-edge performs no host-specific
translation, so KiCad and HQ EDA implement the same service.

**`hq.host.v1` has no availability fields.** A host that answers is available,
and every executable it lists is one it can run — so unavailability is never a
flag to check, it is a failed request (`ok:false` with `UNAVAILABLE` /
`FAILED_PRECONDITION` / `DEADLINE_EXCEEDED`). Because proto3 omits default
values, a host reporting nothing arrives as `{}`; the client fills the proto3
defaults so a missing field can never be misread as "unavailable". An empty
executable `path` means the host did not resolve an absolute location, not that
the tool is missing.

## Request budget

Every request has a single bounded budget (`requestTimeoutMs`, default 30 s),
enforced here and mirrored by the KiCad UI-dispatch bound. A request that
exceeds it fails with `DEADLINE_EXCEEDED`; it never returns an empty result.

## Dependency boundary

This plugin **requires hq-edge**. It is not a standalone DSH plugin: `hqEdge` is
a required inject, and `apply()` throws if the bridge did not provide a usable
endpoint. See `docs/tasks/expose-capability.md` in hq-edge.

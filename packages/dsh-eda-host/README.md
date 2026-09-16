# @huaqiu/dsh-eda-host

DSH plugin exposing the current EDA host's schematic netlist to agents through
hq-edge.

## What it provides

| Tool | Scope |
|---|---|
| `get_project_netlist` | complete logical netlist of the current project |
| `get_selection_netlist` | netlist of the currently selected components |
| `get_active_page_netlist` | netlist of the active schematic page |

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
- `INTERNAL` — host-side failure.

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

- No `@hqedge/*` dependency: the base URL arrives as overlay config
  (`hqEdgeBaseUrl`, delivered by the hq-edge supervisor) or `HQ_EDGE_BASE_URL`
  env fallback.
- No KiCad code, no schematic parsing, no host IPC in this package.
- Errors are propagated with semantic kinds — never converted into fake empty
  netlists.

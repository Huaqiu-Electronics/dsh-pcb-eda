# Placement Conventions (HQSCH)

## Coordinate Convention

All three library-placement RPCs share the same **external display coordinates**
for `local_pos`:

| Space | Origin | Y direction | Range |
| --- | --- | --- | --- |
| **User / Agent** (`local_pos`) | Page top-left | Downward ↑ Y | **0 ~ page display height** (varies by A4/Letter/custom size) |
| **Internal canvas** | Bottom-left | Upward | Page top at `PAGE_SIZE_START_Y` (typically **1400**) |

**Important:** `1400` is the **canvas Y anchor of the page top edge**, not the
maximum user `extY`. User `extY` counts down from the page top and is bounded
by the active page's display height (e.g. A4 ≠ Letter ≠ custom).

Conversion (inside `SDK_PlacePartByExtCoord` / `SDK_PlaceSymbolByExtCoord`):

```
canvasY = PAGE_SIZE_START_Y - extY     // PAGE_SIZE_START_Y ≈ 1400 (page top)
```

Example (default page): user places GND at `(50, 100)` → canvas Y = `1400 - 100 = 1300`.

Reverse (from `kernel-get-snapshot` pin positions):

```
extY = PAGE_SIZE_START_Y - canvasY
```

Applies to:

- `PlaceKicadSymbol` → `SCH_PlaceKicadSymbolFromResource`
- `PlacePartFromLibrary` → `SCH_PlacePartFromLibrary`
- `PlaceSymbolFromLibrary` → `SCH_PlaceSymbolFromLibrary`
- `PlaceWire` → wire segment endpoints (same external convention)

See also [`property-conventions.md`](property-conventions.md) for pin/wiring coords.

## Orientation: Mirror vs Rotate

| Goal | API | Notes |
| --- | --- | --- |
| **Fixed facing** (e.g. LDO VIN pin left) | `RotateObjectsByIds` | Each call = 90° clockwise; predictable, call 1–3 times as needed |
| **Flip symbol** | `MirrorObjectsByIds` | **`mode` is required** — see table below |

### MirrorObjectsByIds — `mode` is mandatory

Protobuf `int32 mode` defaults to **0** (`MIRROR_NONE`), which performs **no transform**.
The RPC now returns `success: false` when `mode` is 0 or missing.

| `mode` | Effect |
| --- | --- |
| **1** | Horizontal mirror (left ↔ right) |
| **2** | Vertical mirror (top ↔ bottom) |
| **3** | Both axes |
| **0** | **Invalid** — no-op, `success: false` |

```typescript
// Correct — flip U1 horizontally
await canvasOps.mirrorObjectsByIds({
  context: projectCtx,
  objectIds: [u1ObjectId],
  mode: 1,
});

// Wrong — mode omitted or 0 looks like "success" in old builds but changes nothing
await canvasOps.mirrorObjectsByIds({ context: projectCtx, objectIds: [u1ObjectId] }); // BAD

// Prefer rotate when layout goal is "pin N faces direction X"
await canvasOps.rotateObjectsByIds({ context: projectCtx, objectIds: [u1ObjectId] });
```

## Objective

Guide agents to place schematic objects through the **correct library surface**.
Do **not** hand-craft engine-internal JSON for `PlacePart` / `PlaceSymbol`.

## Part Placement (R, C, Q, U, …) — Online First

| Priority | Step | RPC / API | Notes |
| --- | --- | --- | --- |
| **1 (preferred)** | Search | `client.parts.searchParts` / DSH `search_hqsch_parts` | Pick candidate with `hasSymbol` + `hasFootprint`. |
| **2** | Models | `client.parts.getEdaModels` / DSH `get_hqsch_part_models` | Get symbol / footprint download URLs. |
| **3** | Place | `PlaceKicadSymbol` | Maps to SDK `SCH_PlaceKicadSymbolFromResource` — engine downloads `.kicad_sym`, converts, places. |
| Fallback | List | `ListPartLibraries` | Only when online search has no suitable part. |
| Fallback | Place | `PlacePartFromLibrary` | Local/builtin `.HQSchLib` part. |

**Do not use** `PlacePart` with hand-crafted `json_part` / `json_part_inst`.

See [`../eda/part-search/SKILL.md`](../eda/part-search/SKILL.md) for search strategy.

### TypeScript Example (0805 capacitor)

```typescript
import { connect } from "@huaqiu/huaqiu-client";

const client = await connect({ instanceId: "..." });
const projectCtx = client.createProjectContext(projectId);

// 1. Online search
const page = await client.parts.searchParts({
  query: "0805 0.1uF capacitor",
  requirements: { symbol: true, footprint: true },
  pageSize: 10,
});
const hit = page.items.find((i) => i.hasSymbol && i.hasFootprint && i.manufacturer.id);
if (!hit) throw new Error("no online part candidate");

// 2. EDA model URLs
const models = await client.parts.getEdaModels({
  manufacturerId: hit.manufacturer.id!,
  mpn: hit.mpn,
});
if (!models.symbol?.url) throw new Error("no symbol URL");

// 3. Place via SCH_PlaceKicadSymbolFromResource (gRPC: PlaceKicadSymbol)
// localPos Y: 0 = page top, increases downward (NOT capped at 1400)
const res = await client.componentPlace.placeKicadSymbol({
  context: projectCtx,
  localPos: { x: 50n, y: 75n },
  component: {
    componentName: "C1_cap",
    symbolResource: { uri: models.symbol.url },
    footprintResources: models.footprint?.url
      ? [{ uri: models.footprint.url, models: models.model3d?.url ? [{ uri: models.model3d.url }] : [] }]
      : [],
    attributes: [
      { name: "Reference", value: "C1" },
      { name: "Value", value: "0.1 μF" },
      { name: "Footprint", value: models.footprint?.fileName ?? hit.package ?? "0805" },
      { name: "MPN", value: hit.mpn },
    ],
  },
});
if (!res.success || !res.objectId) throw new Error("PlaceKicadSymbol failed");
```

After placement, confirm designator/value with `SetObjectProperty` (`propKey: "Part Reference"`, `"Value"`, `"Footprint"`) — see [`property-conventions.md`](property-conventions.md).

## Symbol Placement (GND, VCC, port, off-page)

Global/power symbols, hierarchical ports, and off-page connectors use the **symbol library** surface (not part-search):

| Step | RPC | Notes |
| --- | --- | --- |
| 1 | `ListSymbolLibraries` | Read `library_name`, `symbol_name`, `kind`. |
| 2 | `PlaceSymbolFromLibrary` | Maps to SDK library load + place; do not hand-craft JSON. |

**Do not use** `PlaceSymbol` with `json_symbol` / `json_symbol_inst`.

### Approximate `symbol_name` matching

`symbol_name` does not have to be an exact library entry. The engine scores every
symbol of the **resolved library only** and takes the best hit — it never searches
other libraries, so step 1 (`ListSymbolLibraries`) is still required to pick the
right `library_name` / `library_file_path`.

Ranking, from strongest to weakest: exact → case-insensitive → normalized
(`_ - . space` stripped) → separator-boundary prefix → separator-boundary token →
normalized prefix → plain substring. Ties prefer the shorter candidate name.

Because separator-boundary hits outrank plain substrings, `GND` never resolves to
`VCC_5V`. If nothing scores, the call fails with `SymbolNotFound`.

`net_name` is written to the `"Name"` user property of that one placed instance;
the shared library / design-cache definition keeps its original name. Leaving
`net_name` empty means "same as `symbol_name`", which is usually what you want:

```typescript
import { HqServicesV1ComponentPlaceService } from "@hqedge/connect";

const { LibrarySymbolKind } = HqServicesV1ComponentPlaceService;

// Step 1 — list libraries (required: symbol_name is matched within one library only)
const symLibs = await client.componentPlace.listSymbolLibraries({ context: projectCtx });

// Step 2 — find the library entry whose symbol_name matches (e.g. "VCC_5V" or "GND")
let placedId: bigint | undefined;
for (const lib of symLibs.libraries) {
  const sym = lib.symbols.find((s) => s.symbolName === "VCC_5V");
  if (!sym) continue;

  // Step 3 — place at external display coordinates (Y down from page top)
  const res = await client.componentPlace.placeSymbolFromLibrary({
    context: projectCtx,
    localPos: { x: 50n, y: 50n },           // user view: (50, 50) from top-left
    libraryName: lib.libraryName,            // from ListSymbolLibraries
    symbolName: sym.symbolName,              // e.g. "VCC_5V" (approx match → library "VCC")
    libraryFilePath: lib.libraryFilePath,    // from ListSymbolLibraries
    kind: sym.kind ?? LibrarySymbolKind.LIBRARY_SYMBOL_KIND_GLOBAL,
    netName: "VCC_5V",                       // → "Name" user property on this instance
  });
  if (res.success && res.objectId) {
    placedId = res.objectId;
    break;
  }
}
if (!placedId) throw new Error("PlaceSymbolFromLibrary failed for VCC_5V");

// Save object_id for pin lookup — use kernel-get-snapshot canvas_object_id, not designator.
// See property-conventions.md "Pin Coordinates and Wiring".

// Step 4 — set designator (find uses "Reference"; set uses "Part Reference")
await client.canvasOps.setObjectProperty({
  context: projectCtx,
  objectId: placedId,
  propKey: "Part Reference",
  propValue: "VCC_5V",
  op: 1,           // OBJ_PROP_SET
  commitUndo: true,
});
```

### `PlaceSymbolFromLibrary` request fields (VCC_5V example)

| Field | Example | Source |
| --- | --- | --- |
| `localPos` | `{ x: 50, y: 50 }` | Agent/user coordinates — **external**, Y down |
| `libraryName` | `"JupSym"` | `ListSymbolLibraries` → `libraries[].library_name` |
| `symbolName` | `"VCC_5V"` | Desired net label; engine fuzzy-matches within the resolved library |
| `libraryFilePath` | `"…/JupSym.HQSchLib"` | `ListSymbolLibraries` → `libraries[].library_file_path` |
| `kind` | `LIBRARY_SYMBOL_KIND_GLOBAL` | `ListSymbolLibraries` → `symbols[].kind` |
| `netName` | `"VCC_5V"` | Written to instance `"Name"` property; empty = same as `symbolName` |

The response does not report which symbol was actually matched. Read the placed
object's `"Name"` back with `GetObjectProperty` when you need to confirm.

**Do not** use `PlaceSymbol` with `json_symbol: { lib_id: "power:VCC_5V" }` on
the agent path — that is an internal fallback only when `ListSymbolLibraries`
returns no match.

## Wiring After Placement

After any placement RPC, **save `response.object_id`** for every component.
Wire using the saved ids — do not look up power symbols by designator string.

### Routing mode gate (mandatory before every net)

**Agents forget to measure** — they either `autoConnect` everything (long ugly
wires) or stub+alias everything (missing real wires when pins are adjacent).
Run this gate **per net**, after patterns, **before** picking a mode.

```
For each net to wire (pinA on partA ↔ pinB on partB):
  │
  ├─ Already routed inside a pattern (connections[] routed=true)?
  │     → STOP — do not hand-wire
  │
  ├─ Measure: Manhattan ext, L-route length, wire crossing count
  │     (cross-part is OK if pins are close — same gate as same-part)
  │
  ├─ Short hop?  aligned (same X or Y), Manhattan ≤ 300 ext,
  │               L-route ≤ 500 ext, crossings < 3, not a ≥4-node hub net
  │     → autoConnect (preferred — real wire, clean sheet)
  │        e.g. cap→GND beside host, EN→C_EN, nearby LDO.VOUT→MCU.VDD
  │
  └─ Long / crowded / off-page / ≥4 nodes on net
        → dual-end placePinStubWireAndNetAlias (same netName)
           NO autoConnect between these two pins afterward
```

| Situation | Mode | Example |
| --- | --- | --- |
| Two pins close (gate passes short-hop checks) | **autoConnect** | Decap→GND, EN→reset cap, LDO→MCU when placed adjacent |
| Two pins far apart or L-route > 500 / ≥3 crossings | **stub+alias** | Type-C ↔ LDO ↔ ESP when blocks are spaced out |
| Pattern already wired one end | **stub+alias on the other end only** | GPIO9 after `pull_resistor` → SW |
| Replacing a whole pull/reset/decoupling cluster | **pattern** — not stub instead of pattern | CC→R→GND, NRST reset |

**Forbidden (common script bugs):**

- `autoConnect` **without measuring** — the usual mistake on cross-block power nets
- `autoConnect` between far pins, then alias on **one** side only — long wire + duplicate labels
- Skipping `pull_resistor` / `reset_circuit` and using stub+alias for the **whole** R→rail chain
- `autoConnect` as fallback when stub fails — fix pin_name / pinNumber instead
- Hub: one pin `autoConnect` to many targets on the same net

**Script helper:** implement `routeNet(a, pinA, b, pinB, netName)` that **measures
first**, then calls `autoConnectObjectsById` or dual-end stub+alias (`tieFarNet`).
Reserve `tieFarNet()` for nets the gate classifies as long — do not call it blindly
for every cross-part net when placement already put the pins next to each other.

### Circuit pattern first — decision checklist

Before **any** hand placement coordinates, `autoConnect`, or `PlaceWire`, run
this checklist. It applies to the whole sheet and to **each local subnet**
independently (see mixed-circuit decomposition in
[`circuit-pattern-layout.md`](circuit-pattern-layout.md)).

#### Step 0 — Refresh catalog

- [ ] Call `pattern-layout-list-circuit-patterns` (or read the latest catalog).
- [ ] New pattern ids may have been added since the last session — do not rely on
  memory or old scripts alone.

#### Step 1 — Decompose the design

- [ ] List every local cluster (power pin decoupling, single-pin pull-up/down,
  bus interface, crystal, pin shorts, termination R, net aliases, …).
- [ ] Mark each cluster **pattern** or **hand** — independently. A sheet may be
  both.

#### Step 2 — Match clusters to catalog (current shortcuts)

| Local circuit | Pattern id | Skill |
| --- | --- | --- |
| Bypass / decoupling caps on a power pin | `CIRCUIT_PATTERN_DECOUPLING_CAP` | `pattern-layout-apply-circuit-pattern` |
| Pull-up / pull-down resistors (signal → R → rail) | `CIRCUIT_PATTERN_PULL_RESISTOR` | `pattern-layout-apply-circuit-pattern` |
| MCU reset (pull-up + cap + optional button) | `CIRCUIT_PATTERN_RESET_CIRCUIT` | `pattern-layout-apply-circuit-pattern` |
| I2C master + slaves + SDA/SCL pull-ups | `CIRCUIT_PATTERN_I2C_BUS` | `pattern-layout-apply-circuit-pattern` |
| SPI master + slaves | `CIRCUIT_PATTERN_SPI_BUS` | `pattern-layout-apply-circuit-pattern` |
| Crystal + load caps (+ feedback R) | `CIRCUIT_PATTERN_CRYSTAL` | `pattern-layout-apply-circuit-pattern` |

*When new patterns ship, extend this table from `list-circuit-patterns` — the RPC
is the source of truth.*

| Usually **hand** (no catalog entry yet) | Approach |
| --- | --- |
| Cross-module / different parts on one net | Run [Routing mode gate](#routing-mode-gate-mandatory-before-every-net): **autoConnect if short**, stub+NetAlias if long |
| Termination / series R between two signal pins | Same gate — short → autoConnect; far → stub+NetAlias |
| Two pins shorted on one IC | `autoConnect` (same part, short) |
| Off-page / port labels | stub + NetAlias after patterns |

#### Step 3 — Apply patterns (per matching cluster)

- [ ] `pattern-layout-get-page-occupancy` — pick anchors outside reserved boxes.
- [ ] Place parts (rough position is OK for movable roles).
- [ ] `apply-circuit-pattern(plan_only=true)` until anchor is free.
- [ ] `apply-circuit-pattern(plan_only=false)` — book-keep `occupied_box`.
- [ ] Repeat for **each** matching subnet (multiple applies per sheet is normal).

**Same IC, multiple patterns:** allowed when the IC is `host` / `signal_host`
/ `master` (`movable=false`). For **same-polarity pulls to one rail**, prefer
**one** `pull_resistor` apply with multiple `slotIndex` pairs + bound `rail`.
**Not allowed:**
the same **movable** part (one resistor, one cap) bound in two applies. Details:
[`circuit-pattern-layout.md` — Pull resistor: multiple pins](circuit-pattern-layout.md#pull-resistor-multiple-pins).

#### Step 4 — Hand-layout leftovers only

- [ ] Run [Routing mode gate](#routing-mode-gate-mandatory-before-every-net) **for each net**.
- [ ] Do **not** re-wire nets already listed in `response.connections` with `routed=true`.
- [ ] **Short hop (gate pass):** `autoConnectObjectsById` — even between different parts if pins are close.
- [ ] **Long hop (gate fail):** dual-end `placePinStubWireAndNetAlias` (same `netName`).
- [ ] Power symbols: `autoConnect` pin **0** when the rail tap is adjacent; stub+alias when modules are far apart.

If **no** subnet matches any catalog entry, skip Step 3 and hand-layout the
whole local circuit.

Full role / terminal / option catalog and plan-then-apply rules:
[`circuit-pattern-layout.md`](circuit-pattern-layout.md).

**Symbol pin numbers:** for **power / GND / hierarchical port / off-page**
symbols placed via `PlaceSymbolFromLibrary`, the connection pin number in
`AutoConnectObjectsById` is **always `0`** — not `1`. Regular parts (R, C, L,
U, …) use the symbol's printed pin numbers (`1`, `2`, …).

### Decoupling cap example (VCC_5V — C1 — GND)

```typescript
// 1. Place symbols/parts — save object_id from each response
const vccRes = await client.componentPlace.placeSymbolFromLibrary({ /* … */ localPos: { x: 50n, y: 50n }, netName: "VCC_5V" });
const gndRes = await client.componentPlace.placeSymbolFromLibrary({ /* … */ localPos: { x: 50n, y: 100n }, netName: "GND" });
const c1Res  = await client.componentPlace.placePartFromLibrary({ /* … */ localPos: { x: 50n, y: 75n } });

const vccId = vccRes.objectId!;
const gndId = gndRes.objectId!;
const c1Id  = c1Res.objectId!;

// 2. Set properties (optional but recommended)
await client.canvasOps.setObjectProperty({ objectId: c1Id, propKey: "Part Reference", propValue: "C1", op: 1, commitUndo: true });
await client.canvasOps.setObjectProperty({ objectId: c1Id, propKey: "Value", propValue: "0.1 μF", op: 1, commitUndo: true });

// 3. Wire by object_id (preferred — no snapshot needed)
// Symbol pins (VCC, GND, port, off-page): pin number is ALWAYS 0.
await client.canvasOps.autoConnectObjectsById({
  context: projectCtx,
  objectId1: c1Id,  pinNum1: [1],
  objectId2: vccId, pinNum2: [0],
});
await client.canvasOps.autoConnectObjectsById({
  context: projectCtx,
  objectId1: c1Id,  pinNum1: [2],
  objectId2: gndId, pinNum2: [0],
});
```

### Schematic wire routing (avoid overlap)

`AutoConnectObjectsById` routes **each call independently**. If many endpoints
on the same net all connect to one anchor (hub / star topology), the router
reuses the same corridor and wire segments stack visually.

Apply these rules for **any multi-node net** — power, GND, buses, control
signals, or groups of parallel passives — not only decoupling caps.

| Rule | Requirement |
| --- | --- |
| **Separate branch lanes at placement time** | Before wiring, offset each branch along the axis **perpendicular** to the intended bus so taps do not share one column (or row). On a horizontal bus, give each branch a **unique X**; on a vertical bus, a **unique Y**. Spacing can be small but must not be identical. |
| **Chain nodes on the same net** | Connect **two adjacent nodes per call** in sequence: `anchor → n₁ → n₂ → … → nₖ`. This builds a bus with independent vertical (or horizontal) drops instead of re-routing from the anchor every time. |
| **Follow a logical order** | Order the chain by signal or power flow (source → load, input → output, left → right). Keep bus direction consistent across related nets on the same sheet when practical. |
| **Layout is part of routing** | If segments still overlap, **move components** and re-wire — do not stack multiple hub connections from one symbol. |

**Avoid (hub — segments overlap):**

```
NET ──┬── node₁
      ├── node₂
      └── node₃
```

**Prefer (chain — each tap uses its own lane):**

```
NET ── node₁ ── node₂ ── node₃
      │         │         │
     (unique X or Y per branch when dropping off the bus)
```

Minimal pattern:

```typescript
// Same net, sequential links — NOT anchor → every node
for (const [id1, pin1, id2, pin2] of [
  [anchorId, 1, n1Id, 1],
  [n1Id,     1, n2Id, 1],
  [n2Id,     1, n3Id, 1],
] as const) {
  await getSkill("canvas-auto-connect-objects-by-id")!.execute(ctx, {
    context: projectCtx,
    objectId1: id1, pinNum1: [pin1],
    objectId2: id2, pinNum2: [pin2],
  });
}
```

Place the anchor (power symbol, port, or upstream driver) at one end of the
chain; distribute loads/passives along the bus axis with **non-colliding**
coordinates before calling `AutoConnectObjectsById`.

### Stub + Net Alias (long distance / many crossings)

> Use when the [routing mode gate](#routing-mode-gate-mandatory-before-every-net)
> **fails** the short-hop checks. **Short nets still use `autoConnect`** — stub+alias
> is not the default for every cross-part net, only for nets that would draw a long
> or crowded wire.

When two pins are far apart or a direct orthogonal route would cross many
existing wires, **do not** call `AutoConnectObjectsById` between them.
Instead, place **matching `NetAlias` labels** on the same net name at each pin
end — either on a **new short stub** (**30** ext units) or **directly on an
existing wire** already connected to that pin.

```
Pin A ── stub ── NetAlias NET_X          NetAlias NET_X ── stub ── Pin B
          (30)                                   (30)

Pin A ── existing wire ── NetAlias NET_X   (no new stub if wire already on pin)
```

Electrical connectivity comes from two aliases sharing the same `netName` on
the active page — not from a long wire between the pins.

#### When to use (agent heuristics)

**Do not use pin-to-pin Manhattan alone** — routed wire length often exceeds straight
distance when the path wraps around symbol bounding boxes (typical multi-pin IC layouts).

| Condition | Action |
| --- | --- |
| Manhattan distance between pins (ext coords) **> 400** (cross-part / off-page) | Use stub + alias (both pin ends, same `netName`) |
| Estimated **L-shaped** route length (H→V or V→H, shorter variant, including bbox detour) **> 500** | Use stub + alias |
| Proposed L-route crosses **≥ 3** existing `wireSegments` on the active page | Use stub + alias |
| Same net has **≥ 4 nodes** to interconnect | Stub + alias at each pin; **no** hub/star `AutoConnectObjectsById` |
| **Different parts**, pins **aligned**, Manhattan **≤ 300**, L-route **≤ 500**, crossings **< 3** | **`AutoConnectObjectsById`** — cross-part is fine when close |
| **Different parts**, Manhattan **> 400** or L-route **> 500** or crossings **≥ 3** | Dual-end stub + alias |
| Pins **aligned** (same X or same Y), Manhattan **≤ 300**, crossings **< 3** (same or different parts) | `AutoConnectObjectsById` or a single `PlaceWire` |
| **Several signal pins on one IC edge** (see [Dense same-edge pins](#dense-same-edge-pins)) | Prefer `AutoConnectObjectsById` per net to the remote pin; reserve stub + alias for long hops or single-pin parts |

**Stub + alias is symmetric:** call `placePinStubWireAndNetAlias` at **each** pin end
with the **same** `netName`. Do **not** `autoConnect` between the pins and add an alias
on only one side — that leaves long physical wires on the page.

**One routing mode per net:** for a given `(netName, pinA, pinB)` pair, choose **either**
`AutoConnectObjectsById` + alias on the resulting wires **or** dual-end stub + alias —
**not both**. Mixing modes leaves orphan stubs, duplicate NetAlias labels, and ERC noise.

**Never** call `PlaceWire` manually before `placePinStubWireAndNetAlias` to “ensure a
stub exists” — stub creation is the RPC’s job. Manual stubs often duplicate what
`autoConnect` already placed and are not removed automatically.

**List existing wires** before routing: `canvas-list-wire-segments` (active page,
real-time) or `kernel-get-snapshot` → `wireSegments[]`. Endpoints are in
**canvas coordinates (Y up)** — convert to ext before comparing with pin ext
coords, or convert pins to canvas for crossing checks.

**Crossing check (agent reasoning):**

1. Each `wireSegment` is a straight segment `(x1,y1)–(x2,y2)`.
2. Candidate direct route = orthogonal L-path: pinA → corner → pinB (two segments).
3. Segments that share an endpoint do **not** count as crossings; collinear overlap does not add extra crossings.
4. Evaluate both H→V and V→H corners; use the variant with **fewer** crossings. If the minimum is still **≥ 3**, use stub + alias.

#### Pin already has a wire

Before placing a stub at a pin, check whether that pin **already has a wire
segment connected** (from prior `AutoConnectObjectsById`, `PlaceWire`, or manual
editing):

| Pin state | Action |
| --- | --- |
| **No wire** at pin | `obj-place-place-pin-stub-wire-and-net-alias` creates stub + alias (default **30** ext; C++ extends **+10** when stub end hits a **perpendicular** wire; parallel stubs on the same edge are ignored) |
| **Wire already connected** at pin | Same RPC — **no** new stub; alias on existing wire (**30** ext from pin) |

**Detecting an existing connection (intended rule):** `placePinStubWireAndNetAlias`
should set `usedExistingWire=true` **only** when a wire segment **endpoint** matches
**this pin's** connection point (`objectId` + `pinNum`/`pinName` → exact `ex/ey`,
tolerance ≈ `PIN_CONNECT_OFFSET`, **not** one full grid step). A wire merely
passing near an adjacent pin, or attached to a **neighbor pin on the same symbol**,
should **not** count — the engine should create a **new stub** (`wireObjectId > 0`).

Agents mirroring this check: from `canvas-list-wire-segments` or `wireSegments[]`,
require **start or end** coords equal to **that pin's** position (within ~3 ext),
not “any wire on the same row / same escape direction”.

**Observed limitation — pin-level wire detection:** On symbols with **multiple
adjacent signal pins on one edge** (same escape direction, typical **10 ext** grid
spacing), sequential `placePinStubWireAndNetAlias` calls can still attach a NetAlias
to the **wrong physical wire** even when RPC returns `success=true`:

| What you see | Meaning |
| --- | --- |
| `stub=30`, `wireObjectId > 0` on every call | RPC succeeded; stubs were created |
| `stub=0`, `usedExistingWire=true` on later pins | Alias placed on an **existing** segment — verify it belongs to **this** `pinNum` |
| `listWireSegments` near pin *N* lists **other** net names | Physical segment is shared or mis-attached — logical NetAlias may still differ |
| All adjacent pins show the **same** wire `netName` | Nets merged on one stub column — **do not** trust wire names alone |

Reproduction pattern: place distinct `netName` values on **consecutive pin numbers**
on one part (e.g. pins 10–17 → `net1`…`net8` on the active page). Compare NetAlias
labels and `netlist-get-active-page-net-list` to wire `netName` at each pin.

**Root cause (agent diagnosis):** “Detect existing wire” inside
`PlacePinStubWireAndNetAlias` is not always scoped to **(objectId + pinNum + pin
connection point)**; stubs escaping the same way on one edge can overlap or be treated
as shared, so labels land on the wrong segment.

**Engine fix request:** Restrict “wire at pin” to segments whose start **or** end
equals **this pin’s** connection geometry — never any wire on the symbol body or escape row.

**Alias placement on existing wire:**

- Set `localPos` to a point **on the wire**, typically **30 ext units along
  the wire away from the pin** (same spacing as a stub would use), not on the
  symbol body.
- Prefer `attachObjectId = <wire segment canvasObjectId>` so the alias snaps to
  the wire; `attachObjectId = 0` (auto attach) is acceptable when the position
  lies on the segment.
- If the existing wire is very short (< 30 ext units), place the alias at the
  far end of that segment or slightly beyond along the same axis — still **no
  duplicate stub**.

Apply this check **independently per pin** — pin A may need a new stub while pin
B already has a wire and only needs an alias.

#### Stub length and direction

| Item | Rule |
| --- | --- |
| **Length** | **30** ext units initial; C++ extends **+10** ext when stub end hits a **perpendicular** wire (horizontal stub ↔ vertical wire); parallel wires ignored (up to `maxStubLength`, default 300) |
| **Direction** | Extend **away from the symbol body** along the pin escape axis: horizontal pin → ±X; vertical pin → ±Y (ext Y **down**, +Y = downward) |
| **Grid** | Always `snapToGrid: true`; 30 is a multiple of the schematic grid (`GRIDSPACE = 10`) |
| **Avoid** | Do not route stubs through the symbol bounding box — flip direction if blocked |

Pin positions: snapshot `pinInstances[].position` (canvas, Y up) →
`extY = PAGE_SIZE_START_Y - canvasY` (see [`property-conventions.md`](property-conventions.md)).

#### Procedure (one net name, two pins)

For net `NET_X` between pinA and pinB:

1. Resolve pin positions in **external display coordinates**.
2. **Per pin**, list connected wire segments (see [Pin already has a wire](#pin-already-has-a-wire)).
3. **Pin A side** — `obj-place-place-pin-stub-wire-and-net-alias` with `objectId`, `pinNum`/`pinName`, `netName = "NET_X"`, `snapToGrid: true`. The RPC detects existing wire, places stub + alias when needed, and merges wire + alias into **one undo step**.
4. **Pin B side** — same RPC; `netName` **must match** pin A.
5. **Do not** call `AutoConnectObjectsById` between A and B afterward (that defeats the pattern).
6. **Verify** — `kernel-get-snapshot` or `netlist-get-active-page-net-list`: both pins on the same net; run ERC if needed.

```typescript
function manhattanExt(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Measure first — short → wire, long → alias both ends. */
async function routeNet(
  partA: bigint, pinA: { pinNum?: number; pinName?: string; x: number; y: number },
  partB: bigint, pinB: { pinNum?: number; pinName?: string; x: number; y: number },
  netName: string,
) {
  if (manhattanExt(pinA, pinB) <= 300) {
    await client.canvasOps.autoConnectObjectsById({
      context: projectCtx,
      objectId1: partA, pinNum1: pinA.pinNum != null ? [pinA.pinNum] : undefined,
      pinName1: pinA.pinName ? [pinA.pinName] : undefined,
      objectId2: partB, pinNum2: pinB.pinNum != null ? [pinB.pinNum] : undefined,
      pinName2: pinB.pinName ? [pinB.pinName] : undefined,
    });
    return;
  }
  for (const [objectId, pin] of [[partA, pinA], [partB, pinB]] as const) {
    await client.objPlace.placePinStubWireAndNetAlias({
      context: projectCtx, objectId, pinNum: pin.pinNum, pinName: pin.pinName,
      netName, snapToGrid: true,
    });
  }
}
```

#### Relation to other wiring rules

- **Bus / chain nets**: still connect **adjacent** pairs with `AutoConnectObjectsById` when distance and crossings are low; apply stub + alias only on **edges** that fail the heuristics above (signal name = `netName`, e.g. `SCL`, `KEY_IN`).
- **Power / GND**: short taps keep `AutoConnectObjectsById` with symbol pin **0**; long power trees may use stub + alias with `VCC_3V3`, `GND`, etc.
- **Single-point labels**: placing one alias at a junction (e.g. `KEY_IN` at one node) is for **annotation**; stub + alias is for **connecting two distant pins** — one alias per pin end (stub or existing wire), same `netName`.

#### Dense same-edge pins

When **several signal pins on one symbol edge** each need connectivity (same escape
direction, **~10 ext** pin spacing — common on QFP/QFN left/right columns):

**Prefer**

- **`AutoConnectObjectsById`** from each pin to its **remote** counterpart (one net
  at a time), then **one** `placePinStubWireAndNetAlias` per pin to name the wire
  already on **that** pin (`usedExistingWire=true` is OK when the wire came from
  `autoConnect` on the same `pinNum`).
- **Dual-end stub + alias** only when the **other end** is far away **and** this part
  exposes **one pin** for that net on this edge (e.g. a sensor’s single SDA pin).

**Avoid**

- Sequential stub + alias on **every** pin of a dense column without physical routes —
  see [Observed limitation — pin-level wire detection](#pin-already-has-a-wire).
- Pre-drawing a shared bus with `PlaceWire` before labeling — creates orphan segments.
- `autoConnect` between two pins, then alias on **one** side only — long wires + duplicate labels.
- Re-running stub/alias or `autoConnect` on a pin already labeled for that `netName`
  (track `(objectId, pinNum, netName)` and skip duplicates).

**Multi-tap / shared nets (one signal, ≥ 3 parts):**

- Wire **one new segment per tap** (A↔B, then B↔C) or stub + alias at **each** endpoint once.
- After A↔B is done, adding C: connect **only the new segment** (B↔C or A↔C); **do not**
  re-connect A↔B or re-alias pins already done for that `netName`.
- **Wrong pattern:** hub/star `autoConnect` from one pin to many slaves **and** stub +
  alias on the same net — duplicates wires and NetAlias on shared pins.

#### Verifying stub + alias

- **Do not** treat `wireSegments[].netName` as proof of success — physical wire
  net names may differ from the **NetAlias label text** until net refresh completes.
- **Do** confirm `netAliasObjectId > 0` in the RPC response and, after a brief
  retry, that `netlist-get-active-page-net-list` shows both pins on the same logical net.
- **Do** inspect NetAlias label objects (not wire `netName` alone) when debugging
  missing or wrong labels.

#### Known limitations

- **`PlacePinStubWireAndNetAlias` on dense same-edge pins** — see
  [Observed limitation — pin-level wire detection](#pin-already-has-a-wire) and
  [Dense same-edge pins](#dense-same-edge-pins).
- **`listWireSegments` / `wireSegments[].netName` ≠ NetAlias text** — stub + alias
  logical nets may show **zero** wire segments with the alias name; verify with
  NetAlias objects and `netlist-get-active-page-net-list` / ERC.
- `PlaceNetAliasAt` has returned **REFUSED** in some API audits — if alias placement fails, fall back to direct `PlaceWire` between pins and report the failure. See [hqsch-api-slow-and-broken-rpcs.md](../../../docs/issues/hqsch-api-slow-and-broken-rpcs.md).
- Snapshot may lag immediately after placement — retry `kernel-get-snapshot` briefly before verifying net membership.

### Fallback — PlaceWire via snapshot pin lookup

If `AutoConnectObjectsById` fails, call `kernel-get-snapshot`, locate pins via
`pinInstances[].canvas_object_id` (equal to placement `object_id`), convert
canvas Y-up positions to external Y-down coords, then `PlaceWire`.
See [`property-conventions.md`](property-conventions.md) for conversion and retry.

### Enumerating existing wires

| Use case | Preferred skill | Notes |
| --- | --- | --- |
| List wires on the **active page** (real-time) | `canvas-list-wire-segments` | O(page objects); returns `objectId`, canvas-local endpoints, optional `netName`. Use for **pin endpoint** matching and crossing checks — **not** as sole proof that a NetAlias label exists (`netName` on wire ≠ alias text). |
| Batch topology / ERC / BOM pull model | `kernel-get-snapshot` → `wireSegments[]` | Each segment includes `canvasObjectId` + geometry; same id as `canvas-list-wire-segments` when the page is unchanged. |

Do **not** brute-force `canvas-get-objects-json-by-ids` over id ranges to find wires.

## Capability Skill IDs

| Task | Preferred skill |
| --- | --- |
| Search online parts | `eda-part-search` / `search_hqsch_parts` |
| Place R/C/Q/U (online) | `placement-place-kicad-symbol` |
| Place GND/VCC/port/off-page | `placement-place-symbol-from-library` |
| List symbol libraries | `placement-list-symbol-libraries` |
| Known local circuit (I2C / SPI / crystal / decoupling / pull) | `pattern-layout-list-circuit-patterns` → `pattern-layout-apply-circuit-pattern` — see [circuit-pattern-layout.md](circuit-pattern-layout.md) |
| Leftover nets — short hop (gate pass, ≤300 ext, low crossings) | `canvas-auto-connect-objects-by-id` |
| Leftover nets — long hop (gate fail) | `obj-place-place-pin-stub-wire-and-net-alias` at **both** pin ends — see [Routing mode gate](#routing-mode-gate-mandatory-before-every-net) |
| List existing wires (active page) | `canvas-list-wire-segments` |
| Wire via pin coords (fallback) | `kernel-get-snapshot` → `obj-place-place-wire` |
| Wire topology from snapshot | `kernel-get-snapshot` → `wireSegments[].canvasObjectId` |
| Fallback: local part lib | `placement-list-part-libraries` → `placement-place-part-from-library` |
| **Avoid for agents** | `placement-place-part`, `placement-place-symbol` |

## Backend Mapping

| gRPC | SDK |
| --- | --- |
| `PlaceKicadSymbol` | `SCH_PlaceKicadSymbolFromResource` |
| `PlaceSymbolFromLibrary` | `SCH_PlaceSymbolFromLibrary` |
| `PlacePartFromLibrary` | `SCH_PlacePartFromLibrary` |

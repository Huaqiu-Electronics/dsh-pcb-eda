# Circuit Pattern Layout (HQSCH)

Parametric local-circuit layout. The agent identifies a recurring sub-circuit,
places the parts anywhere on the page (position may be rough), binds each part
to a **role**, and calls `ApplyCircuitPattern`. The engine then computes exact
positions / rotations from a LEFT_TO_RIGHT template, optionally adds GND/VCC,
routes intra-pattern nets as collinear stubs + rails, and returns one
`occupied_box` for later avoidance.

Coordinates are the same **external display** space as `Place*` RPCs: page
top-left origin, Y down. See [placement-conventions.md](placement-conventions.md).

> **After every `ApplyCircuitPattern`:** wire leftovers with the [routing mode gate](placement-conventions.md#routing-mode-gate-mandatory-before-every-net).
> **Measure first:** short → **`PlaceWire`** (AI-planned segments); long / crowded → dual-end stub+NetAlias.
> Do **not** use `AutoConnectObjectsById` for agent hand-wiring.

## When to use a pattern vs hand layout

| Use a pattern | Hand-layout instead |
| --- | --- |
| Decoupling / bypass caps on one power pin | One-off geometry that matches no catalog entry |
| Pull-up / pull-down cluster | Cross-module nets after patterns are applied |
| MCU reset (pull-up + cap + optional button) | Simple single-pin pull-up only (use `pull_resistor`) |
| I2C (master + slaves + SDA/SCL pull-ups) | Long-distance leftover nets (stub + NetAlias) |
| SPI (master + slaves, CS lanes) | Parts that must stay exactly where the user put them |
| Passive 2-pin crystal + load caps (+ feedback R) | Active oscillator (4+ pins: VDD/GND/OUT/OE) — **hand layout**, do **not** apply `crystal` |

## Mixed-circuit decomposition

Most real sheets are **not** one catalog entry end-to-end. Before any hand
layout or hand `PlaceWire` pass, **decompose** the design into subnets and classify
each subnet independently.

```
Whole design
  ├─ subnet A  → matches catalog?  → ApplyCircuitPattern
  ├─ subnet B  → matches catalog?  → ApplyCircuitPattern
  └─ subnet C  → no catalog match  → hand layout (gate: short PlaceWire, long stub+NetAlias)
```

### Rules

1. **Per-subnet, not per-sheet.** If subnet A matches `pull_resistor`, apply it
   even when subnet B (e.g. a termination resistor between two bus wires, pin
   short, cross-module net alias) has no pattern.
2. **Do not skip a pattern because another part of the sheet is hand-only.**
   Wrong: “this interface has no dedicated pattern → hand-layout everything
   including obvious pull-ups.”  
   Right: apply `pull_resistor` / `decoupling_cap` / … for every matching
   subnet; hand-layout only the leftovers.
3. **One `ApplyCircuitPattern` call = one catalog entry = one local cluster.**
   Do not try to bind termination resistors, bus transceivers, and pull-ups
   into a single apply unless the catalog explicitly defines that combined
   pattern.
4. **Apply order:** pattern subnets first (each with its own anchor +
   `occupied_box`), then hand leftovers. Re-read `get-page-occupancy` /
   reserved boxes before the next apply.
5. **After apply:** do not re-hand-wire intra-pattern nets listed in
   `response.connections`. Hand work is only for subnets that never entered a
   pattern.

### Same part in multiple patterns

| Role kind | Moved by pattern? | Same part in multiple applies? |
| --- | --- | --- |
| `host`, `signal_host`, `master` | **No** (`movable=false`) | **Yes** — same IC in multiple applies **or** one apply with multiple `slotIndex` pairs (see [Pull resistor: multiple pins](#pull-resistor-multiple-pins)) |
| `cap`, `resistor`, `slave`, `xtal`, … | **Yes** | **No** — each physical part bound to **at most one** pattern |

**Forbidden:** bind the same **movable** part (e.g. one resistor) as `resistor`
in two different applies.

**Allowed:** the same MCU or transceiver as `signal_host` / `host` in several
applies, as long as each apply targets a **different pin or role terminal**
(e.g. pin A pull-up apply + pin B pull-down apply). When several pins share the
**same polarity and the same rail** (e.g. CC1 + CC2 both 5.1k→GND), prefer
**one apply with multiple slot pairs** instead of separate applies.

### Classifying ambiguous subnets

| Electrical shape | Typical pattern | Notes |
| --- | --- | --- |
| One signal pin → one R → VCC | `pull_resistor` `polarity=up` | Bind `signal_host` + `resistor`; optional `rail` or auto-place VCC |
| One signal pin → one R → GND | `pull_resistor` `polarity=down` | Same; optional `rail` = GND |
| One power pin → bulk (+ optional bypass) → GND | `decoupling_cap` | See bulk/bypass bind table below |
| **Dedicated decap module**: N caps in a row, **one** +rail + **one** GND, parallel | **Hand only** (P1 grid + `placeDecapRow` / PlaceWire) | **Do not** use `decoupling_cap` at all in this submodule — see scenario-b `modular-layout.md` §去耦两种拓扑 |
| Master + slaves + SDA/SCL pull-ups | `i2c_bus` | Prefer over separate pull_resistor applies for the I2C cluster |
| Master + slaves + SPI lanes | `spi_bus` | Apply with **`route_mode=NONE`** (layout only); AI routes each `connections[]` entry |
| MCU xin/xout + **2-pin** crystal + load caps | `crystal` | Passive Pierce only |
| 4-pin / active oscillator (VDD, GND, OUT, OE) | **Hand** | Do **not** apply `crystal`. Place and wire by hand (routing gate). |
| MCU reset + pull-up + filter cap (+ button) | `reset_circuit` | Host stub+`reset_net`; internal autoconnect |
| R between **two signal pins** (termination, series) | **Hand** | Not `pull_resistor` (that pattern is signal → R → rail) |
| Two control pins shorted (e.g. RE + DE) | **Hand** | `PlaceWire` + NetAlias if needed |
| Net alias to off-page / MCU port | **Hand** | stub + `placeNetAliasAt` after patterns |

When the catalog grows, call `list-circuit-patterns` again — do not rely only on
the static table below.

## Catalog (call ListCircuitPatterns)

Always call `pattern-layout-list-circuit-patterns` first. The table below is a
shortcut; the RPC is the source of truth for roles / terminals / options.

| `pattern` | `id` | Required roles | Repeatable | Optional roles | Key options (defaults) |
| --- | --- | --- | --- | --- | --- |
| `CIRCUIT_PATTERN_DECOUPLING_CAP` | `decoupling_cap` | `host`(vcc), `cap[0]` bulk, optional `cap_bypass` or `cap[1]` | `cap` 1..8, `cap_bypass` 0..1 | `gnd`, `vcc` | `pitch=8`, `cap_gap=4`, `rail_offset=4`, `gnd_gap=4`, `power_net=VCC`, `power_symbol=VCC` |
| `CIRCUIT_PATTERN_PULL_RESISTOR` | `pull_resistor` | `signal_host`(sig), `resistor[]`(a/b) | both 1..8 | `rail` | `polarity=up\|down`, `pitch=6`, `lane_gap=4`, `rail_gap=4` |
| `CIRCUIT_PATTERN_I2C_BUS` | `i2c_bus` | `master`(sda/scl), `r_pullup_sda`, `r_pullup_scl` | `slave` 0..8 | `vcc` | `lane_gap=3`, `device_gap=10`, `pull_gap=4`, `pull_offset=4`, `sda_net=SDA`, `scl_net=SCL`, `lane_above=true` |
| `CIRCUIT_PATTERN_SPI_BUS` | `spi_bus` | `master`(sck/mosi/miso/cs), `slave[]` | `slave` 1..8 | — | `lane_gap=3`, `device_gap=10`, `share_cs=false`; **default `PATTERN_ROUTE_NONE`** — response `connections[]` lists pending nets (`note=pending AI routing`); agent chooses `PlaceWire` vs dual-end `placePinStubWireAndNetAlias` per [placement-conventions.md](placement-conventions.md) |
| `CIRCUIT_PATTERN_CRYSTAL` | `crystal` | `host`(xin/xout), `xtal`(a/b), `cap_load_1`, `cap_load_2` | — | `r_feedback`, `gnd` | **Passive 2-pin only** — never bind a 4-pin / active oscillator. `layout_origin=host\|anchor`, `osc_in_net=OSC_IN`, `osc_out_net=OSC_OUT`, `host_stub_length=3`, `circuit_stub_length=3`, `cap_gap=4`, `xtal_offset=4`, `cap_spread=2` |
| `CIRCUIT_PATTERN_RESET_CIRCUIT` | `reset_circuit` | `host`(rst), `pull_up`(a/b), `filter_cap`(a/b) | — | `reset_sw`, `vcc`, `gnd` | `layout_origin=host\|anchor`, `reset_net=RESET`, `stub_length=3`, `circuit_stub_length=3`, `pitch=6`, `branch_offset=4`, … |

`host` / `signal_host` are **not moved** (`movable=false`). Power symbols can be
bound (`power_mode=BOUND_ONLY`) or auto-created (`AUTO_PLACE`, default).

`anchor` is an external display point. Exact meaning is in
`descriptor.anchor_semantics` (typically the first device's bottom-left or the
leftmost cap).

`orientation` defaults to `LEFT_TO_RIGHT`. Other values are an affine transform
of the same template — do not rewrite roles.

### Decoupling cap: bulk + optional bypass

Typical LDO/MCU input pairs: **10µF bulk** + **100nF bypass** on the same power
pin. The engine places both caps **vertical**, **same pin-row height**, **parallel
along the host pin outward direction** (e.g. VIN on the right → both caps sit to
the right of the pin, spaced by `cap_gap`).

| Bind | When |
| --- | --- |
| `cap` slot 0 | Always — bulk / filter cap (e.g. 10µF) |
| `cap_bypass` | When the design includes an HF bypass (e.g. 100nF). **Omit the role entirely** when there is no bypass cap. |
| `cap` slot 1 | Legacy alias for bypass (same layout as `cap_bypass`) |

After `ApplyCircuitPattern`, read `response.message`:

- `ok; bulk+bypass caps parallel outward …` — bypass was bound and laid out
- `ok; bulk filter cap only …` — no bypass role bound

After apply, the engine autoconnects `host.vcc → cap[0].a`, `cap.a → rail` (every
cap), and `cap.b → GND`. **Do not duplicate** those nets by hand (e.g. wiring
`host.vcc → each cap.a` or `host.vcc → rail` around the cap bodies).

**Fixing mistakes is OK:** if **check-power-shorts** (below) shows **+rail and GND
share a geometric path**, or a decap **chain layout** shorted rails, you may
**delete the wrong wire segment**, **re-apply** the pattern, or **adjust local
segments** — that is not the same as re-routing nets already marked
`connections[].routed=true` inside a successful apply.

#### check-power-shorts (after each `decoupling_cap` apply)

1. Read `response.connections` and `occupiedBox`.
2. If the cap column is **≥3 caps tall** or `occupiedBox` is **tall and narrow**
   (chain topology), call `listWireSegments` and verify **+rail and GND** are not
   on one reachable path (no cross-rail short).
3. Optional: when engine stdout shows `[PL:route]`, sanity-check wire count vs
   `connections` / `wireObjectIds`; if no log, use snapshot + `wires` only.

See also `docs/troubleshooting-power-nets.md` in the scenario-b skill package.

### Power rail: let the pattern place it

**Do not** hand-place `+5V` / `3V3` / `VCC` on a fixed page side before apply — the
host power pin may be on the opposite side (e.g. LDO VIN on the right). The engine
**auto-places the rail symbol above the cap cluster on the host pin outward side**
and autoconnects `host.vcc → cap[0].a` plus `cap.a → rail`.

| Option | Purpose |
| --- | --- |
| `power_net` | Net label on the auto rail (default `VCC`; use `+5V`, `3V3`, …) |
| `power_symbol` | Library symbol name (default `VCC`) |

Only bind optional role `vcc` when reusing an **existing** rail symbol; otherwise
**omit `vcc`** and let apply create one. Use `power_mode=BOUND_ONLY` with a bound
`gnd` if the design shares one ground symbol; rail is still auto-placed unless
`vcc` is bound.

### Pull resistor: multiple pins {#pull-resistor-multiple-pins}

Up to **8** `(signal_host, resistor)` pairs per apply — same `slotIndex` on both
roles, one shared `polarity`, optional bound `rail` (VCC/GND).

| Case | Do |
| --- | --- |
| N signal pins, same pull direction, same rail | **One apply**, slots `0..N−1`; bind `rail` when reusing an existing power symbol (`power_mode=BOUND_ONLY`) |
| Mixed pull-up + pull-down, or different rails | **Separate applies** |
| Bus with paired pull-ups (e.g. I2C) | Matching **bus pattern** (`i2c_bus`, …) — not N separate `pull_resistor` applies |

One apply merges a single rail connection; repeated applies with `AUTO_PLACE` may
duplicate GND/VCC and hit `AREA_OCCUPIED` near the first cluster.

**Layout:** each resistor offsets from its own `sig` pin (`pitch`), outward from
the host edge (left/right/top/bottom). Multiple pins on the same edge use
`lane_gap` to stagger outward; the engine also nudges if bodies still overlap.

After apply, hand-finish only `response.connections` entries with `routed=false`;
do not re-wire segments already routed.

### Crystal / reset: anchor layout and NetAlias host link

`crystal` is **passive Pierce only**: MCU `xin`/`xout` + a **2-pin** crystal + two
load caps (optional feedback R). A 4-pin / **active** oscillator (VDD, GND, OUT,
OE) is **not** a catalog match — do **not** call `ApplyCircuitPattern` with
`crystal`; hand-place and hand-wire (routing gate).

MCU and the discrete cluster are **never** joined by host↔circuit autoconnect — only
matching **stub + NetAlias** on both sides (avoids long wires and overlap).

| Option | `crystal` (passive 2-pin) | `reset_circuit` |
| --- | --- | --- |
| `layout_origin=anchor` | **xtal pin A** at `anchor`. | **pull_up pin A** (reset hub) at `anchor`. |
| `layout_origin=host` | Cluster extends outward from `host.xin/xout`. | Junction `pitch` grids outward from `host.rst`. |
| Host link (fixed) | `host.xin/xout` + **xtal legs**: stub + NetAlias (`osc_in_net` / `osc_out_net`). | `host.rst` + **pull_up.a**: stub + NetAlias (`reset_net`). |

**Recommended AI flow:** `get-page-occupancy` of the **whole page** → pick an
`anchor` in empty space (see [Pick an anchor from the whole page](#pick-an-anchor-from-the-whole-page)) →
`plan_only=true` → `route_mode=FULL`. For `layout_origin=anchor` on **crystal**,
`orientation` rotates the cluster around `anchor`.

Cluster-internal wiring (xtal↔load caps↔GND, reset R/C/SW) stays **autoconnect**.

### Reset circuit

Topology: **VCC → pull-up → reset net → (switch ∥ filter cap) → GND**. The cluster
is always a compact **vertical textbook stack** (host is stub+NetAlias only, so
the cluster is not rotated to chase the MCU pin):

```
        VCC / +3V3
             |
            [R]          pull-up, pin B up / pin A = hub
             |
      NRST --+----[SW]   optional button immediately beside the hub
             |      |
            [C]     |
             |      |
            GND ----+
```

With `layout_origin=host`, the hub sits `pitch` grids outward from `host.rst`.
With `anchor`, the hub is at `anchor`. The button uses `sw_outward_gap` as a
**short side branch** — it is never shoved past the MCU bbox.

Reset footprint relative to the hub (so a candidate box can be tested, not a
fixed offset from some other circuit): VCC ≈8 grids **up**, cap+GND ≈12 grids
**down**, switch ≈12 grids **right** (`typical_size≈160×160`). Pick the hub
with [whole-page occupancy](#pick-an-anchor-from-the-whole-page) — do not
hard-code “N grids below the crystal” or a constant `(x,y)`.

`power_symbol` is the **library graphic** (default `VCC`). `power_net` is the
label (`+3V3`, `3V3`, …). A voltage-like `power_symbol` (`+3V3`) is treated as a
net; the engine places the VCC graphic and still writes that net name.

Debug log: `%TEMP%\pattern_layout.log` tags `[PL:reset]`, `[PL:crystal]`, `[PL:stub]`.

| Wiring | Mechanism |
| --- | --- |
| Host reset pin | Stub + NetAlias on `reset_net` |
| Pull-up pin A | Stub + NetAlias on same `reset_net` |
| Pull-up, cap, switch, rails | **autoconnect** inside the pattern |

Bind `reset_sw` only when the design includes a reset button. Do not hand-place a
second stub on `host.rst` after apply when stubs were routed.

**4-pin tact switch** (TS-1187A, 6×6 mm, …): pins 1–2 and 3–4 are internally
shorted (常通). The engine binds a **crossing pair** (`1-3` / `1-4` / `2-3` /
`2-4`) so the button actually opens/closes NRST→GND. Leave `pins: []` — do
**not** hand-bind `a=1, b=2`. A 2-pin SPST keeps `a=1, b=2`.

### I2C / SPI bus: autoconnect + spacing

Both patterns use **pin-to-pin autoconnect** (no manual coordinate wires). Slaves
are spaced by **`device_gap` (default 10 grids)** measured between bus pin columns,
not just bbox edges — increase it if MCU and slave bodies look cramped.

**I2C** topology:

- Pull-ups sit **between master and slave** (not on master pin X — SCL/SDA often share the same column)
- `r_pullup_scl/sda` vertical, bottom pin above bus by `pull_offset`; `vcc_offset` lifts 3V3 further
- **Hub topology**: `master.scl/sda → r_pullup_*`, `slave.scl/sda → same r_pullup_*` (not slave→master)
- Slave Y auto-aligns when SDA/SCL pin order is inverted vs master (MPU6050 vs STM32)

**SPI** topology:

- `slave.sck/mosi/miso → master.sck/mosi/miso` (star at master)
- `master.cs → slave.cs` when `share_cs=false`; `slave.cs → master.cs` when shared

Debug log tags: `[PL:i2c]`, `[PL:spi]`, `[PL:connect]`, `[PL:route]` in
`%TEMP%\pattern_layout.log`. Do not hand-wire SDA/SCL/SCK after apply.

## Plan-then-apply

```
list-circuit-patterns
  → get-page-occupancy          # page_box + existing bboxes
  → place parts (rough pos)     # keep out of finished occupied_box areas
  → apply-circuit-pattern(plan_only=true, roles, anchor)
       if AREA_OCCUPIED: pick another anchor from conflicting_object_ids
  → apply-circuit-pattern(plan_only=false, route_mode=NONE for spi_bus)
  → book-keep response.occupied_box
  → for each connections[] with routed=false OR cross-block leftovers:
       run routing gate per net
       short (≤300 ext, low crossings) → PlaceWire
       long / crowded → dual-end placePinStubWireAndNetAlias (same netName)
  → layout other leftovers (power rails: PlaceWire if adjacent, stub+alias if far)
  → kernel-get-snapshot or netlist-get-active-page-net-list
```

Rules:

- **`spi_bus`:** use `PATTERN_ROUTE_NONE` — pattern moves parts only; `connections[]`
  lists SCK/MOSI/MISO/CS intents (`routed=false`, `note=pending AI routing`).
- `plan_only=true` never mutates the canvas. Use it to test anchors.
- `ignore_area_conflict=false` (default) returns `AREA_OCCUPIED` plus
  `conflicting_object_ids` when the planned box hits existing parts.
  **Forbidden** to set `true` just to squeeze a cluster next to another pattern.
- `PATTERN_STATUS_PARTIAL` means layout was kept but some wires failed. Do not
  undo; finish those nets with PlaceWire / stub+alias.
- `PATTERN_STATUS_LAYOUT_FAILED` aborted the undo group — the page is unchanged.
- After a successful apply, treat `occupied_box` as reserved **for placement
  only**: later parts and later patterns must not be placed inside it (plus a
  small grid margin).
  - It is **not** a wiring keep-out. Wires (including stubs out of the host's own
    pins) may cross it; collisions with existing wires are checked by the wire
    helpers, not by this box.
  - It includes the **host part body**. When computing free space around the
    host, subtract the host's own bbox first — otherwise the host's pins look
    blocked and every escape route fails.
- The pattern may **rotate or mirror** cluster parts (e.g. a cap turned 180°),
  so which pin number faces the host is not fixed. After apply, verify by **net
  membership** (`netMembership` / `getActivePageNetList`), never by hard-coded
  pin numbers of the cluster parts; read pin positions with `pinsOf` before
  hand-wiring to them.

## Binding roles

```typescript
await client.patternLayout.applyCircuitPattern({
  context: projectCtx,
  pattern: CircuitPatternId.CIRCUIT_PATTERN_I2C_BUS,
  anchor: { x: 400n, y: 300n },
  orientation: PatternOrientation.PATTERN_ORIENT_LEFT_TO_RIGHT,
  routeMode: PatternRouteMode.PATTERN_ROUTE_FULL,
  powerMode: PatternPowerMode.PATTERN_POWER_AUTO_PLACE,
  planOnly: false,
  roles: [
    { role: "master", objectId: mcuId, slotIndex: 0, pins: [
      { terminal: "sda", pinNumber: "21" },
      { terminal: "scl", pinNumber: "22" },
    ]},
    { role: "slave", objectId: eepromId, slotIndex: 0, pins: [
      { terminal: "sda", pinName: "SDA" },
      { terminal: "scl", pinName: "SCL" },
    ]},
    { role: "r_pullup_sda", objectId: rSdaId, slotIndex: 0, pins: [] },
    { role: "r_pullup_scl", objectId: rSclId, slotIndex: 0, pins: [] },
  ],
  options: { sda_net: "SDA", scl_net: "SCL", lane_gap: "3" },
});
```

Pin resolution order: `pin_number` (string, e.g. `"1"`, `"A5"`) → `pin_name` →
two-terminal default (a=`"1"`, b=`"2"`) → power/port symbols use `"0"`.

Type-C CC pins: bind with `pinNumber: "A5"` / `"B5"` or `pinName: "CC1"` /
`"CC2"` — never coerce alphanumeric numbers to `int`.

## Occupancy bookkeeping

`GetPageOccupancy` returns every part/symbol bbox (and wires if
`include_wires=true`) in external coordinates. Use it to:

1. Floorplan several patterns before placing anything.
2. Choose an `anchor` whose `typical_size` box is empty.
3. After apply, merge `occupied_box` into the agent's reserved-rect list
   (placement only — see the apply rules above).

Empty `area` (all zeros) means the whole page.

### Pick an anchor from the whole page

The agent **reads the entire sheet** and picks a free rectangle. It does **not**
encode “always N grids below circuit X” or a constant `(x,y)`.

1. `get-page-occupancy` with empty `area` (whole `page_box`).
2. **Reserved** = every `items[].bbox` except parts this apply will **move**,
   plus every `occupied_box` already returned by earlier applies.
3. From `list-circuit-patterns`, take `typical_size` and
   `anchor_semantics` (where the hub sits inside that box — e.g. reset hub has
   VCC above and the switch to the right).
4. Scan `page_box` for a rectangle that covers that footprint and does not
   overlap reserved. The empty region may be left / right / above / below /
   elsewhere — whatever the current sheet has free.
5. Host-linked patterns (`crystal`, `reset_circuit`) use stub+NetAlias: **do
   not** prefer “next to the MCU pin”. A tight leftover gap between two
   existing clusters is not a valid slot if the footprint does not fit.
6. `plan_only=true` to confirm. On `AREA_OCCUPIED`, take the next candidate
   from the same scan. `ignore_area_conflict=false`.

## Capability skill IDs

| Task | Skill |
| --- | --- |
| Catalog | `pattern-layout-list-circuit-patterns` |
| Occupancy | `pattern-layout-get-page-occupancy` |
| Dry-run / apply | `pattern-layout-apply-circuit-pattern` |

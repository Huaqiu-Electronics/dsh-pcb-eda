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
> **Measure first:** short → `autoConnect`; long / crowded → dual-end stub+NetAlias.
> Do **not** `autoConnect` far-apart modules without checking distance.

## When to use a pattern vs hand layout

| Use a pattern | Hand-layout instead |
| --- | --- |
| Decoupling / bypass caps on one power pin | One-off geometry that matches no catalog entry |
| Pull-up / pull-down cluster | Cross-module nets after patterns are applied |
| MCU reset (pull-up + cap + optional button) | Simple single-pin pull-up only (use `pull_resistor`) |
| I2C (master + slaves + SDA/SCL pull-ups) | Long-distance leftover nets (stub + NetAlias) |
| SPI (master + slaves, CS lanes) | Parts that must stay exactly where the user put them |
| Crystal + load caps (+ feedback R) |  |

## Mixed-circuit decomposition

Most real sheets are **not** one catalog entry end-to-end. Before any hand
layout or `autoConnect` pass, **decompose** the design into subnets and classify
each subnet independently.

```
Whole design
  ├─ subnet A  → matches catalog?  → ApplyCircuitPattern
  ├─ subnet B  → matches catalog?  → ApplyCircuitPattern
  └─ subnet C  → no catalog match  → hand layout (gate: short autoConnect, long stub+NetAlias)
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
| Master + slaves + SDA/SCL pull-ups | `i2c_bus` | Prefer over separate pull_resistor applies for the I2C cluster |
| Master + slaves + SPI lanes | `spi_bus` | Apply with **`route_mode=NONE`** (layout only); AI routes each `connections[]` entry |
| MCU xin/xout + crystal + load caps | `crystal` | |
| MCU reset + pull-up + filter cap (+ button) | `reset_circuit` | Host stub+`reset_net`; internal autoconnect |
| R between **two signal pins** (termination, series) | **Hand** | Not `pull_resistor` (that pattern is signal → R → rail) |
| Two control pins shorted (e.g. RE + DE) | **Hand** | `autoConnect` + NetAlias |
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
| `CIRCUIT_PATTERN_SPI_BUS` | `spi_bus` | `master`(sck/mosi/miso/cs), `slave[]` | `slave` 1..8 | — | `lane_gap=3`, `device_gap=10`, `share_cs=false`; **default `PATTERN_ROUTE_NONE`** — response `connections[]` lists pending nets (`note=pending AI routing`); agent chooses `autoConnect` vs dual-end `placePinStubWireAndNetAlias` per [placement-conventions.md](placement-conventions.md) |
| `CIRCUIT_PATTERN_CRYSTAL` | `crystal` | `host`(xin/xout), `xtal`(a/b), `cap_load_1`, `cap_load_2` | — | `r_feedback`, `gnd` | `cap_gap=4`, `xtal_offset=6`, `cap_spread=4` |
| `CIRCUIT_PATTERN_RESET_CIRCUIT` | `reset_circuit` | `host`(rst), `pull_up`(a/b), `filter_cap`(a/b) | — | `reset_sw`, `vcc`, `gnd` | `reset_net=RESET`, `pitch=6`, `branch_offset=4`, `branch_gap=4`, `sw_outward_gap=4`, `vcc_gap=4`, `gnd_gap=4`, `stub_length=3` |

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

Do **not** hand-wire between bulk and bypass after apply; autoconnect covers
`host.vcc → cap[0].a`, `cap.a → rail` (every cap), and `cap.b → GND` — one wire
per pin. Never wire `host.vcc → each cap.a` or `host.vcc → rail` by hand: the
first duplicates the cap pin and the second has to detour around the cap bodies.

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

### Reset circuit

Topology: **VCC → pull-up → reset net → (switch ∥ filter cap) → GND**. Layout extends
outward from the bound MCU `host.rst` pin, then stacks **pull-up → optional switch →
cap → GND** on one trunk column (avoids side loops). The reset button body is placed
**further outward** than the trunk (`sw_outward_gap`, default 4 grids) and clamped
clear of the host bbox so 4-pin switch pins do not overlap the MCU or trunk wires.
Optional `reset_sw` binds a momentary button to GND via the cap bottom node.

Debug log: `%TEMP%\pattern_layout.log` tags `[PL:reset]` and `[PL:stub]`.

| Wiring | Mechanism |
| --- | --- |
| Host reset pin | Engine places **short stub + net alias** (`reset_net`, default `RESET`) |
| Pull-up, cap, switch, rails | **autoconnect** inside the pattern |
| Host ↔ pull-up | autoconnect on `RESET` after host stub |

Bind `reset_sw` only when the design includes a reset button; omit the role for
cap-only RC debounce. Use `power_net` / bound `vcc` for the MCU rail name (`3V3`,
`VCC_3V3`, …). Do not hand-place a second stub on `host.rst` after apply.

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
       short (≤300 ext, low crossings) → autoConnect
       long / crowded → dual-end placePinStubWireAndNetAlias (same netName)
  → layout other leftovers (power rails: autoConnect if adjacent, stub+alias if far)
  → kernel-get-snapshot or netlist-get-active-page-net-list
```

Rules:

- **`spi_bus`:** use `PATTERN_ROUTE_NONE` — pattern moves parts only; `connections[]`
  lists SCK/MOSI/MISO/CS intents (`routed=false`, `note=pending AI routing`).
- `plan_only=true` never mutates the canvas. Use it to test anchors.
- `ignore_area_conflict=false` (default) returns `AREA_OCCUPIED` plus
  `conflicting_object_ids` when the planned box hits existing parts.
- `PATTERN_STATUS_PARTIAL` means layout was kept but some wires failed. Do not
  undo; finish those nets with PlaceWire / stub+alias.
- `PATTERN_STATUS_LAYOUT_FAILED` aborted the undo group — the page is unchanged.
- After a successful apply, treat `occupied_box` as reserved. Later placements
  and later patterns must stay outside it (plus a small grid margin).

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
3. After apply, merge `occupied_box` into the agent's reserved-rect list.

Empty `area` (all zeros) means the whole page.

## Capability skill IDs

| Task | Skill |
| --- | --- |
| Catalog | `pattern-layout-list-circuit-patterns` |
| Occupancy | `pattern-layout-get-page-occupancy` |
| Dry-run / apply | `pattern-layout-apply-circuit-pattern` |

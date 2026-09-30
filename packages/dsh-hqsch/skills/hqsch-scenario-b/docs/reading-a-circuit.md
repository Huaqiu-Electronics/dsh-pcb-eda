# Reading a circuit (understanding an existing design)

Use this when the task is **read-only understanding**, not drawing: "what does
VR201 do?", "how is this powered?", "why is this net named X?".

The goal is to reconstruct the **electrical topology plus device semantics**
without hand-parsing wire geometry or guessing.

## The one call that does most of the work

`kernel.GetSnapshot({ context })` returns a **whole-project** snapshot in a
single unary RPC (~1.6 s for 160 parts / 602 wires / 181 nets). It is the
primary data source for circuit understanding.

Measured scope: snapshot nets (181) == `netList.GetProjectNetList` nets (181),
while the current page held only 132 nets. So **snapshot is project-wide, not
page-scoped** — you do not need to walk pages.

| Entity | Count here | What it gives you |
| --- | --- | --- |
| `symbolInstances` | 160 | designator, definitionId, position, rotation, mirrored, **metadata.properties** — includes parts, power globals, **hierarchical ports**, and **off-page connectors** (`designator` = Name) |
| `pinInstances` | 612 | `symbolInstanceId`, `pinDefinitionId`, **absolute position** |
| `nets` | 181 | `name`, `netClass`, `pinInstanceIds[]` |
| `symbolDefinitions` | 58 | `name`, **`pins[]` with `number` + `name`** (pin-number → pin-name table) |
| `wireSegments` | 602 | geometry (rarely needed for semantics) |
| `labels` | (when used) | **NetAlias only** — not `PlaceText` module titles; see `decoration-objects.md` |
| `graphicTexts` / rects | — | **Not populated** in current engine builds; do not use snapshot to find module frames |
| `junctions` | (when used) | wire junctions |
| `noConnects` | (when used) | no-connect markers |

### Pin geometry is **not** inside `symbolInstances`

A common false conclusion: “GetSnapshot has no pin positions.” **`symbolInstances[]`
only carries the symbol body** (`position`, `rotation`, `mirrored`, properties).
It does **not** embed per-pin coordinates.

Pin locations live in the **separate top-level table** `pinInstances[]`:

| Field | Use |
| --- | --- |
| `position` | Absolute pin point (canvas coords, **Y up**) |
| `canvasObjectId` | Same as placement `object_id` / `symbolInstances[].canvasObjectId` |
| `pinDefinitionId` | Join to `symbolDefinitions[].pins[].number` for pin name |
| `symbolInstanceId` | Join to `symbolInstances[].metadata.id` for designator-centric recipes |

**Activity-page scripts** often prefer `getObjectJsonById` → `PortInstScalar` (see
`property-conventions.md` § Pin Coordinates) — same geometry, no three-table join.

**If `pinInstances` is empty or stale** right after placement: retry snapshot (see
§ Kernel Snapshot Lag in `property-conventions.md`), or use `PortInstScalar` /
definition geometry + instance transform. **Do not** treat “no nested pins under
symbol” as “snapshot has no pin API.”

### Enumerating ports / net labels (do not guess names)

**Never** invent candidate names and poll `FindObjectByProperty(Name=…)`. Use one snapshot:

```typescript
const snap = await client.kernel.getSnapshot({ context: ctx });
const s = snap.snapshot!;

// Net aliases — text + owning schematic/page
const labels = (s.labels ?? []).map((l) => ({
  name: l.text,
  schematic: l.schematicName
    ?? l.metadata?.properties?.find((p) => p.key === "schematic_name")?.stringValue
    ?? "",
  page: l.pageName
    ?? l.metadata?.properties?.find((p) => p.key === "page_name")?.stringValue
    ?? "",
}));

// Ports / off-page / power — designator + schematic/page (same property keys)
const ports = (s.symbolInstances ?? []).map((x) => ({
  name: x.designator,
  schematic: x.schematicName
    ?? x.metadata?.properties?.find((p) => p.key === "schematic_name")?.stringValue
    ?? "",
  page: x.pageName
    ?? x.metadata?.properties?.find((p) => p.key === "page_name")?.stringValue
    ?? "",
}));
```

`Label` / `SymbolInstance` proto fields: `schematic_name`, `page_name`.
Until the published SDK regenerates those top-level fields, they are also present as
`metadata.properties` with keys `schematic_name` / `page_name`.

`FindObjectByProperty` is only for **known** names after this enumeration.

### Cross-page / cross-hierarchy port pairing (do not guess)

Different page ports can share one design net **even when names differ**
(e.g. `/TYPE-C` `USB_D+` ↔ `/ESP32-C3FH4` `GPIO18`). That comes from hierarchical
block-pin ↔ port merge on the parent sheet — **not** from GUID matching.

**Never** invent same-name rules for this case. Call:

```typescript
const pairing = await client.netList.getPortPairing({});
for (const p of pairing.pairings ?? []) {
  console.log(
    `${p.portA?.occPath} ${p.portA?.pageName}/${p.portA?.name}` +
    ` ↔ ${p.portB?.occPath} ${p.portB?.pageName}/${p.portB?.name}` +
    ` on ${p.netName} rule=${p.rule}`
  );
}
```

| `rule` | Meaning |
| --- | --- |
| `BY_NAME` | Same-name Off-page / Hierarchical Port within a schematic folder |
| `BY_HIERARCHY` | Parent hierarchical block pin joins child ports (may be **different names**) |
| `BY_GLOBAL` | Design-wide Power / Global name merge |

Recommended flow: `GetSnapshot` (enumerate ports) → `GetPortPairing` (cross-page edges)
→ `GetProjectNetList` only if you need pin membership of the merged net.

### Reconstructing pin → net (verified recipe)

Three joins give the full topology. This was verified end-to-end against VR201:

```typescript
const snap = await client.kernel.getSnapshot({ context: ctx });
const s = snap.snapshot!;

// 1. designator → instance
const sym = s.symbolInstances.find((x) => x.designator === "VR201");
const symId = sym.metadata!.id;                    // e.g. "/-74618591"

// 2. pin-number → pin-name (from the symbol definition)
const def = s.symbolDefinitions.find((d) => d.name === sym.definitionId);
const pinName = new Map(def!.pins.map((p) => [p.number, p.name]));
// → 1=OUTPUT 2=SENSE 3=GND 4=SHDN# 5=VIN

// 3. pin instance → net
const netOf = new Map<string, string>();
for (const net of s.nets)
  for (const pid of net.pinInstanceIds) netOf.set(pid, net.name);

// 4. join
for (const p of s.pinInstances.filter((x) => x.symbolInstanceId === symId)) {
  const pn  = p.metadata!.id;                      // "/-74618591-1"
  const num = p.pinDefinitionId;                   // "1"
  console.log(`pin${num} ${pinName.get(num)} → ${netOf.get(pn) ?? "(unconnected)"} @${p.position}`);
}
```

Output (matches the netlist exactly, and **additionally** shows the
unconnected pin and the physical coordinates):

```
pin1  OUTPUT  → +3.3V        @(1890,670)
pin2  SENSE   → +3.3V        @(1890,660)
pin3  GND     → GND          @(1890,650)
pin4  SHDN#   → (unconnected) @(1770,670)
pin5  VIN     → N0261718     @(1770,660)
```

Key advantages over `netList`:

- **Unconnected pins are visible.** `pin4 SHDN#` shows up here; the netlist
  only lists pins that belong to a net, so floating pins disappear.
- **Absolute pin coordinates**, in kernel canvas coordinates (Y up).
- **`rotation` / `mirrored`** for each instance.

> Beware BigInt: `position.x/y` are `bigint`. `JSON.stringify` throws
> "Do not know how to serialize a BigInt" — pass a replacer:
> `JSON.stringify(v, (_k, x) => typeof x === "bigint" ? String(x) : x)`.

## Device semantics are already in the snapshot — do not fetch datasheets

`symbolInstance.metadata.properties` carries a rich electrical parameter set
harvested from the part database. **Read it before going online.**

Real dump for `VR201`:

```
Datasheet                      = http://file.elecfans.com/.../pYYBAGDuZ16ARrigAALCJORq5X4437.pdf
Description                    = Micropower Low Dropout Regulator with Shutdown,
                                 4.15 to 30 V Vin, 5 V Vout, 5-pin FM (T-5), 0 to 125 degC
MPN                            = LT1129CT-5#06PBF
Manufacturer                   = Analog Devices
dropout_voltage                = 450 mV
input_voltage                  = 30 V, 4.15 V
output_voltage                 = 5 V
output_current                 = 700 mA
supply_current                 = 50 μA
power_supply_rejection_ratio   = 64 dB
topology                       = 正，固定式
features                       = Enable
operating_temperature          = 0 °C, 125 °C
package                        = TO-220-5
huaqiu_pn                      = G7258042
```

For `U202` (MAX202ESE+T) the same mechanism yields `interface=RS-232`,
`data_rate=120 kb/s`, `driver_receiver=2/2`, `supply_voltage=5.5 V`, etc.

**Consequence:** an "is this part appropriate for its net?" check is fully
local. Comparing `output_voltage = 5 V` against the net name `+3.3V` surfaces
the mismatch with zero network access.

Property keys vary by part family (a regulator exposes `topology` /
`dropout_voltage`; a transceiver exposes `interface` / `data_rate`). Treat the
set as open — read the keys, do not assume a fixed schema.

## Which comprehension interfaces actually work

**Canonical map (works / ban / hollow):** [rpc-availability.md](./rpc-availability.md).

Summary: **Snapshot + `netList` is the whole toolbox for comprehension.** Do not
build on `GetConnectivity`, selection, ERC, export, runtime, or `FindNet`
(silent `success:false`). Advanced helpers (`GetObjectsJsonByIds`, `FindObject`,
`GetSelectionNetList`) are optional — not required for Flow B.

Timing baseline: `GetSnapshot` ~1.6–3.2 s for a mid-size project; do not treat
that as a hang.

## Project identification — do not assume the project

`getActiveProject` returns whichever schematic is focused. The project can
change between calls (the user may switch tabs, or the editor may restart).
Always read `projectId` from the response and print it, rather than reusing a
cached one.

Note the active project is identified by **file path** as the id, e.g.
`C:/Users/Administrator/Desktop/kit-dev-coldfire.HQSch`.

The editor instance can also restart (new `instanceId`, new pid), which clears
the live canvas. After a restart the canvas is empty while the saved project
file still holds data — that is expected, not a bug. Re-check
`GetPageOccupancy` before assuming a prior placement persists.

## Practical workflow

1. `project.GetActiveProject` → print `projectId`. Do not cache across tasks.
2. `kernel.GetSnapshot` once — it answers most questions.
3. Build the three maps (designator→instance, pinDef→name, pinInstance→net).
4. For semantics, read `metadata.properties` of the instance.
5. **Neighborhood expansion** — for each pin of the target REF, list other
   members on the same net (grouped by pin). See below.
6. **Optional series traversal** — `TRACE=1` on `read-circuit.ts` to follow
   C/R/L/FB two-terminal bridges to the far-side net. No extra RPC.
7. **Canvas edit ids** — print `metadata.id`, `canvasObjectId`, and
   `FindObjectByProperty(Reference)` for Flow C. See [editing-a-circuit.md](./editing-a-circuit.md).
8. Only if a project is large enough to make the 1.6 s snapshot painful,
   fall back to `netList.GetProjectNetList` (~27 ms) for pure net queries.

## Standard answer template (agent natural language)

When answering "what does REF do?", structure the reply as:

1. **Identity** — `Description` / `MPN` from `metadata.properties`; if empty,
   state definition name only — **do not invent datasheet values**.
2. **Pin → net** — table from snapshot join.
3. **Neighborhood** — per pin, who else shares each net (see next section).
4. **Series links (optional)** — if user asks about coupling/series path, enable
   TRACE or describe C/R/L/FB bridges manually from snapshot.
5. **Consistency flags** — e.g. `output_voltage` vs rail net name.
6. **Role summary** — one paragraph: what this part does **in this local context**.

Template script: `template/scripts/read-circuit.ts` (`REF=VR201`).

## Neighborhood expansion (same-net, 1 hop)

After pin→net for target `REF`:

1. Collect connected nets (exclude `(unconnected)`).
2. For each net, reverse-map `nets[].pinInstanceIds` → designator + pin number/name.
3. **Group by pin** (not flat per net) so "what's on VIN?" is obvious.
4. Remove the target REF's own pins from neighbor lists.
5. **Large net summary** (GND, +5V, …): if >8 pin instances, show netClass,
   total part/pin counts, prefix stats (`C×4, R×2`), and **first 5** representative neighbors.
6. **Role hints** (rule-based, not online): `C*` → bypass/filter cap;
   `R*` → pull/divider; `U*`/`VR*` → active IC; power symbols → rail entry.
7. Attach `Value=` from neighbor `metadata.properties` when present.

Default depth: **1 hop** (same net only). Do not recursively expand every
neighbor's other nets unless the user asks for a subsystem view.

## Series traversal (C / R / L / ferrite bead)

**No new engine RPC.** Build a client-side graph from one snapshot:

| Edge | Rule |
| --- | --- |
| Same net | All pins on net N are mutually reachable |
| Series passive | `C/R/L/FB*` with exactly **2 connected pins on 2 different nets** |

**Do not bridge:**

- Multi-pin ICs (`U*`, `VR*`, …) — stop at net boundary.
- **Shunt decoupling cap** — one leg on GND/VCC/POWER netClass, other on signal:
  list as same-net neighbor only; **do not** traverse into the rail through the cap.
- Optional: stop penetration into huge GND/POWER nets after listing summary.

**BFS** from each pin of target REF (default `maxDepth=2`):

```
+3.3V —[C205 100nF]— NET_MCU_AVDD → U301(14 VDD)
```

Enable in template:

```bash
REF=VR201 TRACE=1 npx tsx scripts/read-circuit.ts
REF=VR201 TRACE=1 TRACE_DEPTH=2 npx tsx scripts/read-circuit.ts
```

Engine-side `GetConnectivity` with `edgeKind=series` would be more authoritative
(P2); skill uses this BFS until then — see [rpc-availability.md](./rpc-availability.md).

## Designator lookup and canvas id mapping

| Step | API / field |
| --- | --- |
| Exact REF | `symbolInstances.find(designator === REF)` |
| Fuzzy | prefix match / substring; print candidates — never guess silently |
| Snapshot join id | `symbolInstance.metadata.id` |
| Canvas mutate id | `canvasObjectId` **or** `FindObjectByProperty("Reference", REF).objectIds[0]` |
| Set designator | `SetObjectProperty` + **`Part Reference`** (not `Reference`) |

After Flow B, carry ids into Flow C — [editing-a-circuit.md](./editing-a-circuit.md).

## When properties are empty

Hand-drawn or non-CIS parts may have no `metadata.properties`:

- Use `symbolDefinitions` pin names + neighborhood topology.
- State uncertainty explicitly.
- **Forbidden:** fabricating voltage/current ratings or MPN from memory.

## Multi-part / subsystem questions

"How is this power block fed?" — expand by **net cluster**, not one REF:

1. Start from regulator VIN/EN nets (Flow B on REF).
2. Run `NET=<name>` mode on upstream nets.
3. Use `TRACE=1` for series elements between rails and loads.
4. Summarize chain: source → filter → regulator → load caps → loads.
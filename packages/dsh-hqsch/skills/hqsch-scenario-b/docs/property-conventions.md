# Object Property Key Conventions (HQSCH)

## Objective

Map common schematic editing terms (designator, value, footprint) to the
`propKey` strings required by `CanvasOpsService` property RPCs. The protobuf
schema only declares `propKey` as a generic `string`; HQSCH uses
vendor-specific key names that differ between **find** and **read/write**
operations.

## Property Key Reference

| Business term | Read / write (`GetObjectProperty`, `SetObjectProperty`) | Find (`FindObjectByProperty`) | Notes |
| --- | --- | --- | --- |
| Designator (位号) | `Part Reference` | `Reference` | **Always use `Part Reference` when setting the designator.** `Reference` and `Designator` do not work for get/set. |
| Net label (电源/全局符号) | `Name` | `Name` | Power symbols (VCC, GND, VCC_5V) store the net label in `Name`. **Part Reference is often empty** — do not use `FindObjectByProperty("Reference", "VCC_5V")`. |
| Value (值) | `Value` | — | Component value (e.g. `10k`, `NCE30P50G`). |
| Footprint (封装) | `Footprint` or `pcbFootprint` | — | Prefer reading back with `GetObjectProperty` to confirm the active key on a given object. |
| Description | `Description` | — | Free-text description when present. |
| MPN | `MPN` | — | Manufacturer part number in symbol properties. |

## Find vs Set Asymmetry

HQSCH maps designator lookup and designator mutation to **different keys**:

1. **Locate** a part by designator → `FindObjectByProperty` with
   `propKey = "Reference"`, `propValue = "Q31"`.
2. **Read or change** the designator → `GetObjectProperty` /
   `SetObjectProperty` with `propKey = "Part Reference"`.

Do not assume the key used for find is valid for set.

## Response Shape Notes

| API | Field | Correct usage |
| --- | --- | --- |
| `FindObjectByProperty` | `objectIds` | Repeated field — use `objectIds[0]`, not `objectId`. |
| `SetObjectProperty` | `op` | Use `OBJ_PROP_SET` (value `1`) for replacement. |
| `SetObjectProperty` | `commitUndo` | Set `true` to record the edit on the editor undo stack. |

## Rename Designator Workflow

1. `project-get-active-project` → build `ProjectContext`.
2. `canvas-find-object-by-property` — `propKey: "Reference"`, `propValue: "<old>"`.
3. Take `objectIds[0]` from the response.
4. Optional: `canvas-get-object-property` — `propKey: "Part Reference"` to confirm current value.
5. `canvas-set-object-property` — `propKey: "Part Reference"`, `propValue: "<new>"`, `op: OBJ_PROP_SET`, `commitUndo: true`.
6. Verify with another `GetObjectProperty` or `FindObjectByProperty`.

## Pin Coordinates and Wiring

After placement, **always save `response.object_id`** from
`PlacePartFromLibrary` / `PlaceSymbolFromLibrary` / `PlaceKicadSymbol`.
Use that id for wiring — not designator strings alone.

### Wiring priority

| Priority | Skill | When to use |
| --- | --- | --- |
| **1 (preferred)** | `canvas-auto-connect-objects-by-id` | You have both placement `object_id`s (works for C1 ↔ VCC/GND power symbols). |
| **2** | `obj-place-place-wire` | After `kernel-get-snapshot` pin lookup via `canvas_object_id`. |
| **3** | `canvas-auto-connect-by-part-reference` | Both endpoints are regular parts with stable `Reference` designators (R/C/U). |
| **Avoid** | Estimated coords (placement Y ± offset) | Never guess pin positions — wires will miss pins. |

For nets with **three or more nodes**, also read
[`placement-conventions.md` — Schematic wire routing (avoid overlap)](placement-conventions.md#schematic-wire-routing-avoid-overlap):
separate branch lanes at placement and chain-connect (do not hub from one anchor).

### Option 1 — AutoConnect by object id (recommended)

Uses the same `object_id` returned by placement RPCs directly — no snapshot
lookup required:

```typescript
// After placing C1, VCC_5V, GND — save each object_id
await getSkill("canvas-auto-connect-objects-by-id")!.execute(ctx, {
  context: projectCtx,
  objectId1: c1ObjectId,
  pinNum1: [1],
  objectId2: vccObjectId,
  pinNum2: [0],   // power / GND / port / off-page symbol → always 0
});

await getSkill("canvas-auto-connect-objects-by-id")!.execute(ctx, {
  context: projectCtx,
  objectId1: c1ObjectId,
  pinNum1: [2],
  objectId2: gndObjectId,
  pinNum2: [0],   // power / GND / port / off-page symbol → always 0
});
```

Proto fields: `object_id_1`, `pin_num_1` (repeated int32), `object_id_2`,
`pin_num_2`.

**Symbol pin numbers:** when either endpoint is a **power / GND / hierarchical
port / off-page** symbol (`PlaceSymbolFromLibrary`), pass **`pinNum: [0]`** for
that side. Do not use `1` — the engine treats symbol connection points as pin `0`.
Regular parts use their printed pin numbers.

### Option 2 — PlaceWire after snapshot pin lookup

Pin positions come from **`kernel-get-snapshot`**, not property RPCs.

**Primary lookup:** `canvas_object_id` — same value as placement
`object_id`. Do not rely on `designator` or `Name` alone (power symbols have
empty Part Reference; duplicate names may exist on one page).

```typescript
const PAGE_TOP = 1400; // PAGE_SIZE_START_Y — page top canvas anchor

function canvasPinToExt(x: bigint, y: bigint) {
  return { x: Number(x), y: PAGE_TOP - Number(y) };
}

function getPinExtByObjectId(
  snap: KernelSnapshot,
  objectId: bigint,
  pinNum: string,
): { x: number; y: number } | null {
  const oid = objectId.toString();
  const si = snap.symbolInstances?.find(
    (s) => String(s.canvasObjectId) === oid,
  );
  if (!si) return null;
  const defId = si.definitionId;
  const symDef = snap.symbolDefinitions?.find((sd) => sd.id === defId);
  const pinInst = snap.pinInstances?.find((p) => {
    if (String(p.canvasObjectId) !== oid) return false;
    const def = symDef?.pins?.find((pd) => pd.id === p.pinDefinitionId);
    return def?.number === pinNum;
  });
  if (!pinInst?.position) return null;
  return canvasPinToExt(pinInst.position.x!, pinInst.position.y!);
}
```

Workflow:

1. `PlacePartFromLibrary` / `PlaceSymbolFromLibrary` → save `response.object_id`.
2. `kernel-get-snapshot`.
3. `symbolInstances.find(s => s.canvasObjectId === object_id)`.
4. `pinInstances` filtered by `canvasObjectId === object_id` and pin number via
   `symbolDefinitions[].pins[].number`.
5. Read `pinInstances[].position` (canvas coordinates, Y **up**), convert, then
   `obj-place-place-wire`.

**Fallback (human-readable only):** match `symbolInstances[].designator` (e.g.
`Q31`) when `canvas_object_id` is unavailable — not reliable for power symbols.

```text
extY = PAGE_SIZE_START_Y - canvasY    // PAGE_SIZE_START_Y ≈ 1400 (page top anchor)
```

`obj-place-place-wire` (`PlaceWire`) uses the **same external display
coordinates** as placement RPCs — page top-left origin, Y **down**. The server
converts internally (`canvasY = PAGE_SIZE_START_Y - extY`).

```typescript
// geometry.start / geometry.end — external display coords
await client.objPlace.placeWire({
  context: projectCtx,
  geometry: {
    start: { x: BigInt(extA.x), y: BigInt(extA.y) },
    end:   { x: BigInt(extB.x), y: BigInt(extB.y) },
  },
  snapToGrid: true,
});
```

Use orthogonal segments (horizontal then vertical) when pins are not aligned.

**Do not use** `canvas-auto-connect-by-part-reference-single-pin` for power
symbols — their `Part Reference` is empty so `partRef2: "VCC_5V"` will not
resolve. Use `canvas-auto-connect-objects-by-id` instead.

**Common mistake:** passing raw `pinInstances[].position` (canvas, Y-up) directly
to `PlaceWire` — wire placement will fail or land off-grid. Always convert first.

**Common mistake:** locating power-symbol pins by `FindObjectByProperty("Reference",
"VCC_5V")` or by snapshot `designator` — use placement `object_id` →
`canvas_object_id` instead.

**Common mistake:** using placement center coordinates ± offset as pin endpoints.

## Kernel Snapshot Lag

`GetSnapshot` may lag the canvas immediately after placement — newly placed
objects may be missing from `symbolInstances` / `pinInstances` / `labels`, or
`canvas_object_id` may not yet be populated. Mitigations:

1. **Prefer `canvas-auto-connect-objects-by-id`** — does not require snapshot.
2. If using snapshot pin lookup, **retry** `kernel-get-snapshot` (e.g. 3–5 times,
   200–500 ms apart) before falling back.
3. For designator state after `SetObjectProperty`, use `GetObjectProperty` /
   `FindObjectByProperty` — not snapshot `designator`.

**Enumerating unknown port / NetAlias names:** use `GetSnapshot` —
`labels[].text` for net aliases, and `symbolInstances[].designator` for
hierarchical ports / off-page / power. Each also carries owning page via
`schematic_name` / `page_name` (top-level after SDK regen, or
`metadata.properties` keys `schematic_name` / `page_name` today).
**Do not** guess candidate names and poll `FindObjectByProperty(Name=…)`.

## Required Capabilities

| Capability | Purpose |
| --- | --- |
| `project-get-active-project` | Resolve active project / `ProjectContext`. |
| `canvas-find-object-by-property` | Locate objects by designator (`Reference`) or net label (`Name`). |
| `canvas-get-object-property` | Read property values (`Part Reference`, `Value`, …). |
| `canvas-set-object-property` | Write property values (`Part Reference`, `Value`, …). |
| `canvas-auto-connect-objects-by-id` | Wire two placed objects by `object_id` + pin numbers. |
| `kernel-get-snapshot` | Pin positions via `canvas_object_id`, net graph. |
| `obj-place-place-wire` | Place wire segments between converted pin coordinates. |

## Critical Guardrails

- Never use `Reference` as `propKey` in `SetObjectProperty` for designator changes.
- Never use `JSON.stringify()` on protobuf responses — use `toJsonString()` from `@huaqiu/hqeda`.
- When `FindObjectByProperty` returns multiple `objectIds`, disambiguate with
  `objTypeFilter` or additional property constraints before mutating.
- Report designators exactly as shown on the schematic (e.g. `Q31`, `U1`).
- Never invent candidate port/NetAlias names to poll `FindObjectByProperty` —
  enumerate via `GetSnapshot` (`labels` / `symbolInstances`) first.

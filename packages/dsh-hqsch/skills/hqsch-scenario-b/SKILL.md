---
name: hqsch-scenario-b
description: >-
  HQ EDA schematic automation for external coding agents (Work Buddy, Codex,
  Claude). Generates TypeScript scripts executed locally against HQ EDA —
  placement, circuit patterns, routing, netlist check, zoom-all, clear page,
  modular grid layout (planCompactZones, repackModules, placeGridFrames),
  read/understand existing designs (GetSnapshot + netList), and surgical local edits
  (Flow C: property / rewire / replace). Invoke when drawing, reading, editing,
  or automating Huaqiu/KiCad schematics without Cursor.
version: 0.2.1
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - schematic
  - placement
  - circuit-pattern
  - modular-layout
---

# HQ EDA — Scenario B Skill

Self-contained skill for **coding agents + local scripts**. All guides ship in `./docs/`.

## For the human installing this skill

See [INSTALL.md](./INSTALL.md).

| Platform | System Prompt file |
| --- | --- |
| Codex CLI | [AGENTS.md](./AGENTS.md) → project root |
| Work Buddy | [CLAUDE.md](./CLAUDE.md) → platform UI or `AGENTS.md` |
| Canonical | [SYSTEM-PROMPT.md](./SYSTEM-PROMPT.md) |

## For the LLM agent

Follow [SYSTEM-PROMPT.md](./SYSTEM-PROMPT.md) in full. The agent **must auto-run** generated scripts in the terminal.

**Read docs in this order:**

| Order | File | Topic |
| --- | --- | --- |
| 1 | [docs/placement-conventions.md](./docs/placement-conventions.md) | Placement, routing mode gate |
| 2 | [docs/circuit-pattern-layout.md](./docs/circuit-pattern-layout.md) | Circuit patterns |
| 3 | [docs/part-search.md](./docs/part-search.md) | Component search |
| 4 | [docs/quickstart.md](./docs/quickstart.md) | connect, context |
| 5 | [docs/property-conventions.md](./docs/property-conventions.md) | Designator, pin coords |
| 6 | [docs/reading-a-circuit.md](./docs/reading-a-circuit.md) | **Read/understand** — snapshot, neighborhood, series traversal |
| 7 | [docs/editing-a-circuit.md](./docs/editing-a-circuit.md) | **Local edit (Flow C)** — diff, blast radius, verify |
| 8 | [docs/rpc-availability.md](./docs/rpc-availability.md) | Which RPCs work / ban list / timing baselines |
| 9 | [docs/troubleshooting-power-nets.md](./docs/troubleshooting-power-nets.md) | Power/net anomalies — geometry before semantics |
| 10 | [docs/serialization.md](./docs/serialization.md) | `toJsonString` + BigInt replacer |
| 11 | [docs/modular-layout.md](./docs/modular-layout.md) | **模块化布局 P0–P4**（模块框 / 最小系统） |
| 12 | [docs/modular-layout-compact.md](./docs/modular-layout-compact.md) | **网格版式 / 两遍收拢 / 网格拉框**（治模块太散、不规则） |
| 13 | [docs/decoration-objects.md](./docs/decoration-objects.md) | Module rect / PlaceText — record objectId (A); not in snapshot |
| 14 | [docs/layout-quality-audit.md](./docs/layout-quality-audit.md) | P4b 数值审计（密度、穿框、网格对齐） |
| 15 | [docs/layout-visual-review.md](./docs/layout-visual-review.md) | save → export PDF 目视验收 |
| 16 | [docs/script-lifetime.md](./docs/script-lifetime.md) | **Process lifetime — must use `hqMain` / `hqMainWithProject`, or node processes leak** |
| 17 | [docs/rpc/](./docs/rpc/) | RPC field reference |

**Runtime (agent executes on user's machine):**

```bash
cd template && npm install && npx tsx scripts/hello.ts
```

HQ EDA desktop must be running with a schematic project open.

> **Every script must enter through `hqMain` / `hqMainWithProject` in
> `scripts/lib/hq.ts`** (per-RPC deadline passed to `connect({ timeoutMs })` +
> deterministic `client.close()` + guaranteed exit). A stalled RPC refs the Node
> event loop and makes the process immortal, so each retry leaks another one.
> See [docs/script-lifetime.md](./docs/script-lifetime.md).

## Execution flow (summary)

**Three task types — pick first:**

- **Draw** a circuit → flow A below.
- **Read / understand** an existing design ("what does VR201 do?") → flow B,
  see [docs/reading-a-circuit.md](./docs/reading-a-circuit.md).
- **Edit locally** ("change C201 to 1 µF", "rewire R5", "replace U3") → flow C,
  see [docs/editing-a-circuit.md](./docs/editing-a-circuit.md).

**Flow A — draw:**

1. Connectivity check (`hello.ts`)
2. **Pattern planning** — list applicable patterns before writing code
3. Generate script: placement → `applyCircuitPattern` → module-internal hand-wire only
4. **Modular whole-page (optional):** P0 `planCompactZones` → P1–P3 → **`repackModules` (P3.5, before cross-module labels)** → P3c stub+NetAlias → P4a **`placeGridFrames`** → P4b `layout-audit.ts` + save + export PDF — see [docs/modular-layout.md](./docs/modular-layout.md) and `template/scripts/modular-lib.ts`
5. Auto-run → retry → verify (pattern status + netlist + zoomAll)

**Flow B — read:**

1. `project.GetActiveProject` → print `projectId` (never assume/cache it)
2. `kernel.GetSnapshot` once — **project-wide**, carries topology + device semantics
3. Join `symbolInstances` + `symbolDefinitions.pins` + `nets.pinInstanceIds`
4. Read `symbolInstance.metadata.properties` for electrical parameters —
   **no need to fetch the datasheet**
5. Neighborhood expansion + optional `TRACE=1` series traversal (C/R/L/FB) —
   `template/scripts/read-circuit.ts`
6. Print canvas edit ids for handoff to Flow C

**Flow C — local edit:**

1. Snapshot locate → define blast radius → **print diff → user confirm**
2. Minimal writes: `SetObjectProperty` / `PlaceWire` / delete+place
3. Re-snapshot + netlist verify — see [docs/editing-a-circuit.md](./docs/editing-a-circuit.md)

## Hard rules (summary)

- Patterns before hand-wiring; do not re-wire `connections[].routed=true`.
- Routing gate per net: short → **`PlaceWire`** (`connectPinsPlaceWire`); long → dual-end stub+NetAlias. **No autoConnect for hand-wiring.**
- Parts: online search + `placeKicadSymbol` — never hand JSON parts.
- Do not bulk-delete without user confirmation after `getSnapshot`.
- End scripts with `zoomAll` for visual verification when appropriate.
- **Modules = functional circuits:** blocks with ≤ 3 parts (reset, BOOT, LED, CC pull-downs…) are never standalone — `attachTo` the connected module, then `mergeSmallModules`. Title inside frame top-left, one-line `note` inside frame bottom-left.
- **Modular grid:** P0 `col`/`order`/`group`（勿平铺一长行）；**P3.5 `repackModules` 必做且在跨模块标签前**；P4a **`placeGridFrames`**；去耦排 **`placeDecapRow`**（全 PlaceWire）；导线 **不得穿模块框**；手布 **禁止 autoConnect**。
- **Coordinates:** `PAGE_TOP` via `calibratePageTop` (never `page_box.max.y`); resize pages only with `setPageExt`; cross-module labels via `placeShortStubAlias` (stub ≤ 40 ext).
- **Comprehension = `GetSnapshot` + `netList`.** `GetConnectivity`, `GetEntity`,
  `RunChecks`, `GetSelection` and `Export*` are **unimplemented** in this engine
  build — do not build flows on them. Full map: [docs/rpc-availability.md](./docs/rpc-availability.md).
- Timing baselines (not SLA): snapshot ~1.6–3.2 s; pattern/place script ~15–20 s.

Full rules: [SYSTEM-PROMPT.md](./SYSTEM-PROMPT.md).

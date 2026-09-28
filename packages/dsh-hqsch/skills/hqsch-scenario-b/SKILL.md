---
name: hqsch-scenario-b
description: >-
  HQ EDA schematic automation for external coding agents (Work Buddy, Codex,
  Claude). Generates TypeScript scripts executed locally against HQ EDA —
  placement, circuit patterns, routing, netlist check, zoom-all, clear page,
  read/understand existing designs (GetSnapshot + netList), and surgical local edits
  (Flow C: property / rewire / replace). Invoke when drawing, reading, editing,
  or automating Huaqiu/KiCad schematics without Cursor.
version: 0.2.0
vendor: Huaqiu Electronics
tags:
  - eda
  - huaqiu
  - schematic
  - placement
  - circuit-pattern
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
| 9 | [docs/serialization.md](./docs/serialization.md) | `toJsonString` + BigInt replacer |
| 11 | [docs/modular-layout.md](./docs/modular-layout.md) | **模块化布局 P0–P4**（最小系统 / 模块框） |
| 12 | [docs/layout-quality-audit.md](./docs/layout-quality-audit.md) | 布局审计指标（勿用 union 占比糊弄） |
| 13 | [docs/script-lifetime.md](./docs/script-lifetime.md) | **Process lifetime — must use `hqMain`, or node processes leak** |

**Runtime (agent executes on user's machine):**

```bash
cd template && npm install && npx tsx scripts/hello.ts
```

HQ EDA desktop must be running with a schematic project open.

> **Every script must enter through `hqMain` / `hqMainWithProject` in
> `scripts/lib/hq.ts`** (per-RPC deadline + hard watchdog + guaranteed exit).
> A stalled RPC pins the Node event loop and makes the process immortal, so each
> retry leaks another one. See [docs/script-lifetime.md](./docs/script-lifetime.md).

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
3. Generate script: host placement → `applyCircuitPattern` → hand-wire leftovers only
4. Auto-run → retry → verify (pattern status + netlist + zoomAll)

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
2. Minimal writes: `SetObjectProperty` / `autoConnect` / delete+place
3. Re-snapshot + netlist verify — see [docs/editing-a-circuit.md](./docs/editing-a-circuit.md)

## Hard rules (summary)

- Patterns before hand-wiring; do not re-wire `connections[].routed=true`.
- Routing gate per net: short → `autoConnect`; long → dual-end stub+NetAlias.
- Parts: online search + `placeKicadSymbol` — never hand JSON parts.
- Do not bulk-delete without user confirmation after `getSnapshot`.
- End scripts with `zoomAll` for visual verification when appropriate.
- **Comprehension = `GetSnapshot` + `netList`.** `GetConnectivity`, `GetEntity`,
  `RunChecks`, `GetSelection` and `Export*` are **unimplemented** in this engine
  build — do not build flows on them. Full map: [docs/rpc-availability.md](./docs/rpc-availability.md).
- Timing baselines (not SLA): snapshot ~1.6–3.2 s; pattern/place script ~15–20 s.
- Scripts enter via `hqMain` / `hqMainWithProject` (`scripts/lib/hq.ts`) — never a bare
  `connect()` + `main().catch()`. Otherwise leaked node processes accumulate on retry.
- `GetPageOccupancy` is on **`patternLayout`**, not `canvasOps`; its response field is
  `items[].objectId` (there is no `objectIds`).
- `GetSnapshot` payloads live one level down: `response.snapshot.symbolInstances`.

Full rules: [SYSTEM-PROMPT.md](./SYSTEM-PROMPT.md).

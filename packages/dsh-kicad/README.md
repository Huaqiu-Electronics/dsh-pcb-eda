# @huaqiu/dsh-kicad

KiCad agent capabilities for DeepSeek Harness, shipped as **one** DSH plugin: the
executable KiCad tools *and* the bundled skills that teach the agent how to use them.
Installing the Huaqiu DSH PCB/EDA bundle makes both available out of the box —
there is no separate skill installation step.

Migrated from the standalone `kicad-agent` repository, which now tracks this package: its
`skills/` tree is kept **byte-identical** to the one below, so picking up an upstream
change is a plain `cp -r` and never a merge. A local test asserts that lockstep.

## What you get

```
@huaqiu/dsh-kicad
├── Tools     10 KiCad tools, registered with ctx.tools.register(defineTool(...))
└── Skills    every skill under skills/, registered with ctx.skills.register(...)
              ├── kicad-ipc               SKILL.md + references/ + 11 python script templates
              └── hardware-design-brief   SKILL.md + 3 reference guides
```

The skill set is data, not code: `src/skills.ts` is the registry, so adding a skill
from `kicad-agent` is a directory copy plus one registry entry. There is no rename and no
translation step — upstream agrees with this package on directory names, skill ids and
language. Exactly one skill (`kicad-ipc`) owns the Python templates the tools execute.

### Tools

| Tool | Script | Effect |
|---|---|---|
| `kicad_ipc_diagnose` | `diagnose_ipc_connection.py` | read |
| `kicad_ipc_verify_live` | `verify_live_ipc.py` | probe (commit dropped) |
| `kicad_pcb_create_track` | `create_track.py` | mutate |
| `kicad_pcb_create_via` | `create_via.py` | mutate |
| `kicad_pcb_create_copper_zone` | `create_copper_zone.py` | mutate |
| `kicad_pcb_add_footprint_from_template` | `add_footprint_from_board_template.py` | mutate |
| `kicad_pcb_move_rotate_footprint` | `move_rotate_footprint.py` | mutate |
| `kicad_pcb_update_selected_track_width` | `update_selected_track_width.py` | mutate |
| `kicad_pcb_refill_zones` | `refill_zones.py` | mutate |
| `kicad_pcb_remove_selected_items` | `remove_selected_items.py` | mutate (needs `confirm`) |

Every tool returns the same envelope:

```jsonc
{ "ok": true,  "script": "create_track", "effect": "mutate", "output": "…" }
{ "ok": false, "script": "create_track", "effect": "mutate",
  "error": { "kind": "FAILED_PRECONDITION", "message": "…" } }
```

`error.kind` is one of `FAILED_PRECONDITION` (KiCad IPC cannot run at all — do not
retry), `UNAVAILABLE` (KiCad unreachable — retry once after checking the environment),
`DEADLINE_EXCEEDED` (timed out), `INVALID_ARGUMENT` (board untouched), `INTERNAL`
(script failed; the commit was dropped).

### Skills

Every directory under `skills/` is registered as a DSH skill, so one installation
delivers the operating guidance along with the tools. Each is progressive-disclosure:
the agent reads `SKILL.md` first and opens `references/` only when the task needs it.

**`skills/kicad-ipc/`** — how to operate KiCad: when to use it, how to inspect current
state, how to verify mutations, and when to stop and ask. It is *not* an IPC API
specification — the tool schemas are the executable interface, the skill is the
reasoning around them. Its `references/ipc-pcb-workflows.md` holds version matrices,
the public CRUD table and failure handling; `scripts/` holds the runnable templates
the tools execute.

**`skills/hardware-design-brief/`** — how to turn a market need into verifiable
requirement documents: staged questioning, the `docs/01-MRD.md` →
`docs/02-hardware-PRD.md` → `docs/03-design-brief.md` chain, and the discipline of
separating confirmed facts from suggestions, assumptions and open questions. It is
knowledge-only: no tools, no scripts. Its three guides (`mrd-guide.md`,
`hardware-prd-guide.md`, `design-brief-guide.md`) are loaded on demand.

The two skills compose: `hardware-design-brief` produces the design inputs,
`kicad-ipc` (and the `kicad_pcb_*` tools) implements them on a real board. Each
skill documents its side of that handoff.

Both are reachable by the agent because each is registered with a `resourceBase`
pointing at its own directory.

## How the plugin is wired

```yaml
# cordis.patch.yml
- insert:
    - id: huaqiu-dsh-kicad
      name: '@huaqiu/dsh-kicad'
      inject: ['skills', 'tools']
```

`inject` must match `export const inject` in `src/index.ts`. `skills` is required —
that is the DSH runtime's own plugin-bundled skill channel (`ctx.skills.register`).
`apply()` registers every bundled skill and the ten tools, and returns a single
disposer. Loading is degraded per skill: a skill that fails to resolve is logged at
error level and skipped, and the rest of the plugin still loads — a broken
`hardware-design-brief` must never take the KiCad tools down with it, and vice versa.

The skills are located relative to the **loaded module**, not the source tree, so one
resolver works for `src/` (tests), `lib/` (built) and an npm install:

```
<package>/lib/index.mjs  ->  <package>/skills  ->  <package>/skills/<skill-id>
```

`skillsDir` / `$DSH_KICAD_SKILLS_DIR` overrides the **root** (`skills/`), not one
skill's directory, so it relocates the whole set at once. `skills` must be in
`files[]` — otherwise npm strips it and every skill resolution fails.

## Runtime requirements

KiCad IPC is not bundled; these are host requirements, the same ones `kicad-agent` had:

- KiCad **9.0+** with the KiCad API service enabled (Preferences → Plugins) and PCB
  Editor restarted, with a `.kicad_pcb` open.
- A Python interpreter with the official `kicad-python` package (`kipy`) whose version
  matches the running KiCad. Configure it with plugin config `pythonPath` or
  `$DSH_KICAD_PYTHON` (default `python3`).
- When KiCad is the EDA host (started through the HQ runtime), KiCad launches
  hq-edge with `$DSH_KICAD_PYTHON` preset to KiCad's **bundled** interpreter (on
  Windows `python.exe` sits next to `kicad.exe`; on macOS it is the
  `Python.framework` copy inside `KiCad.app`) — the interpreter that owns `kipy` —
  so no configuration is needed. The same path is advertised by
  `get_eda_host_info` as the `kicad-python` host executable.
- DSH running with **Full Access** — a non-Full-Access sandbox cannot reach KiCad's
  named pipe on Windows.

`KICAD_API_SOCKET` / `KICAD_API_TOKEN` are injected by KiCad and read by `kipy`. This
package never guesses, hardcodes or scans for them.

### Configuration

| Setting | Env | Default |
|---|---|---|
| `pythonPath` | `DSH_KICAD_PYTHON` | `python3` |
| `skillsDir` | `DSH_KICAD_SKILLS_DIR` | bundled `skills/` (the root holding every skill) |
| `timeoutMs` | — | `30000` |
| `diagnosticTimeoutMs` | — | `15000` |
| `refillTimeoutMs` | — | `150000` |

## Boundaries

- **No HQ Edge dependency.** Unlike `@huaqiu/dsh-eda-host`, this plugin talks to KiCad
  directly: no runtime, executable, service, port, config or artifact dependency, and no
  `@hqedge/*` import.
- **KiCad is the source of truth.** The adapter returns what KiCad said, verbatim. There
  is no second authoritative representation of board state in this package.
- **The scripts own the protocol.** The adapter shells out to the migrated Python
  templates rather than re-implementing KiCad IPC in TypeScript.

## Layout

```
packages/dsh-kicad/
  src/index.ts     # plugin entry: apply() registers every bundled skill + the tools
  src/tools.ts     # 10 defineTool definitions
  src/ipc.ts       # KiCad IPC adapter (script runner + error classification)
  src/scripts.ts   # bundled script registry (the kicad-ipc templates)
  src/skills.ts    # bundled skill registry (ids, summaries, which owns the scripts)
  src/paths.ts     # runtime skills-root + per-skill directory resolution
  src/config.ts    # python interpreter / timeouts
  skills/
    kicad-ipc/
      SKILL.md
      agents/openai.yaml
      references/ipc-pcb-workflows.md
      scripts/*.py
    hardware-design-brief/
      SKILL.md
      agents/openai.yaml
      references/{mrd,hardware-prd,design-brief}-guide.md
  test/            # plugin loading, tool registration, skill discovery, bundling
```

## Tests

```bash
pnpm --filter @huaqiu/dsh-kicad test
```

58 tests covering plugin loading, the disposer, skill discovery, tool registration, argv
construction, pre-flight validation, semantic error mapping and packaging. Execution is
exercised against a fake interpreter, so no KiCad or `kipy` is needed.

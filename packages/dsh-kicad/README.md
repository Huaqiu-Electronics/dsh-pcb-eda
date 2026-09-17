# @huaqiu/dsh-kicad

KiCad agent capabilities for DeepSeek Harness, shipped as **one** DSH plugin: the
executable KiCad tools *and* the `kicad-ipc` skill that teaches the agent how to use
them. Installing the Huaqiu DSH PCB/EDA bundle makes both available out of the box —
there is no separate skill installation step.

Migrated from the standalone `kicad-agent` repository.

## What you get

```
@huaqiu/dsh-kicad
├── Tools     10 KiCad tools, registered with ctx.tools.register(defineTool(...))
└── Skills    kicad-ipc — SKILL.md + references/ + 11 python script templates
```

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

### Skill

`skills/kicad-ipc/SKILL.md` is the agent's operating guidance: when to use KiCad, how to
inspect current state, how to verify mutations, and when to stop and ask. It is *not* an
IPC API specification — the tool schemas are the executable interface, the skill is the
reasoning around them.

Progressive disclosure: `references/ipc-pcb-workflows.md` holds version matrices, the
public CRUD table and failure handling; `scripts/` holds runnable templates. Both are
reachable by the agent because the skill is registered with a `resourceBase` pointing at
its directory.

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
`apply()` registers the skill and the ten tools and returns a single disposer.

The skill is located relative to the **loaded module**, not the source tree, so one
resolver works for `src/` (tests), `lib/` (built) and an npm install:

```
<package>/lib/index.mjs  ->  <package>/skills/kicad-ipc
```

That is why `files[]` must contain `skills` — otherwise npm strips it and `apply()`
throws loudly instead of silently degrading.

## Runtime requirements

KiCad IPC is not bundled; these are host requirements, the same ones `kicad-agent` had:

- KiCad **9.0+** with the KiCad API service enabled (Preferences → Plugins) and PCB
  Editor restarted, with a `.kicad_pcb` open.
- A Python interpreter with the official `kicad-python` package (`kipy`) whose version
  matches the running KiCad. Configure it with plugin config `pythonPath` or
  `$DSH_KICAD_PYTHON` (default `python3`).
- DSH running with **Full Access** — a non-Full-Access sandbox cannot reach KiCad's
  named pipe on Windows.

`KICAD_API_SOCKET` / `KICAD_API_TOKEN` are injected by KiCad and read by `kipy`. This
package never guesses, hardcodes or scans for them.

### Configuration

| Setting | Env | Default |
|---|---|---|
| `pythonPath` | `DSH_KICAD_PYTHON` | `python3` |
| `skillsDir` | `DSH_KICAD_SKILLS_DIR` | bundled `skills/kicad-ipc` |
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
  src/index.ts     # plugin entry: apply() registers skill + tools
  src/tools.ts     # 10 defineTool definitions
  src/ipc.ts       # KiCad IPC adapter (script runner + error classification)
  src/scripts.ts   # bundled script registry
  src/paths.ts     # runtime skill-directory resolution
  src/config.ts    # python interpreter / timeouts
  skills/kicad-ipc/
    SKILL.md
    agents/openai.yaml
    references/ipc-pcb-workflows.md
    scripts/*.py
  test/            # plugin loading, tool registration, skill discovery, bundling
```

## Tests

```bash
pnpm --filter @huaqiu/dsh-kicad test
```

46 tests covering plugin loading, the disposer, skill discovery, tool registration, argv
construction, pre-flight validation, semantic error mapping and packaging. Execution is
exercised against a fake interpreter, so no KiCad or `kipy` is needed.

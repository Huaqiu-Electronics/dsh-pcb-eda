# `kicad-agent` → `dsh-kicad` migration

Spec: `/Users/admin/code/hq-edge/docs/tasks/dsh-kicad-skill-plugin.md`
Date: 2026-09-17 · `dsh-pcb-eda` @ `2f5ac21` · `kicad-agent` @ `29f1e2f`

## 1. What `kicad-agent` actually was

The first inspection result changed the shape of the task. `kicad-agent` is **not a code
repository**. It has no `package.json`, no build system, no TypeScript, no npm dependency
graph — the entire repository is one skill directory:

```
kicad-agent/
└── skills/kicad-ipc-pcb/
    ├── SKILL.md                          (58 lines)
    ├── agents/openai.yaml                (3 lines — display metadata only)
    ├── references/ipc-pcb-workflows.md   (145 lines)
    └── scripts/                          (11 python templates, stdlib + kipy)
```

So there was no "IPC client package" to migrate. The executable surface is the eleven
Python scripts; the knowledge surface is `SKILL.md` + the reference. Everything the spec
asks about "KiCad IPC client implementation / transport / schemas / build outputs"
resolves to *the scripts themselves*, which call `KiCad()` with no arguments and let
`kipy` resolve the endpoint from `KICAD_API_SOCKET` / `KICAD_API_TOKEN` injected by KiCad.

## 2. Migration map

```
kicad-agent component                     -> dsh-kicad destination                    -> decision -> reason
──────────────────────────────────────────────────────────────────────────────────────────────────────────
skills/kicad-ipc-pcb/SKILL.md             -> skills/kicad-ipc/SKILL.md                -> ADAPT    -> spec §7 canonical path; id kicad-ipc-pcb -> kicad-ipc
  ├─ basic boundaries / operating rules   -> preserved verbatim                        -> PRESERVE -> §8, §9: these are the agent's operating principles
  └─ (new) "本技能与工具的配合" section      -> added                                     -> ADAPT    -> §11: skill = reasoning, tools = executable interface
skills/kicad-ipc-pcb/references/…         -> skills/kicad-ipc/references/…             -> PRESERVE -> progressive disclosure; not duplicated into SKILL.md
skills/kicad-ipc-pcb/agents/openai.yaml   -> skills/kicad-ipc/agents/openai.yaml       -> PRESERVE -> host display metadata, zero behaviour
skills/kicad-ipc-pcb/scripts/*.py  (11)   -> skills/kicad-ipc/scripts/*.py             -> PRESERVE -> they ARE the IPC implementation; rewriting = redesign (§27)
scripts/__pycache__/*.pyc                 -> not migrated                              -> REMOVE   -> build junk
(no package.json / build / TS)            -> packages/dsh-kicad/{package.json,…}        -> ADD      -> must look native to dsh-pcb-eda (§4.2)
(no DSH tools)                            -> 10 defineTool tools in src/tools.ts        -> ADD      -> §10, §23: tools use DSH-native registration
(none)                                    -> src/ipc.ts (KiCad IPC adapter)             -> ADD      -> §13: DSH tool -> IPC adapter -> KiCad
(none)                                    -> cordis.patch.yml                           -> ADD      -> §14: bundle manifest row
(none)                                    -> test/ (46 tests)                           -> ADD      -> §23
```

Script → tool mapping is **1:1 preserve with rename** (no split, no merge, no invention):

```
diagnose_ipc_connection.py          -> kicad_ipc_diagnose
verify_live_ipc.py                  -> kicad_ipc_verify_live
create_track.py                     -> kicad_pcb_create_track
create_via.py                       -> kicad_pcb_create_via
create_copper_zone.py               -> kicad_pcb_create_copper_zone
add_footprint_from_board_template.py-> kicad_pcb_add_footprint_from_template
move_rotate_footprint.py            -> kicad_pcb_move_rotate_footprint
update_selected_track_width.py      -> kicad_pcb_update_selected_track_width
refill_zones.py                     -> kicad_pcb_refill_zones
remove_selected_items.py            -> kicad_pcb_remove_selected_items
```

`kipy_common.py` is not a tool — it is the shared helper the others import. It stays a
script resource.

## 3. Key mechanism: how a DSH plugin bundles a skill

Verified in `deepseek-harness`, not assumed:

- `dsh.bundle.patch` / `cordis.patch.yml` only inserts a **Cordis loader row**. It knows
  nothing about skills (`packages/boot/app-boot/src/profile.ts:784-793`).
- Plugin-bundled skills are registered **imperatively** at load time via
  `ctx.skills.register()` — `packages/skill/skill/src/index.ts:439`.
  Runtime-registered skills rank 250, ahead of user/bundled roots
  (`index.ts:25`, `:693-707`).
- Nothing copies skills out at install time; the plugin reads
  `node_modules/<pkg>/skills/...` at `apply()` time, so **`files[]` must include
  `skills`** or npm strips it.
- Validation is `validateRuntimeSkill` (`index.ts:741`): name must match
  `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, `description` must be non-empty, `invocation` may be
  omitted. `resourceBase` is `{ kind: 'directory', path }` and is what lets the agent
  resolve the skill's `scripts/` and `references/` (`index.ts:185-195`).

`dsh-plugin-scout` is the reference for this exact pattern and was copied structurally
(package layout, `files[]`, `apply()` shape) — not its implementation.

## 4. Result

```
packages/dsh-kicad/
├── package.json          @huaqiu/dsh-kicad v0.4.1, files:[lib,src,skills,cordis.patch.yml]
├── cordis.patch.yml      inject: ['skills','tools']
├── tsconfig.json / tsconfig.build.json / tsdown.config.ts
├── src/
│   ├── index.ts          apply(): registers skill + tools, returns disposer
│   ├── tools.ts          10 defineTool definitions
│   ├── ipc.ts            KiCad IPC adapter: script runner + error classification
│   ├── scripts.ts        bundled script registry
│   ├── paths.ts          runtime skill-dir resolution
│   └── config.ts         python interpreter / timeouts
├── skills/kicad-ipc/     SKILL.md, references/, agents/, scripts/*.py
└── test/                 46 tests
```

No HQ Edge dependency of any kind (§3, §21): `inject` is `['skills','tools']`, and there
is no `@hqedge/*` import, no hq-edge port/config/service reference.

## 5. Verification report

Distinguished per spec §25. All commands run from `/Users/admin/code/dsh-pcb-eda`.

### Source-tree verification

| Check | Command | Result |
|---|---|---|
| Package typecheck | `pnpm --filter @huaqiu/dsh-kicad typecheck` | pass |
| Package tests | `pnpm --filter @huaqiu/dsh-kicad test` | **46 passed / 3 files** |
| Whole-repo tests | `pnpm test` | exit 0 (all packages) |
| Publish gate | `pnpm check:publish` | `dsh-kicad … entry/types/exports/patch/clean` OK |

Test coverage (§23): plugin loading (13), tool registration + execution (19), skill
discovery (in plugin.test.ts), bundling/packaging (14).

Execution is exercised against a **fake interpreter** (`test/helpers.ts`) that records
argv and exits with a chosen code. That makes argv construction, cwd, timeout handling
and exit-code → semantic-error mapping deterministic without KiCad.

### Build-artifact verification

| Check | Result |
|---|---|
| `pnpm --filter @huaqiu/dsh-kicad build` | `lib/index.mjs` 36.43 kB, `lib/index.d.mts` 11.07 kB |
| Load `lib/index.mjs` with a Cordis-shaped ctx | 1 skill (`kicad-ipc`) + 10 tools registered |
| Skill dir resolved from the **built** module | `…/packages/dsh-kicad/skills/kicad-ipc` ✓ |
| Skill body loaded | 4975 bytes, description from frontmatter ✓ |
| Tool names vs `kicadToolNames()` | exact match ✓ |
| Disposer | returns cleanly ✓ |
| No `/Users/admin/...` path embedded | ✓ (grep over `src/` and `skills/`) |

### Installed-runtime verification

`pnpm pack` → `huaqiu-dsh-kicad-0.4.1.tgz` (45 140 B), extracted to a scratch directory
with **no source checkout on the path**, dependencies linked as a real install would:

| Check | Result |
|---|---|
| Tarball contains `skills/kicad-ipc/SKILL.md` | ✓ |
| Tarball contains all 11 `.py` scripts | ✓ |
| Tarball contains `references/`, `agents/`, `lib/`, `cordis.patch.yml` | ✓ |
| Tarball contains no `__pycache__` / `.pyc` | ✓ |
| Tarball contains no `test/` | ✓ |
| Load from extraction + `apply()` | skill `kicad-ipc` + 10 tools ✓ |
| Skill dir resolved inside the installed package | `/…/package/skills/kicad-ipc` ✓ |
| `kicad_ipc_diagnose` with no `kipy` present | `ok:false`, `FAILED_PRECONDITION`, clear message — degrades, does not crash ✓ |

### Runtime verification against a live KiCad — NOT PERFORMED

No KiCad instance, no `kipy` (`python3 -c "import kipy"` → `ModuleNotFoundError`) and no
Full-Access DSH sandbox were available in this environment, so §25 items
"verify KiCad IPC connectivity", "perform at least one read operation" and "perform an
existing supported mutation" are **unverified**. What *was* verified is that the tool
degrades to a typed, actionable error rather than crashing — which is the behaviour an
agent sees on a machine without KiCad.

To complete these three checks on a machine with KiCad:

```bash
DSH_KICAD_PYTHON=/path/to/python-with-kipy pnpm launch-dsh
# then: kicad_ipc_diagnose  ->  kicad_ipc_verify_live  ->  kicad_pcb_create_track
```

## 6. Known issues / follow-ups

1. **Pre-existing typecheck failure, not caused by this migration.**
   `pnpm typecheck` at the repo root fails in `packages/dsh-eda-host`:
   `test/netlist.test.ts(351,5): Property 'getPcbSelection' is missing … in type
   'EdaHostClient'`. That file is untouched by this migration (git status shows only
   `pnpm-lock.yaml` modified and `packages/dsh-kicad/` added). Left alone to keep the
   change scoped; it is a one-line fixture addition if you want it fixed.
2. **`/Users/admin/code/kicad-agent` still exists.** It is no longer *required* by
   anything — nothing in `dsh-pcb-eda` references it at build or run time — but the
   repository was not deleted. Deleting another checkout is a destructive action, so it
   is left for you to confirm.
3. **`kicad-python` is an undeclared host dependency.** The original repo had no
   `requirements.txt` or `pyproject.toml`, and adding one was out of scope: the interpreter
   that owns `kipy` is environment-specific (KiCad ships its own on some platforms).
   Documented in the package README instead.
4. **Schematic coverage is absent.** The migrated skill is PCB-only, matching the source.
   §7 permits this for a first version.

## 7. Acceptance criteria (spec §24)

| Criterion | Status |
|---|---|
| `dsh-kicad` exists inside `dsh-pcb-eda` | ✓ |
| `kicad-agent` no longer required; no runtime dependency on its path | ✓ |
| Loads as a normal DSH plugin, follows `dsh-plugin-scout` conventions | ✓ |
| Uses real DSH APIs (`ctx.skills.register`, `ctx.tools.register`, `defineTool`) | ✓ |
| No custom skill framework | ✓ |
| Skill bundled, auto-discovered, no separate install | ✓ |
| Built/published artifact contains the skill | ✓ (verified in the tarball) |
| Existing `kicad-agent` functionality still available | ✓ (all 11 scripts, 1:1 tools) |
| Tools use DSH-native registration, semantic descriptions | ✓ |
| KiCad IPC stays an implementation detail | ✓ (adapter + scripts) |
| KiCad remains authoritative for design state | ✓ (no second representation) |
| No HQ Edge runtime dependency | ✓ |
| Clean build from `dsh-pcb-eda`; artifact installs without the source checkout | ✓ |
| Live KiCad IPC read + mutation | ✗ **unverified** — no KiCad in this environment |

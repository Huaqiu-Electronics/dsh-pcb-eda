# @huaqiu/dsh-pcb-initial-placement

Phase-1 PCB initial-placement skill for DeepSeek Harness, shipped as a
standalone DSH skill plugin.

This package is the extracted `pcb-initial-placement` skill: it used to ride
inside `@huaqiu/dsh-kicad`, which meant installing the KiCad plugin always
installed this skill too. Splitting it out makes the skill independently
installable, and lets each distribution choose for itself:

| Distribution | Choice |
|---|---|
| HQ Edge (headless, `kicad` host) | bundles it — the catalog entry in `release-manifest/plugins-release-manifest.json` is what its packaging discovers |
| Standalone desktop (`@huaqiu/hardware-engineering`) | deliberately not a dependency, so desktop installs stay opt-in |

## What You Get

```
@huaqiu/dsh-pcb-initial-placement
└── Skill    pcb-initial-placement — SKILL.md + references/ + agents/ + scripts/
```

No DSH tools are registered. The skill's executable half is its own Python
helpers (`scripts/*.py`), which the agent runs itself: stage the board through
the KiCad IPC API, fall back to an offline `.kicad_pcb` write only when IPC is
unavailable.

## How The Plugin Is Wired

```yaml
- insert:
    - id: huaqiu-dsh-pcb-initial-placement
      name: '@huaqiu/dsh-pcb-initial-placement'
      inject: ['skills']
```

`skills` is the DSH runtime's plugin-bundled skill registry. `apply()`
registers the skill and returns a disposer.

Resolution is package-relative — `<package>/lib/index.mjs` →
`<package>/skills/pcb-initial-placement` — which is why `files[]` contains
`skills`; otherwise npm would strip the skill from the published artifact.

## Runtime Requirements

- A DSH runtime providing the `skills` service.
- For the IPC path: a running KiCad with the IPC API enabled (see SKILL.md for
  the exact prerequisites and the offline fallback).

# @huaqiu/dsh-hqsch

HQSCH scenario-b agent skill for DeepSeek Harness, shipped as one DSH plugin.
Installing the Huaqiu DSH PCB/EDA bundle makes the `hqsch-scenario-b` skill
available without a separate skill installation step.

## What You Get

```
@huaqiu/dsh-hqsch
└── Skills    hqsch-scenario-b - SKILL.md + SYSTEM-PROMPT.md + docs/ + template/
```

This package intentionally registers no DSH tools. The bundled skill teaches the
agent to generate TypeScript scripts from `template/` and execute them locally
against HQ EDA.

## How The Plugin Is Wired

```yaml
- insert:
    - id: huaqiu-dsh-hqsch
      name: '@huaqiu/dsh-hqsch'
      inject: ['skills']
```

`skills` is the DSH runtime's plugin-bundled skill registry. `apply()` registers
the `hqsch-scenario-b` skill and returns a disposer.

The skill is resolved relative to the loaded module:

```
<package>/lib/index.mjs  ->  <package>/skills/hqsch-scenario-b
```

That is why `files[]` contains `skills`; otherwise npm would strip the bundled
skill from the published artifact.

## Runtime Requirements

The skill's own instructions apply: HQ EDA desktop must be running with a
schematic project open, and the agent runs generated TypeScript scripts from the
bundled `template/` directory.

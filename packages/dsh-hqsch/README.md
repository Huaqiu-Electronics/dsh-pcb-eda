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

## Refreshing the bundled skill (maintainers)

Source of truth lives in the **hq-edge** monorepo (`skills/hqeda/onboarding/scenario-b/`
+ guides + modular-placement docs). From `hq-edge/skills/hqeda`:

```bash
pnpm run build:scenario-b:dsh
```

This rebuilds `skills/hqeda/scenario-b/` and copies it into
`packages/dsh-hqsch/skills/hqsch-scenario-b/` (SKILL frontmatter `name: hqsch-scenario-b`).

> **The DSH bundle is not the upstream folder verbatim.** That command wipes the
> target directory (everything but `node_modules`), so after every sync the
> DSH-only layer must be re-applied:
>
> 1. `docs/script-lifetime.md` and `template/scripts/lib/hq.ts` (the `hqMain` /
>    `hqMainWithProject` runtime shell) — keep them, upstream does not ship them.
> 2. Template script entrypoints — re-wrap them in `hqMain` / `hqMainWithProject`
>    instead of upstream's bare `connect()` + `main().catch()`.
> 3. `SKILL.md` / `SYSTEM-PROMPT.md` (→ `AGENTS.md`, `CLAUDE.md`) — re-add the
>    `hqMain` hard rule, the `docs/script-lifetime.md` reading-list entry and the
>    `@huaqiu/huaqiu-client` `^0.1.9` requirement.
> 4. `template/package.json` — keep `name: hqsch-scenario-b`, `typecheck` and the
>    `^0.1.9` client pin; then refresh `template/package-lock.json`.
>
> `INSTALL.md` carries the same checklist. `pnpm --filter @huaqiu/dsh-hqsch test`
> guards the identity and the prompt content.

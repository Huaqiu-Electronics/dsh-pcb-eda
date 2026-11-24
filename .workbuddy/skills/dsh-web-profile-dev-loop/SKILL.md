---
name: dsh-web-profile-dev-loop
description: Run and iterate on the Huaqiu DSH product plugins through the official DSH web profile instead of building the desktop app — the fast dev/test loop for dsh-pcb-eda. Use when starting the local server (pnpm launch-dsh:standalone), deciding what to rebuild after a change, diagnosing a stale bundle/port/profile, writing headless or stub-driven end-to-end checks against 127.0.0.1:3080, or when someone asks why the desktop branch is only touched at release time.
agent_created: true
---

# Web-profile dev loop (desktop is the release target, not the dev target)

The desktop application is the **release** artifact: it is built from the harness
`desktop` branch, packages an offline bundle, installs an app, and is verified by
activation/distribution fixtures. Using it as the inner loop means minutes per
iteration and a second repo to keep in sync.

The official DSH **web profile** runs the same plugin code from this checkout:

```
dsh-pcb-eda/packages/*/lib  ──(link:)──►  $DSH_HOME/profiles/web  ──►  dsh web  ──►  127.0.0.1:3080
```

Same node rows, same browser bundle, same routes. What disappears from the loop:
desktop build, bundle packaging, app install, signing, and the 24-row activation
fixture that belongs to release verification.

## One command

```bash
pnpm launch-dsh:standalone             # build the 3 product packages, reset the profile, boot
pnpm launch-dsh:standalone --no-build  # boot the current lib/ (host-only edits, docs, tests)
pnpm launch-dsh:standalone --all       # rebuild every workspace package
pnpm launch-dsh:standalone --no-install  # skip the profile pnpm install (links already correct)
```

What the launcher does, in order:

1. Builds `hardware-artifacts`, `dsh-hardware-ui`, `hardware-engineering` — the
   three packages this loop actually edits. Everything else already ships a built
   `lib/`; `--all` is for the rare cross-workspace change.
2. Rewrites `$DSH_HOME/profiles/web/package.json` so `bundles` is exactly
   `dsh-base`, `dsh-web-app`, `@huaqiu/hardware-engineering`, and **deletes** every
   other `@huaqiu/*` dependency. This is what makes the loop idempotent: a previous
   `pnpm launch-dsh` run links every plugin into the profile, which inserts the same
   row ids the bundle inserts and fails boot.
3. Installs the profile so the `link:` resolves to this checkout.
4. Frees port 3080 (a survivor would keep serving the old code) and starts
   `dsh web`.

Prerequisites: the harness repo checked out **as a sibling** (`<code>/deepseek-harness`,
`<code>/dsh-pcb-eda`) and exposing `pnpm dsh`; Node ≥ 22; pnpm 11.

## The inner loop

| Change | Cheapest correct reaction |
|---|---|
| node half (`src/*.ts`), routes, order/export logic | `pnpm --filter ./packages/<pkg> build` → restart the server (rows are composed at boot) |
| browser half (`src/client/*`) | `pnpm --filter ./packages/dsh-hardware-ui build` → reload the tab (client assets are served from disk with `no-cache` + ETag, so no restart is needed; restart anyway if the old bundle persists) |
| a `cordis.patch.yml` row, a new plugin, a new dependency | `--no-install` off: full `launch-dsh:standalone`, because the profile and lockfile change |
| pure unit work | `pnpm --filter ./packages/<pkg> test` — no server at all |
| release checks | `--no-build` is *not* enough: run `pnpm -r typecheck && pnpm -r test` and `node scripts/check-publish.mjs` |

Rules of thumb:

- **Never** `dsh plugin add ./packages/...` into the web profile for dev. It
  duplicates bundle rows. That per-plugin launcher (`scripts/launch-dsh.mjs`) is
  legacy; the bundle launcher is the supported loop.
- **`--no-build` serves whatever is in `lib/`.** If a change "didn't take", check
  the file timestamp before debugging the code.
- Restart when in doubt about host state (routes, rows, settings): the web server is
  cheap to restart, the desktop app is not.
- Keep the tab open on the right panel while editing client code; the panel is
  `keepMounted`, so a reload preserves the selected destination and board.

## Verifying without a human

The web profile is loopback-only and its hardware routes are guarded, so automated
checks are safe and fast:

- **Stub the third party, not the plugin.** For order placing, run a local HTTP
  stub that speaks the eda.cn contract, point `HUAQIU_ORDER_BASE_URL` at it, and
  drive the real service function with a fake `spawnProcess` (KiCad export) and
  `openExternal` (browser hand-off). Assert the *final* URL the UI shows, not the
  backend response string.
- **Headless Chrome against `127.0.0.1:3080`** for layout/state claims: panel
  widths, `canvas` counts, "did a request fire" via the CDP network log. Take a
  narrow and a fullscreen screenshot before calling a UI change done.
- **Do not launch GUI apps or place real orders** in an automated walk. Record the
  argv / opener invocation instead; a real order is a commercial action.

## Pitfalls seen in practice

| Symptom | Cause | Fix |
|---|---|---|
| boot aborts, duplicate ids | profile still links individual plugins | rerun without `--no-install` (the launcher purges them) |
| `412 not-configured` from `/bom`, `/3d`, `/order` | `kicad-cli` not configured in settings | expected gate; configure a KiCad root or skip that stage |
| one test file fails on macOS only | `/var` vs `/private/var` symlink | canonicalize fixture roots with `realpathSync` |
| viewer fixture resolves the wrong board | stray `.kicad_prl` in the fixture dir | remove it; project state must be fixture-owned |
| page served from an old build | `--no-build` after edits, or a server survived the restart | rebuild, then confirm the port was actually freed |
| `unauthorized: artifact is outside the authorized workspace` after switching sessions | host authorized against one process-wide "last discovery", so the other session's workspace replaced it | authorize per `session` (resolved from the session header), keep roots additive, and never send a `.kicad_pro` where a workspace root belongs |
| a full-screen modal "flashes" on load or refresh | it rendered on pre-hydration facts — `configForm` snapshot `status: 'loading'` reads as "not completed", and a store field that is still `undefined` reads as `false` | gate first paint on the sync status (`status !== 'loading'`) **and** on a settled probe; render nothing until both answered |
| panel still shows DSH's "Start" page, or a panel edit "didn't take" | panel chrome lives in the harness (`packages/client/ui-sidebar-right`), and only `lib/client.js` ships | rebuild that package (`pnpm --filter @deepseek-ai/dsh-client-ui-sidebar-right bundle`), then reload; the profile serves `lib/` from disk |
| old panel layout keeps coming back after a default-page change | layouts are persisted per session in `localStorage` under the persistence namespace | bump `dsh.sidebar-right.vN` in `persistence.ts`; a new namespace retires stale layouts instead of migrating them |
| a collapsed right panel shows two overlapping corner buttons | the panel's chrome overlay is a sibling of the dock layout, so it is not covered by dockkit's hidden-docked-item rules | add the overlay to the same slide/visibility/`@starting-style`/reduced-motion rule sets as `[data-dockkit-host='dock']`, so it slides off and hides with the column |
| a chrome control is a no-op, or disappears in fullscreen | its command resolved `document.activeElement` (the button itself names no pane); and the dock host's layer rises 10→40 in fullscreen, painting over a fixed-z overlay | resolve against the on-screen Session explicitly (`commandTarget(null)`) and stack the overlay at `calc(var(--dsh-dockkit-dock-layer) + 1)` |
| smoke runs pollute real state | using the real `DSH_HOME` | use a scratch `DSH_HOME` under `.smoke/` for destructive walks |

## Promotion to release

Only when shipping: bump (`scripts/bump.mjs`), publish the tag, then on the harness
`desktop` branch bump the `@huaqiu/hardware-engineering` pin and run the
distribution/activation verifiers there. Everything before that point stays in this
repo and the web profile.

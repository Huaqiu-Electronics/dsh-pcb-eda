---
name: eda-host-integration
description: "Work on DSH inside an EDA host (HQ EDA or KiCad) without assuming which host is running: host identity, host-mode detection, the host login dialog and the first-run onboarding wizard. Use when editing @huaqiu/dsh-auth, @huaqiu/dsh-eda-host, or a shared hq-edge DSH plugin (edge-bridge / erc), when a login or onboarding flow behaves differently in host vs standalone DSH, or when a single sign-in click opens several host dialogs."
---

# EDA host integration

Two products run DSH: **HQ EDA** and **KiCad**. The same plugin bundle, the same
`@huaqiu/dsh-auth` and the same shared hq-edge plugins ship to both. Anything
that states which editor is running, or that assumes one host's process model,
is a bug — in behavior *and* in text an agent can see.

## 1. Host identity has exactly one owner

`packages/dsh-eda-host` is the only source: its `eda_host_info` tool returns
`identity { hostType, hostName, version }`, resolved from the live host socket.
Everything else consumes it.

- Shared plugins (`hq-edge/apps/server/dsh-plugins/edge-bridge`, `.../erc`) must
  stay host-agnostic. They ship inside both hosts, so a tool description such as
  "the currently active HQ EDA project" makes the agent assert a host that may
  not be running. Write "the currently active project in the running EDA host".
- Same rule for user-visible errors: "No active project in the running EDA host.
  Open a project first." — never "open a project in HQ EDA first".
- Enforce it with a negative assertion in the plugin tests
  (`erc/lib/index.test.ts`): the description must match the current-project
  wording and must NOT match `/HQ EDA|Huaqiu|KiCad/i`.
- Do not "fix" host confusion by guessing from `process.env` inside a plugin.
  If a flow needs the host name, ask `dsh-eda-host`.

## 2. Host mode vs standalone

`isHostMode()` in `@huaqiu/dsh-auth` decides every host-only behavior.

- Host mode = DSH embedded in an EDA editor; the host owns credentials and
  dialogs. Standalone DSH = the desktop deployment, which already has a visible
  sign-in entry point.
- The first-run onboarding wizard lives in `src/client/ui/onboarding-wizard.tsx`
  and is registered on `shell.overlay` **only** in host mode. Standalone must
  never show it — there is nothing for it to add.
- Both wizard buttons ("Sign in" and "Create account") call `auth.login()`.
  The host login dialog handles both cases; the plugin must not distinguish them.
- The checkbox is **machine-scoped**, not launch-scoped: "Don't show this
  anymore". Checking it suppresses the wizard for this PC forever.
- Persistence cannot use `localStorage`: every launch assigns a different
  hq-edge port, so the origin (and therefore storage) changes. Store the
  preference node-side at `~/.dsh/auth/onboarding.json` (separate from
  `session.json`, so sign-out does not erase it), served by
  `GET/POST /api/v1/huaqiu/auth/onboarding`, exposed as
  `auth.isOnboardingSuppressed()` / `auth.suppressOnboarding()`. Read the
  preference before rendering so the wizard never flashes for a user who opted out.

## 3. One sign-in click, one login dialog

The dialog is opened by the EDA host, not by DSH. The layers each own one
invariant (details and code anchors: `references/host-integration.md`):

| Layer | Invariant |
|---|---|
| `@huaqiu/dsh-auth` client | `auth.login()` is single-flighted per webview (sidebar, wizard and needs-auth cards share one request) |
| hq-edge `auth/controller.ts` | one in-flight attempt; repeated POSTs join the dialog already on screen; a dismissal resolves the request immediately (`loginFromUserEntry`) |
| KiCad `HQ_RUNTIME` | one login dialog per **process**, across all editor frames (`TryBeginLoginDialog` / `EndLoginDialog`) |
| KiCad `HQ_AUTH_SERVICE` | one dialog per RPC (generation counter) and exactly one handler presents it (`dialogShown` + `break`) |

Do not add a machine-level or cross-process gate. When the project manager
opens sch/pcb, those editors are frames of the same process; the runtime slot
already covers every frame. A machine-wide lock would additionally suppress a
legitimate sign-in from a *separate* KiCad instance (another project), which is
the wrong trade-off.

Cancellation is the hard case: wx modal dialogs run a nested event loop, so a
trigger queued behind the open dialog runs *after* the handler guard has no
effect. The runtime slot therefore also keeps a short post-dismissal grace
window (800 ms) and reports `BUSY` while a dialog is up and
`RECENTLY_DISMISSED` right after. `BUSY` must publish nothing (the open dialog
settles the waiters); `RECENTLY_DISMISSED` must publish the current state so
that frame's bridge request settles instead of hanging for five minutes.

Regression tests: `kicad/hq/runtime/tests/test_auth_service.cpp`
(`TriggerLoginDialogCancelledShowsExactlyOneDialog`,
`TriggerLoginDialogQueuedTriggerAfterCancelIsCoalesced`).

## 4. Packaging split (context)

Skills that hq-edge must bundle live in `release-manifest/plugins-release-manifest.json`;
the desktop bundle (`packages/hardware-engineering`) must not contain them.
`pcb-initial-placement` was moved out of `dsh-kicad` into the standalone
`@huaqiu/dsh-pcb-initial-placement` for exactly this split — see
`../huaqiu-desktop-offline-bundle/SKILL.md` before changing package counts.

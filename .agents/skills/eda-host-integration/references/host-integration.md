# EDA host integration — code anchors

Verified against the working trees of `dsh-pcb-eda`, `hq-edge` and `kicad`.

## Host identity

- `dsh-pcb-eda/packages/dsh-eda-host/src/tools.ts` — registers the host-info
  tool; the returned `identity.hostType` / `identity.hostName` are the only
  authoritative statement of which editor is running.
- `dsh-pcb-eda/packages/dsh-eda-host/src/types.ts` — `EdaHostType`,
  `EdaHostInfo.identity`.
- Shared plugins that must stay host-agnostic:
  - `hq-edge/apps/server/dsh-plugins/edge-bridge/lib/index.js`
  - `hq-edge/apps/server/dsh-plugins/erc/lib/index.js` (tool descriptions)
  - `hq-edge/apps/server/dsh-plugins/erc/lib/client.js` (error copy)
- Test guard: `hq-edge/apps/server/dsh-plugins/erc/lib/index.test.ts`
  ("every tool carries an LLM-oriented description" — asserts the current
  project wording and the absence of `HQ EDA | Huaqiu | KiCad`).

## Host mode and onboarding

- `dsh-pcb-eda/packages/dsh-auth/src/client/ui/onboarding-wizard.tsx` —
  host-only overlay, `dismiss()` for ×/Esc/skip, `optOut()` writes the machine
  preference, both buttons call `auth.login()`.
- `dsh-pcb-eda/packages/dsh-auth/src/client/auth-state.ts` — `resolved` keeps
  the first frame from flashing the wizard before the host session is known.
- `dsh-pcb-eda/packages/dsh-auth/src/client/transport.ts` — `triggerLogin`,
  `HostLoginDismissedError` (401 = dismissed, not an error),
  `fetchOnboardingSuppressed` / `suppressOnboarding`.
- `dsh-pcb-eda/packages/dsh-auth/src/routes.ts` —
  `/api/v1/huaqiu/auth/onboarding`, `~/.dsh/auth/onboarding.json`.
  Deliberately not `localStorage`: the hq-edge port changes every launch, so
  the storage origin is not stable.

## Login dialog chain

1. Browser: `dsh-auth` `client.login()` → `POST /api/v1/auth/login`
   (`src/client/client.ts`, single-flight `inflightLogin`).
2. DSH node: `src/routes.ts` forwards to hq-edge.
3. hq-edge: `apps/server/src/auth/controller.ts` —
   `triggerLoginAndWaitForChange()` / `loginFromUserEntry()`; one attempt per
   dialog, `settleOnDismiss` so a cancel returns 401 immediately instead of
   holding a browser connection for `DEFAULT_LOGIN_WAIT_MS`.
4. KiCad gRPC: `hq/runtime/src/hq_auth_service.cpp` — generation snapshot
   (`arrivedGeneration`), process-wide slot
   (`m_runtime->TryBeginLoginDialog()`), one handler loop with `dialogShown`.
5. Editor frame: `hq/runtime/src/hq_handler.cpp` → per-editor
   `ShowLoginDialog()` (`eeschema/hq/hq_handler_sch.cpp`,
   `pcbnew/hq/hq_handler_pcb.cpp`, `kicad/hq/hq_handler_manager.cpp`).

`HQ_RUNTIME::TryBeginLoginDialog()` / `EndLoginDialog(bool)` live in
`hq/runtime/{include/hq_runtime.h,src/hq_runtime.cpp}`:
- `m_loginDialogOpen` is taken *before* `ShowModal()`, so a nested event-loop
  trigger cannot open a second modal.
- `m_loginDialogClosedAtMs` starts a 800 ms grace only when a dialog was really
  shown; `BUSY` → publish nothing, `RECENTLY_DISMISSED` → publish current state.

## Failure modes already ruled out

- hq-edge missing single-flight: covered by `controller.test.ts`.
- KiCad falling through to the next handler after a cancel: covered by
  `dialogShown` + `TriggerLoginDialogCancelledShowsExactlyOneDialog`.
- Multiple triggers queued behind an open dialog: covered by
  `TriggerLoginDialogQueuedTriggerAfterCancelIsCoalesced`.

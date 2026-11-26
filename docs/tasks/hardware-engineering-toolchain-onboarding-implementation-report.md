# Hardware-Engineering toolchain onboarding & download — implementation report

Spec: [`hardware-engineering-toolchain-onboarding-configration-and-download-spec.md`](./hardware-engineering-toolchain-onboarding-configration-and-download-spec.md)
Scope delivered: M1–M8 in this repository, verified through the DSH **web profile**.
**M9 (desktop packaging / Windows installer verification) is explicitly out of scope for this
pass — the user runs it manually.** Everything below that depends on a packaged build is
marked as such rather than claimed.

---

## 1. Where the work lives

Host (`@huaqiu/hardware-artifacts`):

| File | Role |
|---|---|
| `src/toolchain/resolve.ts` | **The only** path parser/validator (§10.5 forbids a second one) |
| `src/toolchain/manifest.ts` | `agent-toolchains.json` fetch + schema/entry validation |
| `src/toolchain/zip.ts` | Streaming ZIP reader (EOCD scan, ZIP64, stored/deflate/LZMA, safety, limits) |
| `src/toolchain/lzma.ts` | LZMA1 decoder for method 14 (8 of 10 of the real KiCad entries) |
| `src/toolchain/install.ts` | Download → verify → extract → layout → promote → validate, as a polled job |
| `src/toolchain/discovery.ts` | Bounded candidate roots, probing, deterministic ranking |
| `src/toolchain/dialog.ts` | Probe's own native file chooser (Win PowerShell/WinForms, macOS JXA, Linux zenity/kdialog) |
| `src/toolchain/manager.ts` | Single state source: status / save / validate / browse / install / cancel / capabilities |
| `src/routes.ts` | `/api/v1/hardware/toolchain/{status,capabilities,job,validate,save,browse,install,cancel,discover}` |
| `src/index.ts` | Volatile toolchain config fields, manager wiring, `hardwareToolchains` service |
| `src/service.ts` | `installations()` and `environmentText()` now resolve through the shared parser |

Browser (`@huaqiu/dsh-hardware-ui`):

| File | Role |
|---|---|
| `src/client/toolchain.ts` | `ToolchainController`: one shared state machine + snapshot + notices |
| `src/client/toolchain-view.tsx` | The install card in both prototype variants (`wizard` / `settings`), notice overlay, sidebar dot |
| `src/client/wizard.tsx` | First-run modal on `settings.onboarding`, `onboardingPhase` gate, `saveReady`, stable `useFormValue` |
| `src/client/components.tsx` | Settings section, now the two shared cards |
| `src/client/transport.ts` | Toolchain route calls, same error-envelope mapping as the rest |
| `src/client/copy.ts` · `src/client/locales.ts` | Prototype copy for both surfaces (cycle test forbids unreferenced keys) |

---

## 2. M1 — Source map (where each requirement hooked into DSH)

No host file was modified **except** the product plugin itself (`hardware-artifacts`,
`dsh-hardware-ui`). The harness was read, not changed.

| Need | DSH surface used | Why this one |
|---|---|---|
| Persisted configuration | `hostService('settings')` (`update(ns, patch)`), namespace `hardware-artifacts` | The product already persisted through it; a second store is a §18 prohibition |
| Client-side config form | `ctx.configForms.get(HARDWARE_CONFIG_ENTRY)` | Gives the wizard a `set()` + snapshot with a real sync status |
| Subprocess | `execFile` inside the plugin (version probe, dialog helper) | Probe already owned this; no new harness hook |
| Native file chooser | **plugin-owned** (`src/toolchain/dialog.ts`) | `ctx.directoryPicker` picks *directories* only; teaching it files needs koffi `SetFileTypes` marshalling — larger and riskier than a per-OS dialog in the plugin |
| Notifications | `shell.overlay` (root list slot), self-drawn toast | The seat exists for exactly this; the product's client bundle declares no primitives dependency |
| Sidebar status | `sidebar.footer.action` (list slot) | `sidebar.toggle.badge` is **single** and owned by `DesktopUpdateBadge`; competing for it would break an unrelated indicator |
| First-run wizard | `settings.onboarding` step (`id: hardware-engineering-toolchain`, `order: 12`) | The shell mounts exactly one ordered step on a blank first session and lets the step paint its own chrome; the previous panel drawer could not express "appears by itself" |
| Settings panel | `settings.section` (id `hardware-engineering`, order 85) | Unchanged seat, new body |
| Agent capability | `ctx.provide('hardwareToolchains')` + compact `capabilities()` | §12 wants no absolute paths in agent-facing text |
| Dev loop | `pnpm launch-dsh:standalone` (web profile) | Desktop packaging is the release artifact, not the inner loop |

Two deliberate **non**-changes: no `directory-picker-native` file support, no new client runtime
dependency (toast is drawn by the plugin).

---

## 3. Decisions worth knowing

1. **One controller, two surfaces (§10.5).** `ToolchainController` is created once in the client
   `apply()` and injected into the panel, the Settings section, the onboarding step, the overlay
   and the footer dot. It owns the poll, the drafts, the job mirror and the notices; every surface
   renders from its snapshot. Nothing decides "configured" locally.
2. **Green is earned.** A tool is `configured` only after the Host resolved an executable *and*
   it answered a version probe. Discovery results are evidence, never configuration.
3. **Skip ≠ complete, and one flag says which.** `toolchainSetup: 'deferred' | 'complete'` is the
   only record. Skipping writes `deferred` so the step stops interrupting while the sidebar dot and
   Settings keep saying setup is missing. The legacy `onboardingComplete` boolean was **dropped** —
   from the client's phase rule, from what the wizard writes, and from the Host config schema —
   because internal-test builds do not need that compatibility and two overlapping flags made the
   state harder to reason about than it was worth. A profile that only carries the old flag is
   treated as unanswered.
4. **Single page, two cards (§4.4).** No multi-step installer; both tools are visible at once.
   Manual input, native browse and download stay three independent routes on the same card.
5. **Discovery never blocks (§4.2).** The step opens on the first status read; discovery is
   started in the background and its verdicts arrive by poll. A discovery failure is a line of
   text, not a blocked wizard.
6. **No in-app download ⇒ official page (§9.2/§14.2).** When the manifest offers nothing for this
   platform the card shows the vendor page; it never renders a disabled button pretending to work.
7. **Failed installs clean up and never register.** Extraction goes to a staging directory, is
   validated, then promoted; on failure the staging tree and the download are removed.
8. **The wizard submits what was typed, and only then completes.** The prototype gives the card
   no validate control, so the footer button owns validation: each typed path is written through
   the Host first; a rejected path keeps the modal open with the Host's reason toasted, and only
   a clean round records `complete`. SolidCraft stays optional — one configured tool is enough
   to leave the wizard, and the sidebar dot keeps reporting the missing one.

---

## 4. Verification actually performed

Environment: Windows 11, Node 22.23.2, pnpm 11.28.5, real vendor archives supplied by the user
under `C:\hardware-toolchains`.

### 4.1 Unit / integration tests

| Package | Command | Result |
|---|---|---|
| `hardware-artifacts` | `pnpm --filter @huaqiu/hardware-artifacts exec vitest run` | **148 passed** (8 files; baseline before this pass was 110) |
| `hardware-artifacts` | `… exec tsc --noEmit -p tsconfig.json` | clean |
| `dsh-hardware-ui` | `pnpm --filter @huaqiu/dsh-hardware-ui exec vitest run` | **133 passed** (13 files) |
| `dsh-hardware-ui` | `… exec tsc --noEmit -p tsconfig.json` | clean |

New coverage: `test/toolchain/decode.test.ts` (LZMA fixtures byte-for-byte, ZIP central
directory / entry / tree extraction, prefix stripping, traversal, entry budget, cancellation),
`test/toolchain/capability.test.ts` (manifest schema + selection + failure codes, discovery
ranking, path normalisation, manager state machine, compact capabilities),
`test/toolchain/install-real.test.ts` (whole pipeline on a real vendor archive, opt-in via
`HUAQIU_TOOLCHAIN_ZIP`), `packages/dsh-hardware-ui/test/toolchain.test.ts` (controller policy:
green legality, notice transitions, draft protection, browse/install/cancel), and
`packages/dsh-hardware-ui/test/client.test.ts` (onboarding gating + `saveReady`, the dead-end
regression of §4.5.3).

### 4.2 Real archives (`install-real.test.ts`)

| Archive | Result |
|---|---|
| `kicad-huaqiu-10.0.7-2-x86_64.zip` (836.9 MB, 99 460 entries, ZIP64, 83 548 LZMA) | **passed** — checksum → extract (all entries) → layout → promote → resolve, 353 s |
| `solidcraft-0.49.1-windows-x64-portable.zip` (214 MB, 7 deflate entries) | **passed** — same pipeline, 3.5 s |

Checksum in this test is computed from the archive itself, so a mismatch would fail rather than
pass silently. Entry-level decoding of the KiCad archive was independently verified byte-for-byte
against the on-disk extraction (601 sampled entries, 0 mismatches) during the LZMA work.

### 4.3 Web profile, end to end

`pnpm launch-dsh:standalone --no-install` (builds `hardware-artifacts`, `dsh-hardware-ui`,
`hardware-engineering`, rewrites the profile bundle list, restarts `dsh web` on `127.0.0.1:3080`).

| Check | Observed |
|---|---|
| `GET /api/v1/hardware/toolchain/status` | `kicad`: 5 candidates, `C:\Program Files\KiCad\8.0` (v8.0.0) / `…\Local\Programs\KiCad\10.0` (v10.0.7) / `…\9.0` (v9.0.7) discovered and validated; `solidcraft`: `C:\Program Files\SolidCraft` v0.49.1; `manifest.state = ready`; `target win32/x64`, downloads supported |
| `POST /toolchain/save` (kicad) | `ok`, `version 10.0.7`, `cliPath …\bin\kicad-cli.exe` |
| `POST /toolchain/save` (solidcraft) | `ok`, `version 0.49.1`, `cliPath …\solidcraft-cli.exe` |
| `GET /toolchain/status` again | `kicad=configured v10.0.7`, `solidcraft=configured v0.49.1` |
| `GET /toolchain/capabilities` | `{available:true, version:"10.0.7"}`, `{available:true, version:"0.49.1", cliAvailable:true}` — **no paths** |
| Client bundle | rebuilt; contains the new card / onboarding / notice code |

### 4.4 Two real defects found by real data

1. **`installationRootOf` truncated a folder to its parent.** `C:\Program Files\SolidCraft`
   was read as an *executable* because its folder name matched the CLI stem, so a perfectly
   valid choice was saved as `C:\Program Files` and failed validation (`no solidcraft
   executable under C:\Program Files`). Fix: an existing directory is returned unchanged;
   stem stripping only applies to real executable paths. Regression test added; re-verified
   through the route (see 4.3).
2. **Zero-length entries aborted extraction.** The KiCad archive contains entries with
   `compressedSize === 0`; the streaming path asked Node for `{start, end: start - 1}` and the
   whole extraction died with an out-of-range error. Fix: write an empty file for those entries.

Both were invisible to synthetic fixtures and only appeared against the vendor archives — which
is the argument for keeping `install-real.test.ts`.

### 4.5 First launch froze the whole app — three defects behind one symptom

The user's report was "`rm -rf ~/.dsh`, launch clean, and the UI is completely frozen, even a
page reload does not help". A frozen *page* whose *server* is healthy is a client-side
starvation, and there were two independent ones plus one dead end found while walking it:

1. **`#root` was set `inert` while the onboarding step was open.** The step renders on
   `settings.onboarding`, which the shell paints *inside* `#root`
   (`ui-settings-general/src/client/SettingsRoot.tsx` → `renderSlot('settings.onboarding', …)`),
   so inerting the root inerted the modal together with the app: nothing was clickable and every
   reload reproduced it. Fix: never touch `#root`; the full-screen backdrop alone owns the
   pointer (`wizard.tsx`, and the rule is written into its module docs).
2. **`configForm.getSnapshot()` allocates a new object per call**, so passing it straight to
   `useSyncExternalStore` made React see a changed store on every render and re-render forever.
   Fix: `useFormValue` keeps a local copy and replaces it only when `kicadRoot`,
   `solidcraftRoot` or `toolchainSetup` actually moved.
3. **The modal's only submit button was permanently disabled.** The prototype's wizard card has
   no per-card *validate* control (that button is a Settings affordance), so `Save & Get Started`
   is the step's only way to persist a path — and it was gated on "both tools already
   configured", which a clean profile never is. Fix: `saveReady()` (exported, unit-tested) —
   enabled when something is worth saving, disabled only while a write is in flight — and
   `save()` now validates and writes each typed path through the Host before it records
   `toolchainSetup = 'complete'`, aborting on a rejected path instead of silently completing.

Measured on a genuinely clean `DSH_HOME` (`rm -rf ~/.dsh` equivalent, see §7):

| Observation | Value |
|---|---|
| Wizard on first paint | present, prototype layout, both cards, discovery lines already filled |
| Main-thread responsiveness | 32 `requestAnimationFrame` ticks in 500 ms (~60 fps, i.e. no render loop) |
| Console errors / exceptions | 0 |
| Reload with the wizard open | same as above — no freeze, no re-entrancy |
| `Save & Get Started` (both paths typed) | enabled; `KiCad v10.0.7 validated and saved.` + `SolidCraft v0.49.1 validated and saved.` toasts; modal dismissed |
| Persisted result | `cordis.patch.yml` gained `kicadRoot`, `solidcraftRoot`, both versions/sources/`validatedAt` and `toolchainSetup: complete` |
| Second launch | no wizard, no "setup needed" dot, composer usable |

### 4.6 UI follows the prototype, element for element

Both surfaces were rebuilt against
`docs/prototype/huaqiu_eda_hardware_toolchain_ux_prototype.html` (`toolchain-view.tsx` gained
`variant: 'wizard' | 'settings'`); the copy compiles down to the prototype's own strings
(`locales.ts` / `copy.ts`), so a reviewer can diff the running modal against the design.

| Prototype | Implementation |
|---|---|
| Header: brand mark, title, `First-Time Setup` pill, close button | same; the mark is `assets/huaqiu.svg` itself — byte-for-byte, inlined as a base64 data URI in `brand.ts` and pinned by `test/brand.test.ts`, not a redrawn `H` |
| Blue info callout | same |
| Card: `Ki`/`Sc` tile, name + `(kicad-cli)` + chip (`Required for PCB/Sch`, `Optional • MCAD`), blurb, amber `Not configured` pill | same |
| Path input with the prototype's example path as placeholder + `Select Local File...` (folder icon) | same |
| Bordered bar: `Don't have KiCad? v10.0.7-2 (Win x64)` + `Download from HuaQiu Server` (blue / amber) | same; click runs the plugin's download job, `href` stays as fallback |
| Inline progress bar (label + %, 1.5 px track) | same component, driven by the job's `percent` |
| Footer: gear, "…in Settings → Hardware Engineering", `Skip for Now`, `Save & Get Started` | same |
| Settings: title + long lead, version badge pill, blurb, `Browse...`, `Validate and save` + mono status/path, `Download KiCad (v10.0.7-2)` | same; the status slot shows the resolved CLI path when green, the prototype's wording when not, and `Not saved · click Validate and save` while the input holds an edit the Host has not seen |

Two corrections were made after the first visual pass, both raised by the user:

1. **No `Found …` line under the path row.** The discovery line ("Found `C:\Program Files\KiCad\8.0`")
   used to sit under each wizard card; the prototype has no such row and a duplicate path under a
   path field reads as noise. It is gone from the cards — `discoveryLine()` survives only inside the
   picker's empty state, where a *reason* is genuinely needed.
2. **`Browse`/`Select Local File` is not a raw OS dialog any more.** Clicking it now opens the
   prototype's simulated file-browser modal (`ExecutablePicker`): OS-style title bar
   (`Select kicad-cli Executable — System File Explorer` + `×`), mono breadcrumb, the blue underlined
   `Open Native OS Picker ↗` link in the breadcrumb bar, a row per detected executable (file tile, name,
   `System install` / `User install` chip, mono path, green version + verdict on the right), and a
   footer with the selected path (`No file selected` when empty) plus `Cancel` / `Open` (system blue,
   disabled until a row is chosen). Only the `Open Native OS Picker ↗` link reaches the real OS
   dialog — the same split the prototype makes.

   Rows that failed validation stay listed with their reason but are `aria-disabled`: the picker never
   offers a path the Host would reject. The list caps at 288 px (the mock's `max-h-60` with slightly
   taller rows) and scrolls.

   The picker is rendered **by the card that opened it**, not by `shell.overlay`: the shell's overlay
   layer paints below the settings modal, so a picker hosted there landed behind the very dialog asking
   for it. Observed in the first walk-through ("modal: true" but invisible), fixed by re-parenting, then
   re-observed with a stacking probe (`elementFromPoint` at the picker's centre hits the picker).

Verified live, on both surfaces:

| Walk | Result |
|---|---|
| Clean `DSH_HOME` → wizard → `Select Local File...` → row `C:\Program Files\KiCad\8.0` → `Open` | picker listed all 5 real candidates (3 invalid with reasons), input took the chosen path, picker closed (`.smoke/07`, `08`, `09`) |
| Settings → Hardware Engineering → `Browse…` → row → `Open` | same, painted above the settings modal, input updated, verdict switched to `Not saved` (`.smoke/10`, `11`, `12`) |

### 4.7 Two downloads at once — both progress bars must stay visible

Reported from use: starting KiCad and SolidCraft downloads one after the other left only **one**
progress bar in the UI, on both surfaces. Two independent defects, both found and fixed:

1. **One-job mirror in the client.** `ToolchainStatus` carried a single `job` (with a single `jobId`
   being polled). The second `/install` overwrote that field, so the first tool's bar disappeared even
   though its download was still running on the Host. Worse, the client only wrote the job into state
   when a status read already contained one, so the newly started job's own bar could be dropped.
2. **Zero-height track.** `PROGRESS_TRACK` used `flex: 1` inside a column flex container, so the track
   collapsed to 0 px — the percentage climbed with nothing visible behind it. The DOM agreed: the
   `role="progressbar"` element measured 0 px tall. Fixed to `flex: '0 0 auto'` plus `minHeight: 6`
   (the prototype's `w-1.5`), now a measured `530 × 6`.

Shape of the fix — the Host remains the single owner of job state, the client now mirrors a **map**:

| Layer | Change |
|---|---|
| Host `manager.status(jobIds?)` | returns `jobs: InstallJobSnapshot[]` (all requested jobs that exist) alongside `job` for older callers |
| Host `GET /status` | parses a comma-separated `?job=a,b` (the previous single-string parse is gone) |
| Client `transport` | `status(jobIds?)` → `?job=a,b` |
| Client controller | `snapshot.jobs: Partial<Record<ToolchainId, InstallJob>>`; per-tool `watched: Map<tool, jobId>` and `phases: Map<tool, phase>` (a toast fires once per tool per phase); `collectJobs()` merges the answer and **keeps the previous entry for any tool the Host did not answer with**, so a poll cannot blank the other bar; `install()` now records the job unconditionally; a watcher is dropped only when the job is known finished or replaced |
| Client view | each card reads `snapshot.jobs[id]` — no more "is this job mine" test, so both cards draw their own bar |

Verified live, both tools downloading at the same time on the Settings page: one `GET
/status?job=<kicad>,<solidcraft>` answered with both jobs (kicad `download 1 %`, solidcraft `done`), and
the DOM held two `role="progressbar"` nodes — kicad `31 %` blue, solidcraft `58 %` amber, both
`530 × 6` (`.smoke/14-both-downloads.png`, `.smoke/15-both-downloads-later.png`). Client suite grew two
tests: bars for both tools survive concurrent starts (and the poll carries both ids), and the phase toast
fires once per tool.

---

## 5. Acceptance matrix (§16)

Legend: **✅** verified in this pass (test or live route) · **🟡** implemented, needs a human
visual pass · **⏸️** belongs to M9 (desktop packaging, user-run).

### First launch
| Criterion | State |
|---|---|
| Wizard appears automatically on first eligible launch | ✅ observed on a clean `DSH_HOME` (§4.5) |
| Appears without waiting for discovery | ✅ `onboardingPhase` returns `open` on the first status read; `waiting` renders nothing |
| Discovery asynchronous | ✅ route answers immediately, verdicts arrive by poll (observed) |
| Discovery failure cannot block | ✅ failure is a card line; phase logic unaffected |
| Manual input / native browse / download usable immediately | ✅ card renders all three; `Browse` opens the prototype's list picker (§4.6), its `Open Native OS Picker ↗` link reaches the OS dialog (🟡 interactive) |
| Skip/close dismisses | ✅ writes `deferred` + legacy flag, then `complete()` |
| Skip does not reopen every start | ✅ `onboardingPhase` → `dismissed` (unit-tested, and observed on the second launch) |
| Skip produces a non-blocking notification | ✅ `shell.overlay` toast |
| Sidebar indicator when incomplete | ✅ footer dot while any tool is unconfigured |
| The app stays interactive while the modal is open | ✅ no `#root` inert, 60 fps, 0 console errors (§4.5) |
| The primary button can actually submit | ✅ `saveReady()` + validate-then-write (§4.5, unit-tested) |
| UI matches the prototype | ✅ element-by-element (§4.6, screenshots in `.smoke/03…06`, picker in `07…12`) |

### Discovery
| Criterion | State |
|---|---|
| Detects system / user-local KiCad, SolidCraft | ✅ observed on this machine (see 4.3) |
| Validates executables, shows versions | ✅ |
| Never overwrites explicit valid configuration | ✅ discovery is evidence only; only `save` writes |
| Deterministic on multiple installations | ✅ managed > version > order (unit-tested) |
| No unbounded scan | ✅ fixed candidate list, one `readdir` per known prefix |

### Manual configuration
| Criterion | State |
|---|---|
| Root / `bin` / direct executable accepted (KiCad, SolidCraft) | ✅ `installationRootOf` + regression test |
| Native browse opens the OS picker | 🟡 the in-app list picker is verified (§4.6); the `Open Native OS Picker ↗` link only has unit tests — opening a real dialog would block the automated walk |
| Invalid paths not saved as valid | ✅ refused write leaves state `unconfigured` |
| Previous valid configuration survives a failure | ✅ refused save does not clear the stored root |

### Download
| Criterion | State |
|---|---|
| Fetches and validates the manifest, selects Windows x64 | ✅ live `manifest.state = ready`, version shown on the card |
| Real progress when measurable | ✅ byte counter + `percent`; inline bar measured `530 × 6` on screen |
| Two tools downloading at once both stay visible | ✅ per-tool job map; two bars observed side by side (§4.7) |
| Cancellation | ✅ abort wired; controller cancel → status re-read |
| SHA-256 verification | ✅ enforced (real archives verified end to end) |
| Rejects invalid/corrupted archives | ✅ checksum-mismatch / invalid-zip paths; failed staging removed |
| No elevation required | ✅ installs under `<DSH home>/toolchains` |

### Installation
| Criterion | State |
|---|---|
| KiCad extracted with its complete layout | ✅ full 99 460-entry tree promoted (4.2) |
| KiCad CLI resolves | ✅ route + install validation |
| SolidCraft both executables / paths resolve | ✅ CLI + app resolved |
| Extraction cannot escape the target | ✅ segment validation, absolute/device/traversal tests |
| Promoted only after validation | ✅ staging → validate → promote |
| Previous valid installations preserved | ✅ per-version managed directories |
| Configuration auto-populated after install | ✅ manager persists the promoted root on success |

### Settings
| Criterion | State |
|---|---|
| Available after dismissal | ✅ `settings.section` always registered |
| Both cards show path + status | ✅ shared card body (`variant: 'settings'`, §4.6) |
| Browse / download / inline progress / version badges | ✅ implemented; cards seen on screen (`06-settings-cards.png`), `Browse…` walk in `10…12`, two concurrent bars in `14…15` |
| Sidebar reflects real configuration | ✅ dot only while incomplete |
| Wizard and Settings share state | ✅ one controller (unit-tested) |

### Agent
| Criterion | State |
|---|---|
| Can determine KiCad / SolidCraft availability | ✅ `capabilities()` |
| Missing CLI gives a structured error | ✅ stable error codes through the route envelope (`not-configured`, `no-entry`, `invalid-path`, `checksum-mismatch`, …) |
| Missing SolidCraft does not block KiCad work | ✅ independent per-tool state |
| No silent PATH substitution | ✅ resolution only from the configured root |

### Packaging (M9 — user-run)
| Criterion | State |
|---|---|
| Windows x64 installer contains the plugin code | ⏸️ |
| No dev-only local links / no Python / no Docker / no HQ Edge | ⏸️ (nothing introduced in this pass) |
| Downloads and extraction work in the packaged app | ⏸️ (identical code path, but still needs the packaged run) |
| Existing settings and navigation intact | ⏸️ |

---

## 6. Known limitations

- **Packaged-app verification is not done** (M9) — by the user's instruction.
- **Native chooser not exercised interactively.** The per-OS implementation is written and
  wired, and it is now reached only through the picker's `Open Native OS Picker ↗` link
  (the `Browse`/`Select Local File` buttons stay in-app). A real dialog blocks an automated walk;
  treat it as untested until someone clicks that one link on Windows, macOS and Linux.
- **The stale-tab hazard is real, not hypothetical.** During this pass a leftover tab of the
  earlier session wrote `toolchainSetup: deferred` into the live
  `~/.dsh/profiles/web/cordis.patch.yml`, dropping `kicadRoot`/`solidcraftRoot`. The file was
  restored from `.smoke/cordis.patch.configured.yml`; check that file's `config:` block if the
  cards ever come up "Not configured" on a machine that was configured.
- **KiCad extraction is slow** (~6 min for 83 k+ LZMA entries on this machine). Progress is
  reported throughout; the work never runs on the UI thread.
- **`sidebar.footer.action` renders a dot, not a link.** The plugin has no seat that can open
  Settings, so the dot is intentionally inert (tooltip says what is missing) rather than a
  button that promises navigation it cannot perform.
- **`onboardingComplete` is gone, so a legacy-only profile is asked again.** The key was removed
  from the client rule, from the wizard's writes and from the Host schema; `toolchainSetup` is the
  single source of truth. A profile that carries only the old boolean shows the wizard once, and
  the answer is recorded the new way.
- **The download button was pressed, but never to the end of the chain.** Both cards' `Download` was
  clicked on a real server against the real mirrors and the bars ran (§4.7); the observed job that
  finished was short-circuited by the reuse rule (an identical managed copy already existed), so
  "download → extract → promote" through the UI is still proven only by the real-archive tests
  (§4.2). Cancel per card is wired; there is no "cancel all" button, which the prototype does not
  have either.
- **A dev loop artifact, not a defect:** the launcher opens the default browser each boot, and an
  older tab still pointing at `127.0.0.1:3080` reconnects to the new server and replays its own
  pending settings writes. That is how `toolchainSetup: complete` can reappear in
  `cordis.patch.yml` right after someone strips it; use a scratch `DSH_HOME` (below) for
  destructive walks and close stale tabs.

---

## 7. Reproducing

```powershell
$env:PATH = "C:\code\deepseek-harness\node_modules\.bin;" + $env:PATH
cd C:\code\dsh-pcb-eda

# unit + integration
pnpm --filter @huaqiu/hardware-artifacts exec vitest run     # 148 passed
pnpm --filter @huaqiu/dsh-hardware-ui exec vitest run        # 142 passed

# real archives (opt-in, minutes)
$env:HUAQIU_TOOLCHAIN_ZIP = "kicad=C:\hardware-toolchains\kicad-huaqiu-10.0.7-2-x86_64.zip,solidcraft=C:\hardware-toolchains\solidcraft-0.49.1-windows-x64-portable.zip"
pnpm --filter @huaqiu/hardware-artifacts exec vitest run test/toolchain/install-real.test.ts

# web profile (dev loop)
node scripts/launch-dsh-standalone.mjs --no-install   # http://127.0.0.1:3080

# the clean first launch the freeze was reported on, without touching ~/.dsh
$env:DSH_HOME = "C:\code\dsh-pcb-eda\.smoke\dsh-home"
Remove-Item -Recurse -Force $env:DSH_HOME -ErrorAction SilentlyContinue
node scripts/launch-dsh-standalone.mjs --no-build      # installs the profile fresh, then boots

# wizard on the real profile without destroying its config: swap the hardware-artifacts
# block to "{}" (fresh), walk, then put the configured copy back
Copy-Item .smoke\cordis.patch.fresh.yml    C:\Users\yihuo\.dsh\profiles\web\cordis.patch.yml -Force
Copy-Item .smoke\cordis.patch.configured.yml C:\Users\yihuo\.dsh\profiles\web\cordis.patch.yml -Force
```

Port hygiene matters more than it looks: a leftover `pnpm dsh web` / `bin.ts web` from an earlier
launcher keeps the port and the next boot dies with `EADDRINUSE` dressed up as "2 required plugins
did not activate". Kill the launcher, the `pnpm dsh web` and the `bin.ts web` children before
starting again.

Then, by hand: open the app on a fresh profile, walk the wizard, press the picker's
`Open Native OS Picker ↗` once per card (the one step automation cannot take), start a download and
watch the inline progress, and finally run the M9 desktop build.

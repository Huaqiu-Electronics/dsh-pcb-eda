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
| `src/client/toolchain-view.tsx` | The install card (both surfaces), notice overlay, sidebar dot |
| `src/client/wizard.tsx` | First-run step on `settings.onboarding` + `onboardingPhase` gate |
| `src/client/components.tsx` | Settings section, now the two shared cards |
| `src/client/transport.ts` | Toolchain route calls, same error-envelope mapping as the rest |

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
3. **Skip ≠ complete.** `toolchainSetup: 'deferred' | 'complete'`. Skipping writes `deferred`
   (plus the legacy `onboardingComplete` flag) so the step stops interrupting while the sidebar
   dot and Settings keep saying setup is missing. Legacy configs with only the boolean are
   honoured and never re-interrupted.
4. **Single page, two cards (§4.4).** No multi-step installer; both tools are visible at once.
   Manual input, native browse and download stay three independent routes on the same card.
5. **Discovery never blocks (§4.2).** The step opens on the first status read; discovery is
   started in the background and its verdicts arrive by poll. A discovery failure is a line of
   text, not a blocked wizard.
6. **No in-app download ⇒ official page (§9.2/§14.2).** When the manifest offers nothing for this
   platform the card shows the vendor page; it never renders a disabled button pretending to work.
7. **Failed installs clean up and never register.** Extraction goes to a staging directory, is
   validated, then promoted; on failure the staging tree and the download are removed.

---

## 4. Verification actually performed

Environment: Windows 11, Node 22.23.2, pnpm 11.28.5, real vendor archives supplied by the user
under `C:\hardware-toolchains`.

### 4.1 Unit / integration tests

| Package | Command | Result |
|---|---|---|
| `hardware-artifacts` | `pnpm --filter @huaqiu/hardware-artifacts exec vitest run` | **148 passed** (8 files; baseline before this pass was 110) |
| `hardware-artifacts` | `… exec tsc --noEmit -p tsconfig.json` | clean |
| `dsh-hardware-ui` | `pnpm --filter @huaqiu/dsh-hardware-ui exec vitest run` | **129 passed** |
| `dsh-hardware-ui` | `… exec tsc --noEmit -p tsconfig.json` | clean |

New coverage: `test/toolchain/decode.test.ts` (LZMA fixtures byte-for-byte, ZIP central
directory / entry / tree extraction, prefix stripping, traversal, entry budget, cancellation),
`test/toolchain/capability.test.ts` (manifest schema + selection + failure codes, discovery
ranking, path normalisation, manager state machine, compact capabilities),
`test/toolchain/install-real.test.ts` (whole pipeline on a real vendor archive, opt-in via
`HUAQIU_TOOLCHAIN_ZIP`), `packages/dsh-hardware-ui/test/toolchain.test.ts` (controller policy:
green legality, notice transitions, draft protection, browse/install/cancel).

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

---

## 5. Acceptance matrix (§16)

Legend: **✅** verified in this pass (test or live route) · **🟡** implemented, needs a human
visual pass · **⏸️** belongs to M9 (desktop packaging, user-run).

### First launch
| Criterion | State |
|---|---|
| Wizard appears automatically on first eligible launch | 🟡 step registered on `settings.onboarding`; seal/visibility requires a blank first session in the UI |
| Appears without waiting for discovery | ✅ `onboardingPhase` returns `open` on the first status read; `waiting` renders nothing |
| Discovery asynchronous | ✅ route answers immediately, verdicts arrive by poll (observed) |
| Discovery failure cannot block | ✅ failure is a card line; phase logic unaffected |
| Manual input / native browse / download usable immediately | ✅ card renders all three; browse route implemented (dialog itself 🟡) |
| Skip/close dismisses | ✅ writes `deferred` + legacy flag, then `complete()` |
| Skip does not reopen every start | ✅ `onboardingPhase` → `dismissed` (unit-tested) |
| Skip produces a non-blocking notification | ✅ `shell.overlay` toast |
| Sidebar indicator when incomplete | ✅ footer dot while any tool is unconfigured |

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
| Native browse opens the OS picker | 🟡 implemented per-OS; not exercised interactively (opening a real dialog would block the walk) |
| Invalid paths not saved as valid | ✅ refused write leaves state `unconfigured` |
| Previous valid configuration survives a failure | ✅ refused save does not clear the stored root |

### Download
| Criterion | State |
|---|---|
| Fetches and validates the manifest, selects Windows x64 | ✅ live `manifest.state = ready`, version shown on the card |
| Real progress when measurable | ✅ byte counter + `percent`; inline bar (🟡 visual) |
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
| Both cards show path + status | ✅ shared card body |
| Browse / download / inline progress / version badges | ✅ implemented (🟡 visual pass) |
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
  wired, but a real dialog blocks an automated walk; treat it as untested until someone clicks
  Browse once on Windows, macOS and Linux.
- **KiCad extraction is slow** (~6 min for 83 k+ LZMA entries on this machine). Progress is
  reported throughout; the work never runs on the UI thread.
- **`sidebar.footer.action` renders a dot, not a link.** The plugin has no seat that can open
  Settings, so the dot is intentionally inert (tooltip says what is missing) rather than a
  button that promises navigation it cannot perform.
- **Legacy `onboardingComplete` is honoured as "completed".** A user who finished the old wizard
  will not be re-prompted; they reach the same setup from Settings.

---

## 7. Reproducing

```powershell
$env:PATH = "C:\code\deepseek-harness\node_modules\.bin;" + $env:PATH
cd C:\code\dsh-pcb-eda

# unit + integration
pnpm --filter @huaqiu/hardware-artifacts exec vitest run
pnpm --filter @huaqiu/dsh-hardware-ui exec vitest run

# real archives (opt-in, minutes)
$env:HUAQIU_TOOLCHAIN_ZIP = "kicad=C:\hardware-toolchains\kicad-huaqiu-10.0.7-2-x86_64.zip,solidcraft=C:\hardware-toolchains\solidcraft-0.49.1-windows-x64-portable.zip"
pnpm --filter @huaqiu/hardware-artifacts exec vitest run test/toolchain/install-real.test.ts

# web profile (dev loop)
node scripts/launch-dsh-standalone.mjs --no-install   # http://127.0.0.1:3080
```

Then, by hand: open the app on a fresh profile, walk the wizard, press Browse once per card,
start a download and watch the inline progress, and finally run the M9 desktop build.

# M1 failure register

Every failure observed during implementation and verification is classified here.
No failed test was removed, weakened, or relabelled as a pass. "Pre-existing"
means the failing test file and its implementation were not touched by this M1
change set; `git diff --cached --name-only` shows only version-bump `package.json`
changes for those packages.

---

### F-01 — Tier 1 KiCad IPC blocked: `kipy` missing

- **Layer:** Host
- **Host tier:** Tier 1 (Huaqiu KiCad)
- **Expected behavior:** `kicad_ipc_diagnose` reports the live KiCad version and open board; `kicad_ipc_verify_live` proves an IPC mutation can be made and dropped.
- **Actual behavior:** Both tools dispatched successfully and returned `isError:false` with `{ok:false, error.kind:"FAILED_PRECONDITION"}`; stderr shows `ModuleNotFoundError: No module named 'kipy'`. `python3 -m venv /tmp/m1-kipy-venv && pip install kipy` reports "No matching distribution found for kipy".
- **Evidence:** `evidence/e2e-desktop.json` steps 3–4; `evidence/e2e-stderr.log`.
- **Root cause:** Confirmed — the configured Python interpreter has no `kipy`, which the bundled IPC scripts import.
- **Classification:** Environment blocker (not an unsupported host feature; the host listens on `/tmp/kicad/api.sock` and `127.0.0.1:61429`).
- **Workaround:** Use the native `kicad-cli` path, which passed read/ERC/DRC/BOM on the same host.
- **Follow-up:** Defer. Provide a matching `kipy` in a managed Python environment and set `DSH_KICAD_PYTHON` in M2, then rerun the two IPC probes.

### F-02 — Quote backend unavailable

- **Layer:** External service
- **Host tier:** Not host-specific
- **Expected behavior:** `quote_pcb` returns an itemized real quote once a quote backend is configured.
- **Actual behavior:** `quote_pcb({region:"cn"})` returned `isError:true` with `quote: no hq-edge base URL available (edge-bridge service or HQ_EDGE_BASE_URL)`. No price was fabricated.
- **Evidence:** `evidence/e2e-desktop.json` step 7; `evidence/e2e-stderr.log` warning from `dsh-tool-quote`.
- **Root cause:** Confirmed — no `hqEdge` service and neither `HQ_EDGE_BASE_URL` nor `HUAQIU_QUOTE_BASE_URL` is set. This is the intended lazy-capability behavior introduced in M1.
- **Classification:** Product boundary (external service absent), separated from bundle success.
- **Workaround:** Configure a host-neutral `HUAQIU_QUOTE_BASE_URL` when a quote backend is available.
- **Follow-up:** Defer to M2 service provisioning. Do not reintroduce a hard `hqEdge` inject: that parked the whole plugin in `pending` and removed all four tools.

### F-03 — Precondition failures are not tool-level errors

- **Layer:** Package (`@huaqiu/dsh-kicad`)
- **Host tier:** Tier 1
- **Expected behavior:** A tool that cannot perform its operation should be visibly failing to a caller.
- **Actual behavior:** `kicad_ipc_diagnose` / `kicad_ipc_verify_live` set `isError:false` and put `FAILED_PRECONDITION` inside `value.error`.
- **Evidence:** `evidence/e2e-desktop.json` steps 3–4.
- **Root cause:** Confirmed — `asJson()` wraps the precondition result as a successful tool value.
- **Classification:** Implementation defect (semantics), not a host limitation.
- **Workaround:** Callers must inspect `value.ok` / `value.error.kind` as well as `isError`.
- **Follow-up:** Defer; consider promoting precondition failures to `isError:true` in M2, with a regression test.

### F-05 — `dsh-kicad` bundled-skill drift and content assertions

- **Layer:** Package
- **Host tier:** Not host-specific
- **Expected behavior:** Four tests in `test/bundling.test.ts` and `test/plugin.test.ts` expect specific `hardware-design-brief` headings and byte-identical skills to the upstream checkout.
- **Actual behavior:** 4 failures: missing `## 文档位置与关系`, missing `## 本技能与同包能力的配合`, and `skills/kicad-ipc diverged from upstream — re-run the sync`.
- **Evidence:** `evidence/product-tests.log` (`packages/dsh-kicad`).
- **Root cause:** Confirmed — skill content in this checkout drifted from both the test expectations and `kicad-agent`.
- **Classification:** Pre-existing implementation defect (sync drift), out of M1 scope; not an activation defect (the package reached ACTIVE and registered all 10 tools).
- **Workaround:** None.
- **Follow-up:** Defer to the skill-sync owner; run the existing sync workflow before release.

### F-06 — `dsh-plugin-log` isolation/ownership tests

- **Layer:** Package
- **Host tier:** Not host-specific
- **Expected behavior:** Locks and rotation survive concurrent and crashed multi-process writers.
- **Actual behavior:** 3 failures in `test/isolation.test.ts` and `test/ownership.test.ts`; one reports `AssertionError: expected false to be true` for lock release after an owner exits without shutdown. 7 other test files pass.
- **Evidence:** `evidence/product-tests.log` (`packages/dsh-plugin-log`).
- **Root cause:** Unknown — not investigated in M1.
- **Classification:** Pre-existing implementation defect suspected; environment-dependent file-lock behavior is also possible, so not asserted as confirmed.
- **Workaround:** None.
- **Follow-up:** Defer to the log owner; reproduce on a clean temporary directory before classifying further.

### F-07 — `dsh-analytics` tool-name tracking

- **Layer:** Package
- **Host tier:** Not host-specific
- **Expected behavior:** `isTrackedTool` includes tool names declared by same-file constants.
- **Actual behavior:** `AssertionError: expected false to be true`.
- **Evidence:** `evidence/product-tests.log` (`packages/dsh-analytics`).
- **Root cause:** Unknown — not investigated; this package is deliberately excluded from the product bundle.
- **Classification:** Pre-existing implementation defect suspected.
- **Workaround:** Not needed; excluded from the bundle.
- **Follow-up:** Defer.

### F-08 — `dsh-tool-symbol-footprint` endpoint expectations

- **Layer:** Package
- **Host tier:** Not host-specific
- **Expected behavior:** Default endpoint `ws://www.fdatasheets.com/componentV2/...` and a three-entry host whitelist.
- **Actual behavior:** 2 failures: got `wss://www.eda.cn/componentV2/chat`, expected `ws://www.fdatasheets.com/...`; whitelist got `['www.eda.cn','www.fdatasheets.com']`, expected three entries.
- **Evidence:** `evidence/product-tests.log` (`packages/dsh-tool-symbol-footprint`).
- **Root cause:** Confirmed — test expectations are stale relative to the implementation constants (or vice versa); not reconciled in M1.
- **Classification:** Pre-existing implementation/test drift; activation and all three tool registrations still pass.
- **Workaround:** None.
- **Follow-up:** Defer to the package owner; decide which side is authoritative before release.

### F-09 — `dsh-huaqiu-about` has no test files

- **Layer:** Package
- **Host tier:** Not host-specific
- **Expected behavior:** `vitest run` finds at least one test, as the package declares a `test` script.
- **Actual behavior:** `No test files found, exiting with code 1`.
- **Evidence:** `evidence/product-tests.log` (`packages/dsh-huaqiu-about`).
- **Root cause:** Confirmed — the package has no tests.
- **Classification:** Pre-existing test-coverage gap.
- **Workaround:** None needed for activation; the plugin reached ACTIVE.
- **Follow-up:** Defer; either add a smoke test or remove the `test` script.

### F-10 — `dsh-ui-theme-huaqiu` typecheck errors

- **Layer:** Package
- **Host tier:** Not host-specific
- **Expected behavior:** `tsc --noEmit` passes.
- **Actual behavior:** `TS2664 Invalid module name in augmentation '@deepseek-ai/dsh-client-ui-slots' cannot be found` and `TS2345 '"brand.huaqiu"' is not assignable to keyof LocaleNamespaceMap`.
- **Evidence:** `evidence/product-typecheck.log`.
- **Root cause:** Confirmed — client-only type augmentation is not visible to the host typecheck; locale namespace map lacks the key. No source file in this package was changed by M1.
- **Classification:** Pre-existing implementation defect.
- **Workaround:** Note that `check:publish` still passes for this package and the plugin activates.
- **Follow-up:** Defer to the UI owner.

### F-11 — Package not published to npm

- **Layer:** Package / release channel
- **Host tier:** Not host-specific
- **Expected behavior:** A normal `npm install @huaqiu/hardware-engineering@0.7.10` resolves.
- **Actual behavior:** Registry lookup returned 404; the reproduction bridge uses a local `link:` override in the harness fork and tarballs from `dsh-pcb-eda/dist`.
- **Evidence:** `deepseek-harness/pnpm-workspace.yaml` override with its removal comment; `dependency-ledger.md` hashes.
- **Root cause:** Confirmed — M1 explicitly does not publish and has no release-channel authorization.
- **Classification:** Product boundary / deliberate scope limit.
- **Workaround:** Local link override and packed-tarball fixture; remove only that entry when 0.7.10 is published.
- **Follow-up:** Publish in a separately authorized change; then delete the bridge and rerun the gates.

### F-12 — Fixture teardown did not settle

- **Layer:** DSH runtime (fixture observation, not a product failure)
- **Host tier:** Not host-specific
- **Expected behavior:** `shutdown.shutdown(0)` settles promptly after boot.
- **Actual behavior:** Did not settle within the bounded 1000 ms window; recorded as `teardown.error = "did not settle within 1000 ms"` with no forced exit request.
- **Evidence:** `evidence/activation-desktop.json` → `teardown`.
- **Root cause:** Suspected — a mounted long-lived surface keeps the tree alive; not investigated because it is outside activation.
- **Classification:** Environment/fixture observation; deliberately **not** an activation gate.
- **Workaround:** Evidence is written before the bounded wait; the one-shot fixture process exits explicitly.
- **Follow-up:** Defer; investigate graceful shutdown separately if it affects Desktop quit behavior.

---

## Failures that were found and fixed during M1

These are not open failures; they are listed so the verification path is auditable.

| ID | Symptom | Fix | Evidence |
|---|---|---|---|
| X-01 | Bundled activation parked 9 rows in `pending` on `hqEdge` and removed quote tools. | Lazy capability resolution in `dsh-tool-quote`; no bundled row now injects `hqEdge`. | `evidence/activation-desktop.json` — no composed row injects `hqEdge`, 9/9 ACTIVE. |
| X-03 | `verify-default-product-isolation` rejected an installation-resolved bundle. | Added an install-anchor-anchored fallback **and** an assertion that the named patch file physically ships; gate not weakened. | Harness tests: 231 passed. |
| X-04 | Existing profiles never selected a newly built-in bundle; `initProfile` is a no-op on existing manifests. | `ensureProductBundles` merges only missing bundles after `initProfile`. | `apps/desktop/tests/project-manager.spec.ts` 40 passed / 1 skipped. |
| X-05 | Fixture's first closure walk ignored third-party dependencies; `kicad-sexpr-parser` import failed at boot. | Fixture now links every declared dependency, and a missing artifact is a hard error. | Final activation 23/23 PASS. |
| X-06 | Switching to a session in another workspace made the still-open viewer fail every read with `unauthorized: artifact is outside the authorized workspace` (the built-in Workspace Files read the same file fine). | Authorization roots are now per scope: discovery is recorded per DSH session, the workspace is resolved host-side from the session header (`sessions` → `sessionPersistence` → `sandboxPolicy`), and caller-named roots only ever add — a project file names its directory. The client sends `session` with every read and passes the workspace root, never the `.kicad_pro`. | `test/routes.test.ts` (4) + `test/service.test.ts` scoping cases; live: session B discovered last, session A's `/source` and `/fabrication` still 200, foreign session 403. |

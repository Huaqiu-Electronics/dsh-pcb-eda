# M1 — Huaqiu Hardware Engineering DSH bundle: implementation and POC report

**Task:** `hq-edge/docs/tasks/m1-impl-spec-huaqiu-hardware-bundle-set.md`
**Date:** 2026-11-23 (Asia/Shanghai)
**Overall result:** **CONDITIONAL PASS** — all bundle, activation, packaging and
sandbox criteria pass with executed evidence. The Tier 1 workflow ran on Tier 1
tooling and real project files, but the live KiCad-IPC path is blocked by a
missing `kipy` runtime, so criterion 7 is **PARTIAL**, not a full pass. No failed
result has been relabelled as a success.

---

## 1. Repository baselines

| Repository | Branch | HEAD at start of M1 | Working tree |
|---|---|---|---|
| `dsh-pcb-eda` | `main` | `cdc9118e1a516c45b8cd8a7600b03a79bbc4e8d6` | modified by this change set (product bundle, migrations, version bumps) |
| `deepseek-harness` (Huaqiu fork) | `master` | `5d830fc6f3e68ace0d7170dad5c115416f8624c7` | modified by this change set (installation/profile integration) |
| `kicad` (Huaqiu KiCad source) | `release/10.0` | `8a9453e7650eeac4a4359a68f1fb92fd81882a24` | clean; used as Tier 1 host evidence only |
| `hq-edge` | `main` | `34f466302d15cb2b044c7d584e09abf0f98bc735` | clean; not modified |

Hosts observed at test time:

- Official KiCad `kicad-cli 10.0.7` at `/Applications/KiCad/KiCad.app`.
- Huaqiu KiCad `kicad-cli 10.0.8`; running app bundle reports
  `10.0.7-169-g739520d98a`, listens on `127.0.0.1:61429`, and owns
  `/tmp/kicad/api.sock`.
- HQ Edge headless process listening on `127.0.0.1:61431` with
  `--target-host=kicad --editor-type=generic`. It was **not** supplied to the
  activation fixture and no connection to it was observed.
- No Huaqiu EDA application or service was detected.

## 2. Package composition

`@huaqiu/hardware-engineering@0.7.10` is the product bundle — not a second
empty aggregator. It declares `dsh.bundle.patch`, `engines.dsh: ^0.2.2-rc.1`,
and `@deepseek-ai/cordis@^4.0.1` as a peer. It also declares
`dsh.bundle.listedByDefault: false`: it is selected by the installation
profile, not offered as a separately installable plugin. For the same reason
it is absent from `release-manifest/plugins-release-manifest.json` — the
catalog would otherwise advertise a zero-size duplicate of the eleven plugins
it composes. The publish gate excludes bundles from catalog enumeration via
that same DSH field, while still validating the bundle as a publishable npm
package.

The packed `cordis.patch.yml` disables `ui-brand-official`, then inserts eleven
rows:

| Group | Rows |
|---|---|
| Service providers | `huaqiu-auth`, `huaqiu-artifacts` |
| Node capabilities | `huaqiu-dsh-kicad`, `dsh-tool-kicad-schematic-gen`, `dsh-tool-pcb-viewer`, `huaqiu-tool-part-search`, `huaqiu-eda-selection`, `huaqiu-tool-quote`, `huaqiu-tool-symbol-footprint` |
| Presentation | `ui-theme-huaqiu`, `dsh-huaqiu-about` |

Every row has an explicit `name` resolving to a packed plugin package. Row
order carries no load semantics in DSH: activation is service-availability
driven. Providers are listed first only so a human can audit dependency edges.

Deliberately excluded, with reasons recorded in the patch header:

| Package | Why |
|---|---|
| `@huaqiu/dsh-eda-host` | 11 tools require an HQ Edge HTTP bridge absent from the target runtime. |
| `@huaqiu/dsh-tool-plugin-update` | Discovery/install is HQ Edge-owned business logic. |
| `@huaqiu/dsh-hqsch` | Teaches TypeScript-against-HQ-EDA, outside this POC workflow. |
| `@huaqiu/dsh-analytics` | Telemetry, not required to prove the product. |

## 3. Dependency graph and version ledger

Source manifests use the repository's lockstep `workspace:*` convention.
Packing rewrites all eleven direct dependencies to exact `0.7.10` pins; the
inspected tarball manifest contains no `workspace:` specifier.

```
@huaqiu/hardware-engineering@0.7.10
├── @huaqiu/dsh-auth                      0.7.10
├── @huaqiu/dsh-artifacts                 0.7.10
├── @huaqiu/dsh-kicad                     0.7.10
├── @huaqiu/dsh-tool-kicad-schematic-gen  0.7.10
├── @huaqiu/dsh-tool-pcb-viewer           0.7.10
├── @huaqiu/dsh-tool-part-search          0.7.10
│   ├── @huaqiu/dsh-plugin-log            0.7.10
│   └── @huaqiu/part-search               0.2.6   (published)
├── @huaqiu/dsh-eda-selection             0.7.10
├── @huaqiu/dsh-tool-quote                0.7.10
├── @huaqiu/dsh-tool-symbol-footprint     0.7.10
│   ├── @huaqiu/dsh-sidebar-entry         0.7.10
│   └── @huaqiu/component-gen-server      0.7.10
├── @huaqiu/dsh-ui-theme-huaqiu           0.7.10
├── @huaqiu/dsh-huaqiu-about              0.7.10
└── @huaqiu/kicad-sexpr-parser            0.1.1   (published, deeper in closure)
```

Why declaring dependencies is not enough: the runtime builds its resolution
table by walking the **installation** dependency graph
(`apps/cli → bundle → its dependencies`). A dependency makes a package
loader-visible; only a patch row mounts it. That is why all eleven rows live in
the bundle patch rather than in individual profile entries.

Full hashes, closure derivation, and the host-provided `@deepseek-ai/*` scope:
`docs/m1/dependency-ledger.md`.

## 4. HQ Edge migration details

Two plugins needed changes to activate honestly without HQ Edge:

- **`@huaqiu/dsh-tool-quote`** — `inject` changed from `['hqEdge','tools']` to
  `['tools']`. `apply()` no longer throws when `hqEdge.baseUrl` is absent. All
  four tools always register; each call resolves a backend lazily from the
  `hqEdge` service, config, `HUAQIU_QUOTE_BASE_URL`, or `HQ_EDGE_BASE_URL`. With
  no backend, calls fail per operation with `FAILED_PRECONDITION` (HTTP 412).
  `HUAQIU_QUOTE_BASE_URL` was added as the host-neutral environment name.
- **`@huaqiu/dsh-eda-selection`** — both halves dropped `hqEdge` from `inject`.
  The node section is now optional: with no selection source it contributes no
  text, and the browser chip shows nothing. Previously the row stayed in
  `pending` forever when no bridge was running, silently removing the plugin.

`@huaqiu/dsh-tool-pcb-viewer` had no `inject` at all, so its row had no
activation gate; it now declares `['tools','webServer','sessions']`.

No new runtime manager, daemon, plugin registry, or intermediate EDA IR was
introduced. Native KiCad files remain authoritative.

## 5. DSH fork integration and bundle activation order

Changes in `deepseek-harness` are direct, with no distribution patch layer:

- `deepseek-harness/apps/cli/package.json` declares
  `@huaqiu/hardware-engineering: 0.7.10`.
- `pnpm-workspace.yaml` carries a temporary `link:` override to the sibling
  product repo because the package is not published. The entry has an explicit
  removal comment; the dependency spec is already the production truth.
- `PROFILE_TEMPLATES.desktop` selects
  `['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@huaqiu/hardware-engineering']`;
  `INSTALLATION_OWNED_PROFILE_TUPLES.desktop` keeps the legacy two-package tuple
  so existing installs upgrade in place. The `web` profile is untouched.
- `createPluginProfile` now calls `ensureProductBundles`, which runs
  `initProfile` unconditionally (to recreate patch/workspace files) and then
  appends only missing bundles, preserving user bundles and manifest fields.
- Both static gates (`verify-default-product-isolation`, `verify-product-use`)
  gained an installation-anchored fallback instead of being disabled. The
  isolation gate now also asserts that the named patch file physically ships.

Activation order observed in the real boot:

1. Profile manifest selects three bundles; all three layers load, none skipped.
2. `resolveBundleDir` finds the product bundle from the installation anchor,
   before the profile-directory fallback.
3. Bundle insert rows are composed over the empty root; `ui-brand-official` is
   disabled.
4. Loader mounts rows; providers register `huaqiuAuth` / `huaqiuArtifacts`,
   then consumers such as `huaqiu-tool-symbol-footprint` leave `pending` and
   become `active` when their services appear.
5. `auditStartupEntries` reports no inactive entries.

## 6. Real activation test output

Reproducible fixture: `deepseek-harness/scripts/m1-activation/` (README there).
It builds a throwaway installation from the **packed tarballs**, writes a clean
profile into an isolated `DSH_HOME`, runs the real `runProfile` boot, and
captures stderr and Loader state. Nothing is mocked except `process.exit`
during a bounded teardown wait.

Key recorded checks (full log: `docs/m1/evidence/activation-desktop.log`):

```
PASS  bundle-resolves-from-installation   .../installation/node_modules/@huaqiu/hardware-engineering
PASS  bundle-patch-shipped                .../cordis.patch.yml
PASS  bundle-version-is-packed            resolved 0.7.10, packed 0.7.10
PASS  no-row-requires-hq-edge             no composed row injects hqEdge
PASS  expected-rows-mounted               all 11 product rows are in the Loader tree
PASS  expected-rows-active                all 11 product rows reached ACTIVE
PASS  rows-resolve-into-fixture           11/11 product rows inside the fixture installation
PASS  tools-registered (6 packages)       6+4+1+4+4+3 expected tools present
PASS  skills-registered                   kicad-ipc, kicad-schematic-design
PASS  service-provided                    huaqiuAuth, huaqiuArtifacts, webServer, tools, sandboxPolicy
PASS  sandbox-default-preserved           danger-full-access (DSH_PERMISSION_MODE unset)
PASS  startup-reported-no-failures        no activation warnings on stderr
Result: PASS (24/24)
```

The only stderr line is the expected quote warning:
`no quote service configured — quote_pcb/... will report FAILED_PRECONDITION`.

**Negative control.** Deleting `@huaqiu/dsh-auth` from the fixture installation
makes the checks fail exactly where a missing provider should:
`include:huaqiu-auth=failed`,
`include:huaqiu-tool-symbol-footprint=pending missing huaqiuAuth`, its three
tools absent, and `dsh: warning: 2 entries did not activate`. This proves the
positive checks are sensitive rather than vacuously green.

## 7. Offline test output

`network-guard.ts` replaces `Socket.prototype.connect` for the whole boot. All
of `net`, `tls`, `http`, `https`, and `fetch` end at that method; non-loopback
connects are rejected and recorded.

```
PASS  activated-without-network — 3 connect attempts, 0 blocked
```

All recorded connects are loopback (the profile's own web server). No
registry request, package download, or HQ Edge connection occurred. Resolution
is a pure `createRequire(anchor).resolve.paths()` filesystem probe.

Scope note: the guard covers TCP connects, not Unix sockets or DNS alone. The
source-level assertion that no composed row injects `hqEdge` closes the
HQ-Edge-specific gap.

## 8. Functional workflow evidence

See `docs/m1/e2e-execution-record.md` and `evidence/e2e-desktop.json`.
Five tools were dispatched through the real `ToolsService.execute()` path:

| Tool | Result |
|---|---|
| `kicad_ipc_diagnose` | dispatched; `FAILED_PRECONDITION` — `kipy` missing |
| `kicad_ipc_verify_live` | dispatched; `ModuleNotFoundError: No module named 'kipy'`; no board mutation |
| `pcb_preview` | PASS — real board: 13 comps, 102 pads, 101 traces, 1 zone, 8 vias, 2 layers, 80×60 mm |
| `search_hqsch_parts` | PASS — 161 real results; first `STM32F103CBU6TR`, HQ P/N `G3338201` |
| `quote_pcb` | BLOCKED — no quote backend; no price fabricated |

One outbound connect (`kiapi.eda.cn:443`) was recorded during the part-search
service call. That is a functional service dependency, not an activation
dependency.

## 9. Tier 0 / Tier 1 compatibility matrix

Full matrix with per-cell evidence: `docs/m1/capability-matrix.md`. Summary:

| Capability | Official KiCad (T0) | Huaqiu KiCad (T1) | Huaqiu EDA (T1) |
|---|---|---|---|
| Host detection | PASS | PARTIAL | NOT TESTED |
| Project access | PARTIAL | PARTIAL | NOT TESTED |
| Schematic read | PASS | PASS | NOT TESTED |
| Schematic modification | NOT TESTED | NOT TESTED | NOT TESTED |
| PCB read | PASS | PASS | NOT TESTED |
| PCB modification | NOT TESTED | BLOCKED (`kipy`) | NOT TESTED |
| Selection context | NOT TESTED | NOT TESTED | NOT TESTED |
| ERC/DRC | PASS | PASS | NOT TESTED |
| BOM generation | PASS | PASS | NOT TESTED |
| Part search | PASS (host-independent) | PASS (host-independent) | PASS (host-independent) |
| Symbol/footprint generation | NOT TESTED | NOT TESTED | NOT TESTED |
| Quote/ordering | BLOCKED | BLOCKED | BLOCKED |

Huaqiu-only capabilities (HQSCH part numbers/model flags, quote API, the gRPC
endpoint at `61429`) are represented explicitly and not claimed for Tier 0.
`NOT TESTED` was never converted into `UNSUPPORTED`.

## 10. Failure register

`docs/m1/failure-register.md` records twelve open failures with all ten
required fields, plus five issues that were found and fixed during the work.
Highest-signal open items: Tier 1 IPC blocked by missing `kipy` (environment),
quote backend absent (external service), and six packages with pre-existing
test/typecheck failures in files M1 did not change.

## 11. Test results (not hidden)

| Suite | Result |
|---|---|
| Harness host typecheck (`pnpm typecheck`) | PASS — all 5 gates |
| Harness integration tests | PASS — 318 passed, 1 skipped across 5 files |
| Harness static gates | PASS — 302 packages / 2288 runtime sources / 10 configurations; `verify-product-use` exits 0 with 2 pre-existing warnings |
| `@huaqiu/hardware-engineering` bundle tests | PASS — 16 tests |
| Product publish gate (`pnpm check:publish`) | PASS — all packages OK, 18 manifest entries |
| Product typecheck (`pnpm typecheck`) | **FAIL** — 2 errors in `dsh-ui-theme-huaqiu/src/client/index.ts`, pre-existing |
| Product full test suite (`pnpm -r --no-bail test`) | **FAIL** — 6 packages have failures; passes include `hardware-engineering`, `quote`, `eda-selection`, `auth`, `part-search`, `plugin-update` and others |
| Activation fixture (desktop) | PASS — 24/24 |
| Activation fixture (missing-provider negative) | Expected FAIL — 4 checks, correct rows |
| Functional E2E | 3 tool results successful, 2 host/service blockers recorded |

Logs: `evidence/product-typecheck.log`, `evidence/product-tests.log`,
`evidence/activation-stderr.log`, `evidence/e2e-stderr.log`.

## 12. Remaining HQ Edge dependencies

| Item | Status |
|---|---|
| `@huaqiu/dsh-eda-host` (11 tools) | Hard `hqEdge` inject; excluded from the bundle. Needs a native replacement or an authorized bridge. |
| `@huaqiu/dsh-tool-plugin-update` | `hqEdge + webServer`; excluded. Business logic remains HQ Edge-owned. |
| Quote backend | Optional and lazy; absence degrades to `FAILED_PRECONDITION`, never to a parked plugin. |
| Selection source | Optional and lazy; no source means no section and no chip. |
| `@huaqiu/dsh-hqsch`, `@huaqiu/dsh-analytics` | Present in the repo, not in the product bundle. |

No excluded package is silently loaded, and no included package injects `hqEdge`.

## 13. Recommended M2 work

1. Publish `@huaqiu/hardware-engineering@0.7.10` (requires explicit release authorization), then remove the single `pnpm-workspace.yaml` bridge and rerun both static gates.
2. Provide a managed Python environment with a KiCad-matching `kipy` and set `DSH_KICAD_PYTHON`; rerun the two IPC probes to convert F-01 from BLOCKED to a real PASS/UNSUPPORTED result.
3. Provision a quote backend via `HUAQIU_QUOTE_BASE_URL` and re-execute `quote_pcb`; keep the lazy capability model.
4. Obtain a Tier 1 Huaqiu EDA host for the matrix cells currently `NOT TESTED`; do not infer them from HQSCH service results.
5. Fix or reclassify the six pre-existing package test/typecheck failures before treating them as release blockers.
6. Decide tool-level error semantics for `FAILED_PRECONDITION` (F-03) so callers cannot mistake a blocked operation for a success.
7. Investigate graceful teardown (F-12) only if it affects Desktop quit behavior; it is not an activation gate.
8. Complete Desktop packaging/signing in M2 as specified; this M1 deliberately produced no signed installer.

## 14. Acceptance criteria mapping

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Bundle exists and packs | PASS | tarball + `check:publish` |
| 2 | Exact-pinned reproducible deps | PASS | packed manifest + ledger hashes |
| 3 | Activates in a real DSH profile | PASS | real `runProfile`, 11/11 ACTIVE |
| 4 | No HQ Edge required | PASS | no row injects `hqEdge`; no connection to 61431 |
| 5 | No network required | PASS | 0 blocked/loopback-only connects |
| 6 | Expected tools registered | PASS | 41 tools, all expected names |
| 7 | E2E on a Tier 1 host | **PARTIAL** | Tier 1 CLI + real files executed; live IPC blocked by `kipy` |
| 8 | Explicit Tier 0/1 results | PASS | capability matrix with evidence |
| 9 | Limitations classified | PASS | failure register with all required fields |
| 10 | Fork changed directly | PASS | `deepseek-harness` diff, no patch layer |
| 11 | Sandbox default preserved | PASS | `defaultMode=danger-full-access`, env unset |
| 12 | Report and artifacts complete | PASS | this report + `docs/m1/` |

---

## 15. Commit IDs

`dsh-pcb-eda` (logical units, oldest first):

| Commit | Contents |
|---|---|
| `21b5be1` | Product bundle package and HQ Edge migrations |
| `c0fa9c5` | 0.7.10 release metadata, lockfile and manifests |
| `27dec19` | M1 report, evidence, matrix, register and host artifacts |
| `43bb695` | Record commit IDs in the report |
| `e7eb678` | Exclude the product bundle from the plugin release catalog; refresh evidence and log files |

`deepseek-harness` (logical units, oldest first):

| Commit | Contents |
|---|---|
| `d883451aa1` | Installation dependency, desktop template, profile upgrade and static gates |
| `30511a631b` | Reproducible activation fixture and E2E runner |
| `b8f5d78dcd` | Typecheck fix for the branded E2E tool-call id |

Nothing was published to npm and no production release channel was changed.

---

## Artifact index

- `dist/huaqiu-hardware-engineering-0.7.10.tgz` — product tarball.
- `docs/m1/dependency-ledger.md` — versions and SHA-256 hashes.
- `docs/m1/evidence/` — activation, negative control, E2E, test and stderr logs.
- `docs/m1/capability-matrix.md` — executed host matrix.
- `docs/m1/failure-register.md` — classified failures.
- `docs/m1/e2e-execution-record.md` — short workflow record.
- `docs/m1/artifacts/tier0/`, `docs/m1/artifacts/tier1-huaqiu-kicad/` — real CLI outputs.
- `deepseek-harness/scripts/m1-activation/` — reproducible fixture and runner.

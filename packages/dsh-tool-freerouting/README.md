# DSH FreeRouting Plugin

[English](README.md) | [简体中文](README.zh-CN.md)

PCB autorouting for [DeepSeek Harness (DSH)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin), using KiCad's IPC API and a bundled FreeRouting engine. Package: `@huaqiu/dsh-tool-freerouting`.

**Status: Windows-only preview.** General PCB routing is available; differential-pair routing and electrical sign-off for crystal circuits are not supported. Review the result in KiCad before saving or manufacturing a board.

## Features

- Route the currently open PCB, including unsaved edits, while preserving existing tracks and vias.
- See intermediate tracks and vias directly in the KiCad PCB editor, with progress and diagnostic details in DSH.
- Import the final tracks and vias in one transaction, with rollback checks and one undo for the final additions.
- Run KiCad's design-rule check (DRC) on an offline candidate before importing it.
- Refill existing copper zones when requested; never create zones or save the PCB automatically.
- Download routing results and diagnostic reports during their retention period.
- Run locally with bundled Java and Python dependencies; no separate Python service or system Java installation is required.

## Requirements

| Component        | Supported configuration                                                               |
| ---------------- | ------------------------------------------------------------------------------------- |
| Operating system | Windows x64                                                                           |
| KiCad            | 10.0.6 or a later compatible 10.0 patch release, with bundled Windows x64 Python 3.11 |
| KiCad API        | Enabled in the PCB editor preferences                                                 |
| DSH              | Tested baseline: 0.1.7-rc.2; later versions require compatibility verification        |
| PCB              | Open in the editor and saved at least once; unsaved edits are included                |

Linux, macOS, other Python ABIs and older KiCad releases are not supported by this package. Preflight checks reject incompatible runtimes.

## Install

Use a plugin tarball built by this workspace. Its filename follows `huaqiu-dsh-tool-freerouting-<version>.tgz`. For version 0.5.20:

```powershell
dsh plugin --profile web add -w --ignore-scripts "C:/Downloads/huaqiu-dsh-tool-freerouting-0.5.20.tgz"
```

Restart DSH after installation or replacement. Load only one copy of the plugin; remove the earlier `dsh-plugin-freerouting` bundle if it is still configured. The plugin ID is `huaqiu-dsh-tool-freerouting`.

If the `dsh` command reports that no bundled runtime is registered, use the DSH CLI supplied by your KiCad distribution or fix that distribution's runtime registration first. Installing this plugin does not provide the DSH CLI.

## Configure

Add these overrides to the active DSH profile's `cordis.patch.yml`, replacing the Python path with the one from your KiCad installation:

```yaml
- id: huaqiu-dsh-tool-freerouting
  config:
    kicadPythonPath: C:/Program Files/KiCad/10.0/bin/python.exe
    kicadApiSocket: ''
    autoLaunchFreerouting: true
    freeroutingBaseUrl: http://127.0.0.1:37864
    realtime: true
    drawtimeSec: 5
    pollTimeoutMs: 1800000
```

With exactly one connectable PCB instance, the plugin selects it automatically. With multiple instances, set `kicadApiSocket` to the exact `ipc://...` address shown in the target editor's API preferences. The board and instance remain fixed for the task.

DSH bundled with KiCad can locate Python in its own installation. Standalone DSH should use an explicit `kicadPythonPath`. Runtime dependencies are loaded from the plugin, not installed into KiCad or system Python.

## Route a board

1. Open the target PCB and enable the KiCad API.
2. Ask DSH to call `pcb_route`. For example:

   ```text
   Use pcb_route to autoroute the current KiCad PCB. Preserve existing tracks
   and vias, do not skip any nets, and set fill_zones=false. Do not save the file.
   ```

3. Watch intermediate copper in KiCad and progress in the DSH task card. Do not edit, save or undo the board while the task is running.
4. Read the final report. Check remaining connections and run DRC in KiCad, resolve any reported problems, then save manually.

Live editor preview is enabled by default. The plugin attempts updates every five seconds, but visible changes depend on engine snapshots; this is not a guarantee that each new segment appears immediately. Set `realtime: false` for final-only import.

The default routing deadline is 30 minutes. One routing task is allowed across the plugin, with no queue. Closing the bound PCB editor cancels routing and stops plugin-owned compute processes. Closing the DSH browser tab does not cancel the task. A board write already in progress completes its commit or rollback instead of being forcibly killed.

## Result and recovery behavior

- Existing copper is preserved. Preview replaces only this task's temporary objects and is cleared before final import.
- A changed board or changed project rules cause import to be rejected. Results remain downloadable when available.
- The final additions use one undo transaction. Zone refill is a separate step. Older undo steps may restore intermediate preview copper; this is a known KiCad preview-history limitation.
- After verified routing-rule violations, the assistant can make one repair attempt and reroute. Remaining violations may still be imported with an explicit warning and report. **Imported does not mean DRC-clean or fully connected.** Failed checks, unsupported inputs and uncertain transactions are not bypassed.
- Zone-fill failure leaves successfully imported tracks in place and reports a partial result. No existing zones means refill is skipped.
- If import or rollback cannot be confirmed, the board is blocked from further routing until the user inspects it and explicitly confirms through `pcb_confirm_board_checked`.
- Results expire after one hour by default. Tasks and results do not recover across DSH restarts; only the minimal uncertain-board marker persists.

## Current limitations

| Area                     | Current behavior                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Differential pairs       | No accepted automatic differential backend. Recognized pairs are rejected before routing; net-name detection is not a complete electrical constraint model.            |
| Crystal circuits         | No electrical acceptance guarantee; circuit roles and explicit constraints are required.                                                                               |
| Selected or skipped nets | The bundled 2.5.0 engine has no verified filtering path. `pcb_route_nets` and nonempty `skip_nets` requests are rejected rather than silently routing the whole board. |
| Copper geometry          | Straight tracks and ordinary through-vias. Unsupported arcs, blind/buried vias or inputs that cannot be preserved are rejected.                                        |
| Custom design rules      | Unsupported `.kicad_dru` rules are rejected; arbitrary rule translation is not claimed.                                                                                |
| Connectivity             | Import success and complete connectivity are separate outcomes. Unverified connectivity is reported as unknown.                                                        |
| UI language              | Runtime progress and hardware-facing messages are currently Chinese.                                                                                                   |

Differential and crystal routing must not be advertised as implemented.

## Architecture

```text
DSH tool → TypeScript task service → FreeRouting HTTP engine (Java)
                        │
                        └→ one-shot Python helper → kipy → KiCad IPC API
```

The TypeScript layer owns tasks, engine processes, progress, results and cancellation. Short-lived Python helpers connect to KiCad; offline `pcbnew` operations handle board conversion and candidate checks. Python is not a resident service.

The engine is built from pinned FreeRouting 2.5.0 source with small, documented fixes for SES precision and final-output publication. The [engine README](engine/README.md) explains the three Java source files, the review patch and the rebuild procedure. They do not implement a replacement routing algorithm.

## Build from source

Run the following from the **monorepo root**, not the package directory. Requirements:

- Node.js 22.19+ within the 22.x line, or 24+; use the pnpm version pinned in the root `package.json` (currently 11.7.0).
- KiCad's Windows x64 Python 3.11 and a full JDK 25.
- A development Python with pip to install the pinned Ruff version.
- Network access for the first download of Python wheels, Temurin, Gradle and Maven dependencies.

```powershell
pnpm install --frozen-lockfile
python -m pip install -r packages/dsh-tool-freerouting/requirements-dev.txt
$env:DSH_IPC_TEST_PYTHON = 'C:/Program Files/KiCad/10.0/bin/python.exe'
$env:DSH_ENGINE_TEST_JDK = 'C:/path/to/jdk-25'
pnpm --filter @huaqiu/dsh-tool-freerouting exec playwright install chromium
pnpm --filter @huaqiu/dsh-tool-freerouting package:plugin
```

The final command prepares verified dependencies, builds the engine, runs checks and regression tests, builds the plugin, packs it and verifies a fresh installation. Output: `dist/huaqiu-dsh-tool-freerouting-<version>.tgz` inside this package.

| In Git                                                                     | Generated during preparation; included in the plugin tarball |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| TypeScript/Python sources and build scripts                                | Compiled JavaScript                                          |
| Fixed dependency URL/hash locks                                            | `python/vendor/`                                             |
| Pinned official engine source archive, modified sources, tests and license | `bundled/freerouting.jar` and its build provenance           |
| `bundled/runtime.lock.json`                                                | Complete `bundled/jre/`, including its legal notices         |

Build caches and test artifacts are neither source inputs nor release contents. `prepare:dependencies` can be run separately. Direct `pnpm pack` validates existing build inputs but does not download missing dependencies; missing, stale or corrupt inputs fail packaging.

The build verifies source and dependency hashes. It does not promise byte-identical JARs across builds because upstream includes timestamps; each release JAR is checked against its own build provenance.

## Testing

```powershell
pnpm --filter @huaqiu/dsh-tool-freerouting check
```

The checks cover formatting, lint, types, module boundaries, TypeScript/browser tests, Python tests, build dependencies and engine regressions. Use `package:plugin` for the complete packaging and fresh-install check.

Live KiCad tests require a generated, disposable `fixture.kicad_pcb`, its IPC address and a test engine. Never point them at a user's production board:

```powershell
$env:DSH_IPC_TEST_PYTHON = 'C:/Program Files/KiCad/10.0/bin/python.exe'
$env:DSH_IPC_TEST_SOCKET = 'ipc://<test-editor-socket>'
$env:DSH_IPC_TEST_ROUTER = 'http://127.0.0.1:37865'
pnpm --filter @huaqiu/dsh-tool-freerouting test:ipc-live
```

The editor-close test launches and closes its own disposable editor. It additionally requires an initialized, isolated KiCad `10.0` configuration directory:

```powershell
$env:DSH_IPC_TEST_CONFIG = 'C:/path/to/isolated-test-config/10.0'
pnpm --filter @huaqiu/dsh-tool-freerouting test:editor-close-live
```

Passing tests does not establish electrical suitability for every PCB. See the [Chinese technical notes](README.zh-CN.md) for additional test and runtime details.

## Contributing and reporting problems

Read [AGENTS.md](AGENTS.md) for module boundaries, coding rules and board-safety contracts. Keep changes focused, add relevant regression coverage, and explain non-obvious decisions in code comments or public build instructions. Internal design and acceptance documents are not part of the public source or release.

Report problems through the repository's issue tracker. Include the plugin, DSH and KiCad versions; the stage that failed; a minimal shareable board and project rules when possible; and a redacted diagnostic report. State whether the board changed and whether the result was saved. Do not include authentication tokens or confidential PCB data.

## Licensing and attribution

The first-party plugin code is licensed under the [MIT License](LICENSE), matching the repository root. Third-party components keep their own licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md) for the distribution boundaries.

The bundled, modified FreeRouting engine has its own [GPL-3.0 license](engine/LICENSE). Its pinned upstream source, local changes and build instructions are kept in [engine/](engine/). Java runtime legal notices are included under `bundled/jre/legal` after dependency preparation; Python dependencies retain their distribution metadata in `python/vendor`.

Thanks to [FreeRouting](https://github.com/freerouting/freerouting), [KiCad](https://www.kicad.org/), [kipy](https://docs.kicad.org/kicad-python-0.8.0/), and [Eclipse Temurin](https://adoptium.net/) for the underlying routing, editor API and runtime components.

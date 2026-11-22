# M1 — short E2E execution record

**Date:** 2026-11-23 (Asia/Shanghai)
**Fixture:** `deepseek-harness/scripts/m1-activation/e2e.ts`
**Command:** `npx tsx scripts/m1-activation/e2e.ts` from `deepseek-harness`
**Machine:** macOS, Node `v22.22.2`, pnpm `11.28.5`
**Profile:** `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@huaqiu/hardware-engineering']`
**Result:** activation checks **24/24 PASS**; five real tool dispatches, three
successful, one honest precondition failure from the tool, one structured
host blocker carried in the tool's value.

The bundle was booted from the packed tarballs in a throwaway installation.
Tools were dispatched through the live `ToolsService.execute()` path — the
same path model tool calls take — not by calling plugin functions directly.

## Steps and observed results

| §8 step | What was executed | Observed result |
|---|---|---|
| 1. Start Desktop | Real `runProfile` boot with the desktop bundle stack; web server bound to an ephemeral loopback port | PASS — `dsh web: http://127.0.0.1:…/`; all 11 product rows ACTIVE |
| 2. Open/create project | Existing KiCad board fixture `simple_led.kicad_pcb` (13 components, 102 pads, 101 traces, 1 zone, 8 vias, 2 layers, 80×60 mm) | PASS — file read and parsed |
| 3. Detect active EDA host | `kicad_ipc_diagnose` | **BLOCKED** — tool dispatched, returned `{ok:false, error.kind:"FAILED_PRECONDITION", "kicad-python (kipy) is not installed"}`; a throwaway `pip install kipy` also found no distribution |
| 4. Retrieve project context | `pcb_preview` on the board above | PASS — real board statistics and a `viewUrl` for the rendered view |
| 5. Search for a component | `search_hqsch_parts({query:"STM32F103", page:1, page_size:3})` | PASS — 161 real results; first `STM32F103CBU6TR`, HQ P/N `G3338201`, STMicroelectronics, with symbol and footprint flags |
| 6. Schematic/PCB operation | `kicad_ipc_verify_live` (creates/updates/deletes then drops the commit) | **BLOCKED** — `ModuleNotFoundError: No module named 'kipy'`; no board mutation occurred |
| 7. Generate preview/artifact | `pcb_preview` | PASS — `key=pcb-a4d2e400…`, `viewUrl=/pcb-viewer/api/file?key=…` |
| 8. BOM output | Official and Huaqiu `kicad-cli sch export bom` on `basic_test.kicad_sch` | PASS — `basic_test-bom.csv` (559 bytes) from both hosts; see `artifacts/` |
| 9. Quote | `quote_pcb({region:"cn"})` | **BLOCKED** — `quote: no hq-edge base URL available (edge-bridge service or HQ_EDGE_BASE_URL)`; separated from bundle success |

Native file operations on the Tier 1 host were also executed directly:
Huaqiu KiCad `kicad-cli version` returned `10.0.8`; PCB SVG export, PCB DRC,
schematic netlist, ERC, and BOM all exited `0` against the same fixtures.
Full command log: `artifacts/tier1-huaqiu-kicad/commands.log`.

## Network observation during the workflow

One outbound connect was recorded: `kiapi.eda.cn:443` from the part-search
service. This is expected for a **functional service call**; the separate
activation proof blocks all non-loopback TCP and still reaches 24/24 PASS.
Quote never reached a backend, so no fabricated price was returned.

## Tool-level error semantics (observation)

`kicad_ipc_diagnose` and `kicad_ipc_verify_live` returned `isError:false` while
carrying `{ok:false, error.kind:"FAILED_PRECONDITION"}` in `value`. A caller
that checks only `isError` would treat a blocked host operation as a success.
This is recorded as a follow-up, not hidden.

## Evidence

- `evidence/e2e-desktop.json` — all five invocations with args, values, errors, content, timing.
- `evidence/e2e-desktop.log` — readable rendering of the same run.
- `evidence/e2e-stderr.log` — captured stderr, including the quote warning.

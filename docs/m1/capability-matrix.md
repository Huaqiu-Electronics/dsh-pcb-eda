# M1 host capability matrix

Values follow the task spec exactly: **PASS**, **PARTIAL**, **UNSUPPORTED**,
**NOT TESTED**, **BLOCKED**. `NOT TESTED` is never converted into `UNSUPPORTED`.

Evidence paths are relative to `dsh-pcb-eda/docs/m1/`.

| Capability | Official KiCad (T0) | Huaqiu KiCad (T1) | Huaqiu EDA (T1) |
|---|---|---|---|
| Host detection | **PASS** — `kicad-cli version` → `10.0.7` (`artifacts/tier0/commands.log`). | **PARTIAL** — `kicad-cli version` → `10.0.8`; running app bundle reports `10.0.7-169-g739520d98a` and listens on `127.0.0.1:61429` with `/tmp/kicad/api.sock`. The bundle's `kicad_ipc_diagnose` is **BLOCKED** by missing `kipy` (`evidence/e2e-desktop.json` step 1). | **NOT TESTED** — no Huaqiu EDA host was detected on this machine. The running edge server is configured `--target-host=kicad --editor-type=generic`, so it is not evidence for a Huaqiu EDA host. |
| Project access | **PARTIAL** — `kicad-cli` accepts a real project/schematic and produced artifacts; no live project-session API was exercised. | **PARTIAL** — same CLI evidence with the Huaqiu binary; live IPC project access blocked by missing `kipy`. | **NOT TESTED**. |
| Schematic read | **PASS** — `sch export netlist` exit 0, `basic_test.net` (13,563 bytes). | **PASS** — same command exit 0 with Huaqiu `kicad-cli`, `basic_test.net`. | **NOT TESTED**. |
| Schematic modification | **NOT TESTED** — no tool that writes a schematic was invoked. | **NOT TESTED** — `create_kicad_hierarchy` and `edit_kicad_flat_schematic` registered but not executed. | **NOT TESTED**. |
| PCB read | **PASS** — `pcb export svg --layers F.Cu` exit 0 on the real board fixture (13 components / 102 pads / 101 traces / 1 zone / 8 vias / 2 layers). No board-preview tool is bundled. | **PASS** — same SVG export exit 0 with the Huaqiu binary. | **NOT TESTED**. |
| PCB modification | **NOT TESTED** — no Tier 0 write was executed. | **BLOCKED** — `kicad_ipc_verify_live` dispatched and returned `ModuleNotFoundError: No module named 'kipy'`; no board was mutated. | **NOT TESTED**. |
| Selection context | **NOT TESTED** — no host selection was retrieved and no selection plugin is bundled. | **NOT TESTED** — no selection source was available in this bundle. | **NOT TESTED**. |
| ERC/DRC | **PASS** — `pcb drc` exit 0 (15 violations, 0 unconnected), `sch erc` exit 0 (15 violations). | **PASS** — both checks exit 0 with the Huaqiu binary. | **NOT TESTED**. |
| BOM generation | **PASS** — `sch export bom` exit 0, `basic_test-bom.csv` (559 bytes). | **PASS** — same command exit 0 with the Huaqiu binary. | **NOT TESTED**. |
| Part search | **PASS (host-independent)** — `search_hqsch_parts` returned 161 real results (`STM32F103C8T7TR`, HQ P/N `G3337980`, datasheet URLs, symbol/footprint flags). This is a service capability, not a host capability; it does not attest to either KiCad host. | **PASS (host-independent)** — same executed service call. | **PASS (host-independent)** — same executed service call; the HQSCH API is the Huaqiu data service, not the EDA application. |
| Symbol/footprint generation | **NOT TESTED** — tools registered, none invoked with real dimensions or an image. | **NOT TESTED**. | **NOT TESTED**. |
| Quote/ordering | **BLOCKED** — `quote_pcb` returned `quote: no hq-edge base URL available`; no external quote service configured. | **BLOCKED** — same executed result. | **BLOCKED** — same executed result; no order was placed. |

## Huaqiu-only capabilities observed

These must not be read as available in official KiCad:

| Capability | Evidence | Official KiCad |
|---|---|---|
| HQSCH part search with Huaqiu part numbers and EDA-model flags | Executed service call in `evidence/e2e-desktop.json` | No equivalent executed; no claim made |
| Quote/order API via HQ Edge | Tool registered, call blocked by missing base URL | No equivalent executed |
| Huaqiu IPC/gRPC endpoint at `127.0.0.1:61429` plus `/tmp/kicad/api.sock` | `lsof` on the running Huaqiu KiCad process | Official KiCad 10.0.7 is installed but was not running; its IPC socket path was occupied by the Huaqiu fork, so a separate official-IPC session was **NOT TESTED** |

## Tier 1 workflow coverage

The §8 workflow was executed on Tier 1 **tooling** (Huaqiu KiCad `kicad-cli`
10.0.8, HQ Edge/part-search service) and on a real board fixture. The live
host-attached path through KiCad IPC could not complete because `kipy` is
absent. This is reported as **PARTIAL**, not as a successful Tier 1 workflow.

## Evidence inventory

- `artifacts/tier0/commands.log`, `artifacts/tier0/*` — official KiCad.
- `artifacts/tier1-huaqiu-kicad/commands.log`, `artifacts/tier1-huaqiu-kicad/*` — Huaqiu KiCad.
- `evidence/e2e-desktop.json` — tool-level execution against the packed bundle.
- `evidence/activation-desktop.json` — registration and activation evidence.

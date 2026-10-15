# DSH FreeRouting Plugin Coding Rules

## Scope and priorities

This workspace package is the release source for `@huaqiu/dsh-tool-freerouting`.
The prior `apps/dsh-plugin-freerouting` checkout is migration input only. Keep
test artifacts in this package's `.dsh-host-smoke/`; do not depend on temporary
implementation folders or another repository. Preserve unrelated workspace changes.

Prioritize maintainability, correctness, simplicity and then extensibility.
Before adding code, inspect existing implementations and dependencies, then the
official interfaces of suitable mature libraries. Add custom code only for a
documented requirement those interfaces do not meet. Remove obsolete internal
paths rather than leaving compatibility wrappers or parallel implementations.

## Actual architecture

| Location            | Responsibility                                                                     |
| ------------------- | ---------------------------------------------------------------------------------- |
| `src/client/`       | React views, browser hooks, browser API adapter and view schemas                   |
| `src/presentation/` | Plain-language outcome and progress text; no I/O                                   |
| `src/contracts/`    | Validated wire contracts shared with the browser                                   |
| `src/tools/`        | DSH tool registration, argument validation and dispatch                            |
| `src/runs/`         | Task lifetime, one routing round, previews, results and owned engine processes     |
| `src/ipc/`          | Bound KiCad session, one-shot helper transport, runtime selection and board guards |
| `src/proxy/`        | FreeRouting HTTP adapter, protocol validation and bounded polling                  |
| `python/`           | One-shot KiCad operations, offline conversion/checks and isolated Windows bindings |

Use these boundaries; create a new directory only for an actual responsibility.
Keep modules cohesive and first-party production files below 500 lines. Avoid
god classes, dumping files and speculative abstractions. Import types from their
owning module. Do not import other `@huaqiu/*` packages or another workspace
package's implementation. Browser modules must not import Node built-ins,
server modules, Python or process management.

The routing paths are separate: TypeScript calls the FreeRouting HTTP engine
(bundled Java), and spawns a one-shot Python helper that uses bundled `kipy` to
communicate with KiCad IPC. Python is not a resident service. Do not bypass these
paths from a component or introduce an HQ Edge/Bridge fallback.

## TypeScript and asynchronous control flow

- Give every if/else/for/while/do/switch/try/catch/finally body braces. Put body
  statements and comments on separate lines; even a one-statement block stays
  multi-line. The package ESLint configuration enforces the formatting rules.
- Use a condition-bearing loop, or `while (true)` with documented terminal,
  cancellation and finite-deadline exits. Reject non-finite or non-positive wait
  configuration. External task operations require finite timeouts; UI subscriptions
  must own cancellation and cleanup. Begun board writes retain transaction protection.
- Keep `strict` types and `noUncheckedIndexedAccess`. Validate external values
  as `unknown` with schemas before use. Avoid `any` and unchecked generic casts.
- Use one model per meaning. The pinned engine returns `state` and output `data`;
  internal routing output uses `sesBase64`. Do not guess `status`, `output`, `ses`
  or other aliases. An independently verified external protocol, if supported,
  must be normalized at its adapter without leaking aliases into business models.
- Use named async operations instead of async IIFEs. Observe rejected Promises;
  annotate deliberate fire-and-forget calls with `void` and handle their errors.
  Own every timer, listener, stream and child process until actual disposal.
- Retries must be bounded and justified by idempotency. Never retry an uncertain
  board import or a remote handle close that may already have consumed the handle.

## Dependencies and platform operations

Prefer Node standard APIs, existing project libraries, then a justified new
dependency. Use Execa for ordinary one-shot compute control, get-stream for
bounded response buffering, Zod for wire validation, Node fetch for HTTP and the
DSH logger for diagnostics. Node fetch already supplies the runtime HTTP client;
do not add undici, pino or a retry library simply because a template lists them.
Use p-retry only for a real bounded/idempotent retry need, not to hide failures.

Python library changes must work with the selected KiCad Python 3.11 and the
fixed bundled dependencies. Evaluate psutil, pywin32, httpx, pydantic or tenacity
only where they meet a concrete requirement. Keep Windows calls isolated in
`windows_api.py` and the responsibility-specific modules. The current exact
FILETIME, Job Object and remote-handle ownership requirements are documented in
ADRs 016 and 019; replacement must preserve them and pass real lifecycle tests.

Ordinary Execa timeout/buffer cancellation must not terminate a Python writer
mid-transaction. The protected IPC writer intentionally continues draining output
after its watchdog reports uncertainty. Retain that policy until a replacement
demonstrates the same commit/rollback and lifecycle behavior. Explain specialized
code and its replacement criteria in an ADR, not a contextless TODO.

Use argument arrays without a shell for product subprocesses. Product code must
not call PowerShell to discover KiCad or perform task operations. Use configured
`kicadPythonPath`, or the installation containing the bundled DSH executable;
standalone DSH requires explicit configuration when it cannot locate that runtime.
Keep install/build script shell behavior limited to required Windows CLI handling.

## React and styles

Components render and handle user intent. Hooks own asynchronous UI state and
cleanup; the browser API adapter performs requests and validates responses.
Avoid requests, polling loops, IPC and business orchestration inside components.
Support loading, empty/error states, explicit retry, accessible feedback and
unmount cancellation. Never automatically reroute or re-import from the card.

This release uses `src/client/routing-card.css`, bundled as text because the DSH
loader loads JavaScript modules only. Static layout/style belongs in that CSS
file, not React `style` objects. Dynamic runtime values are the narrow exception.
Tailwind is not an installed build dependency; a requested migration must first
establish its build and packaging path and preserve the existing card behavior.

Use intent-revealing names. Names such as `data` are acceptable at a defined
external protocol boundary; generic `utils`, `common` or `helper` files must not
accumulate unrelated logic. Existing helper entry points are named for their
actual one-shot protocol role.

## Board safety and product contracts

- Windows x64 and KiCad 10 only; fixed dependencies currently require KiCad
  10.0.6+ and its Python 3.11. Report unsupported inputs and missing capabilities.
- Keep one public DSH tool per operation: `pcb_route`, `pcb_route_nets`,
  `pcb_repair_route`, `pcb_cancel_route` and `pcb_confirm_board_checked`. No public
  mode switch. Preserve externally visible HTTP/tool contracts.
- Bind one board and instance for the task. Multiple connectable instances require
  explicit selection. Permit one global routing task, reject a second with the
  existing task ID, and do not queue. Export current IPC content from a board
  saved at least once; permit unsaved edits and reject changed boards on import.
- Preserve original tracks/vias/copper. Live preview replaces only objects owned
  by this run and clears them before final review, retry, cancellation or failure.
  Preview is not a checked result. Keep final import in one undo transaction;
  accepted KiCad preview history can reappear under older undo steps.
- Verify mapping, original-copper preservation and actual creation counts.
  Roll back any failed creation. Only verified DRC violations may trigger one
  automatic repair attempt and then reported partial import; never bypass a
  missing/failed check or an uncertain transaction. Normalize exact duplicate
  SES geometry only offline; reject mixed/partial overlaps and retain raw SES.
- Fill existing zones only, as a separate step. Report no zones or fill failure;
  keep successfully imported copper. Never save the board automatically. Report
  successful import separately from connectivity, marking unconfirmed connectivity
  unknown. Retain downloadable results for the existing one-hour TTL; no task or
  SES recovery across restarts and no automatic re-import.
- Editor closure cancels routing and stops owned compute processes; already begun
  board writes retain transaction protection. Verify an old engine is idle before
  reuse. Enforce existing memory/output limits. Persist an uncertain-board marker
  until the user explicitly confirms inspection; do not claim the board unchanged
  when rollback cannot be confirmed.
- Write user-facing messages in plain Chinese for hardware engineers. Explain
  what changed on the board, any remaining issue and the next action. Keep codes,
  task IDs and software/file-format details in diagnostics. Redact credentials
  and raw subprocess input/output from errors.

## Completion and evidence

Before editing a flow, inspect its consumers and run the relevant existing checks.
For a package change, use `package:plugin` to run the declared checks, build, pack
and fresh-install verification. Run isolated live IPC/editor/engine tests when
transactions or process lifetime change. A new guard must demonstrate a violating
input or other negative control, not merely a green assertion. Do not weaken or
skip checks to make a refactor pass.

Record non-obvious decisions in an ADR. Report completed work, meaningful checks,
unvalidated behavior and known limitations. Never equate green checks with "no
bugs", and do not push, publish, install into the active DSH or edit the user's
real board unless that action is authorized.

## Source checkout and runtime preparation

Keep generated `python/vendor`, `bundled/jre`, JAR/build metadata and `.build-cache` out of Git. Do not force-add omitted dependency files. Fixed URL/hash locks, engine sources, upstream source archive and build scripts remain source-controlled. Runtime dependencies are still mandatory in the plugin tarball. `package:plugin` prepares them before running the declared checks. Direct pack must reject missing, corrupt or stale build inputs. See ADR-025.

Use pip for wheel installation, the official full-source Gradle build for the engine, and the existing helper environment validator for bundled Python compatibility. Do not add consumer install hooks or global Python/Java modifications. Preserve LF for hash-pinned engine patch sources; generated JRE bytes come from the verified ZIP without Git normalization.

# @huaqiu/dsh-plugin-log

One shared log destination per **DSH process**, shared by every plugin loaded into
that process. Implements `docs/tasks/dsh-plugin-log-isolation.md`
(repo `hq-edge`); the implementation notes live in
`docs/dsh-plugin-log-isolation-implementation.md`.

The package name says "plugin log" because plugins are its users. The resource it
manages belongs to the DSH process: one process = one directory = one active file.

## Ownership model

```
installation_id    HQ Edge installation     (installation lifetime)
host_instance_id   EDA Host                 (host process lifetime)
edge_instance_id   HQ Edge                  (Edge process lifetime)
dsh_instance_id    DSH runtime              (DSH process lifetime)  ← owned here
plugin_id          attribution only — plugins own no files
```

`dsh_instance_id` is generated **once per DSH launch**. A DSH restart creates a new
directory; a plugin reload does not. HQ Edge never generates or reuses a DSH
identity — it only passes the parent levels down in the environment.

## Directory layout

```
$HQ_EDGE_HOME/logs/instances/<edge-instance-id>/dsh/       ← DSH log root
  <dsh-instance-id>/                                       ← owned by ONE DSH process
    instance.json                 identity of this process (written once, atomically)
    owner.lock                    diagnostic JSONL — existence NEVER implies ownership
    dsh.2026-11-11.log            active log (JSONL)
    dsh.2026-11-11.1.log.gz       published archives (atomic, never overwritten)
    recovery.log                  historical-recovery diagnostics
    fatal.log                     written only when the destination is unusable
```

Root precedence: `configureLogging({ dir })` → `$DSH_LOG_ROOT` →
`$HQ_EDGE_INSTANCE_ID` (`<logs>/instances/<edge>/dsh`) → `<logs>/dsh` (standalone DSH).
The per-process directory is **always** appended, so no caller can point the package
at a shared file.

## Usage

```ts
import { getLogger, createLogger } from '@huaqiu/dsh-plugin-log'

const log = getLogger('dsh-auth')            // legacy spelling
const log2 = createLogger({ pluginId: 'dsh-auth' })  // spec spelling, same thing

log.info('session restored', { user: 'u_1' })
log.error('token refresh failed', { status: 401 })
log.child({ module: 'refresh' }).warn('retrying')
```

Plugins must **not** call `configureLogging`, `flushLogs`, `shutdownLogging` or
`runMaintenance`. Those belong to the DSH host: a plugin that closed the shared
destination would silence every other plugin in the process.

Every record carries `time`, `ts`, `level`, `msg`, `pluginId`, `component`
(legacy alias), `installationId`, `hostType`, `hostInstanceId`, `edgeInstanceId`,
`dshInstanceId`, `pid`. `RESERVED_FIELDS` cannot be overridden by `fields` — a
plugin cannot spoof its identity, its level or its message.

## Host integration

| Call | Purpose |
| --- | --- |
| `configureLogging(options)` | DSH host / tests: root, level, rotation policy, clock, fault injection. Must run before the first record. |
| `installHostLogSink(sink)` | Delegate the transport to the DSH host instead of opening a file. Late installation is diagnosed, not applied. |
| `ready()` | Resolves once the destination is decided. |
| `flushLogs()` | Barrier: waits for the boot record and every pending write *and* any rotation they triggered. |
| `runMaintenance({ minAgeMs, retentionDays })` | Historical recovery + retention for sibling (dead) DSH directories. |
| `shutdownLogging()` | Final flush, close, release ownership. DSH shutdown only. |
| `getLoggingHealth()` | `state` (`initializing \| healthy \| degraded \| unavailable`), `droppedRecords`, `rotationCount`, `lastError`, `instanceDir`, `logFile`. |

Environment: `$DSH_LOG_ROOT`, `$HQ_EDGE_INSTANCE_ID`, `$HQ_EDGE_INSTALLATION_ID`,
`$HQ_HOST_TYPE`, `$HQ_HOST_INSTANCE_ID`, `$HQ_TARGET_HOST`, `$DSH_HOME`,
`$HQ_EDGE_HOME` (must be absolute), `$DSH_PLUGIN_LOG_LEVEL`,
`$DSH_PLUGIN_LOG_CONSOLE`. `$DSH_INSTANCE_ID` is accepted only as an injection hook
for tests/locally-driven runs — the parent must not set it in production.

## Safety rules

- **Exclusive ownership is OS-backed**: a bound endpoint (Windows named pipe
  `\\.\pipe\hq-edge-dsh-instance-<sha256(dir)>`, POSIX `<dir>/.owner.sock`). The OS
  closes it when the owner dies, including on a crash, so no stale lock, no PID
  heuristics, no heartbeat.
- **Historical work requires acquiring that directory's lock first.** If
  acquisition fails, the directory is left byte-for-byte alone.
- **Rotation is asynchronous and streaming**: seal → compress → verify (gzip
  trailer) → atomic publish (`link` + guarded `rename`) → delete source. Nothing
  overwrites an existing archive; every failure keeps the original data and caps
  unresolved artifacts at 6.
- **Bounded buffering before ownership exists** (2000 records / 1 MiB), replayed on
  acquisition. There is deliberately **no fallback** to a shared writable file.
- **Logging never throws into plugin business logic.** Destination failures degrade
  (`degraded`/`unavailable`) and count `droppedRecords` instead.
- **Process-wide state lives on `globalThis`**
  (`Symbol.for('@huaqiu/dsh-plugin-log/runtime')`), so a duplicated or bundled copy
  of this package joins the same destination instead of opening a second one.

## Browser half

`@huaqiu/dsh-plugin-log/client` mirrors the same `PluginLogger` surface onto
`console` with a `[pluginId]` prefix and keeps a 200-record ring for `dumpPluginLogs()`.
It shares `redact` and `RESERVED_FIELDS` through `fields.ts`, a leaf module with no
imports, so the browser bundle never pulls `node:fs` / `node:os`.

## Tests

```sh
pnpm --filter @huaqiu/dsh-plugin-log test
```

93 tests / 9 files, including real-subprocess isolation tests
(`test/fixtures/dsh-probe.ts`) for multi-process, crash-recovery and
concurrent-write behaviour.

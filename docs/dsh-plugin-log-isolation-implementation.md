# DSH plugin log isolation — implementation report

Status: **done** — `@huaqiu/dsh-plugin-log` 0.6.23 rewritten, 93 tests / 9 files green,
HQ Edge side wired, full workspace typecheck unchanged (two pre-existing, unrelated
failures remain).

Spec: `hq-edge/docs/tasks/dsh-plugin-log-isolation.md`.
Package: `dsh-pcb-eda/packages/dsh-plugin-log`.

---

## 1. What the previous implementation did, and why it had to change

| Concern | Before | Now |
| --- | --- | --- |
| Identity | 3 levels (installation → host → edge); plugins guessed their own | 4 levels, `dsh_instance_id` generated per DSH launch |
| Destination | one shared file `logs/dsh-plugins/dsh-plugins.log` for the whole installation | `<logs>/instances/<edge>/dsh/<dsh-instance>/dsh.<date>.log` |
| Writers | every DSH process + every plugin appending to the same file | exactly one owning DSH process per directory |
| Coordination | none — "who else has this open?" was unanswerable | OS-backed exclusive ownership of the directory |
| Rotation | synchronous `rename`-shift chain (`.log.1 .log.2 …`) | async seal → compress → verify → atomic publish, `.log.gz` |
| Crash safety | half-renamed chain members, unrecoverable | recovery from sealed/temp artifacts, verified before publish |
| Failure mode | a logging error could throw into plugin code | never throws; degrades with a health state and a drop counter |
| Shutdown | first plugin to unload could close the stream | only DSH shutdown flushes/closes; unload is a no-op |
| Attribution | `component` string, sometimes absent | `pluginId` (with `component` kept as legacy alias) |

The one thing that did **not** change is the plugin-facing call site: 12 packages
(16 files) still do `import { getLogger } from '@huaqiu/dsh-plugin-log'` and nothing
else.
No plugin calls `configureLogging`, `flushLogs`, `shutdownLogging`,
`runMaintenance` or `installHostLogSink` (verified by grep across the workspace) —
which is exactly the contract §6 asks for.

---

## 2. Identity (§1)

```
installation_id    HQ Edge installation
host_instance_id   EDA Host process
edge_instance_id   HQ Edge process
dsh_instance_id    DSH runtime process      ← added here
plugin_id          attribution only; no process identity, no file ownership
```

`createDshIdentity()` is called once per process, from
`initializeDshRuntime()`. `dsh_instance_id` comes from an explicit option (tests),
else `$DSH_INSTANCE_ID` (injection hook), else `randomUUID()`. HQ Edge deliberately
sets **neither**, so a restart always produces a new directory.

Parent levels are read with honest failure semantics:

```ts
function uuidOrNull(env, name, warnings): string | null {
  const value = envValue(env, name)
  if (value === undefined) return null
  if (isUuid(value)) return value
  warnings.push(`${name} is not a valid UUID and was ignored`)
  return null
}
```

An absent or malformed parent identity is recorded as `null`. Attributing a DSH
process to the wrong Edge instance is worse than attributing it to none, and a
fabricated UUID would silently collide with a real future directory.

`instance.json` (atomic, written once, never rewritten):

```json
{
  "schemaVersion": 1,
  "dshInstanceId": "…", "installationId": "…", "edgeInstanceId": "…",
  "hostType": "kicad", "hostInstanceId": "…", "targetHost": "…",
  "pid": 12345, "startedAt": "2026-11-11T…", "version": "0.6.23",
  "dshHome": "…", "logRoot": "…/instances/<edge>/dsh"
}
```

`readDshInstanceMetadata()` rejects a file whose `dshInstanceId` does not match the
directory name — the directory name is authoritative, so a copied or tampered
directory is treated as unreadable rather than as another process's data.

---

## 3. Layout (§3)

```
<HQ_EDGE_HOME>/logs/
  instances/<edge-instance-id>/
    dsh/                                   ← DSH log root (passed as $DSH_LOG_ROOT)
      <dsh-instance-id>/                   ← exclusively owned by ONE DSH process
        instance.json
        owner.lock                         diagnostic JSONL; existence ≠ ownership
        dsh.2026-11-11.log                 active, JSONL
        dsh.2026-11-11.1.log.gz            archive (atomic publish, never overwritten)
        recovery.log                       historical-recovery diagnostics
        fatal.log                          only when the destination is unusable
    server.*                               HQ Edge's own files — never touched
```

Root precedence (`readDshLogContext`):

1. explicit `configureLogging({ dir })` → `override`
2. `$DSH_LOG_ROOT` → `env:DSH_LOG_ROOT`
3. `$HQ_EDGE_INSTANCE_ID` → `<logs>/instances/<edge>/dsh` → `edge-instance`
4. otherwise `<logs>/dsh` → `unscoped` (standalone DSH)

The per-instance directory is always appended, so **no configuration can point the
package at a shared file**. The resolved source is reported in the boot record,
which is what makes "one editor logged and the other did not" a one-line diagnosis.

---

## 4. Ownership (§2.1, §4)

The lock is a **bound IPC endpoint held open by the owning process**:

| Platform | Endpoint |
| --- | --- |
| Windows | named pipe `\\.\pipe\hq-edge-dsh-instance-<sha256(dir)[0..32]>` |
| POSIX | unix socket `<dir>/.owner.sock` (stale sockets probed with a 250 ms connect) |

Properties that matter:

- The OS closes the handle when the process dies, **including on a crash** — no PID
  file, no heartbeat, no stale-timestamp heuristic, nothing to guess about.
- The key is the **resolved instance directory**, so two DSH processes under one
  Edge, two DSH processes under different Edges, and the Edge maintenance job never
  contend unless they genuinely target the same directory.
- `server.unref()` — holding the lock never keeps DSH alive.
- `owner.lock` is appended only after a **confirmed** bind. A losing process never
  writes into a directory it does not own.

Windows releases the pipe instance asynchronously, so acquisition retries on
`EADDRINUSE` (4 attempts, `15 ms × n`):

```ts
async function bindWithRetry(endpoint) {
  let bound = await bindServer(endpoint)
  for (let attempt = 0; attempt < 4 && !bound.ok && bound.code === 'EADDRINUSE'; attempt += 1) {
    try { bound.server.close() } catch {}
    await delay(15 * (attempt + 1))
    bound = await bindServer(endpoint)
  }
  return bound
}
```

This removes a race; it cannot steal a held lock, because a live owner fails every
attempt.

`acquireHistoricalDshOwnership()` is the stricter variant used by recovery: it
refuses to create the directory (a deleted directory stays deleted) and writes no
diagnostics into a directory it may not own.

---

## 5. Rotation (§5)

State machine, all on one serialized promise queue per process:

```
ACTIVE → ROTATION_REQUESTED → SEALING → ARCHIVING → VERIFYING → PUBLISHING → COMPLETED
```

| Step | Guarantee |
| --- | --- |
| Seal | `renameSync` to `…log.sealed-<uuid>` — a crash leaves a uniquely named artifact, never a half-renamed chain member |
| Compress | `pipeline(createReadStream, createGzip, createWriteStream{flags:'wx'})` — streamed, never whole-file, never overwrites |
| Verify | decompress the **whole** archive, validating the gzip trailer |
| Publish | `atomicPublish()`: `linkSync` then unlink source; `EEXIST` is a hard "do not overwrite"; guarded `renameSync` fallback only on filesystems without hard links |
| Sweep | delete the sealed source only after successful publication |

Failure handling is uniform: **the original data survives every branch**.

| Failure | Result |
| --- | --- |
| sealer fails | active file keeps being written, health = `degraded` |
| compression fails | sealed source preserved, only the incomplete `.gz.tmp-` is removed |
| verification fails | temp is quarantined (`…log.gz.tmp-<uuid>.quarantine-<uuid>`), never published |
| publish fails after verification | verified temp is preserved for recovery |
| device full (ENOSPC) | health = `degraded`, records counted as dropped, no throw |
| stream cannot open | `openAttempts` reset only after a **successful write**, so a persistently broken stream degrades instead of reopening once per record |

`MAX_UNRESOLVED_ARTIFACTS = 6` plus a cooldown bounds temp-file accumulation on a
filesystem that keeps rejecting publication.

Policy: daily + 10 MiB per file, 14 days, 256 MiB per instance directory, gzip on
(`DSH_ROTATION`). Plugin diagnostics are low volume; 256 MiB caps a pathological
plugin without competing with the parent Edge instance's own budget.

---

## 6. Recovery and retention (§5)

A DSH process only ever repairs **sibling** directories, and only after acquiring
their lock:

```ts
if (dir === options.ownInstanceDir) continue          // never its own
if (!metadata) { skippedInvalid += 1; continue }      // corrupt → preserved
if (recentGuard && Math.max(0, now() - stat.mtimeMs) < minAgeMs) { skippedRecent += 1; continue }
const ownership = await acquireHistoricalDshOwnership(dir, metadata.dshInstanceId)
if (!ownership) { skippedLive += 1; continue }        // a live DSH owns it → hands off
```

- `…log.sealed-<uuid>` → compress, verify, publish, delete source.
- `…log.gz.tmp-<uuid>` → verify; publish if valid, quarantine if not.
- Canonical archive already exists → the temp is **verified then removed as
  redundant**; the archive is never overwritten.
- Quarantined files are skipped on the next pass (idempotent).
- `recovery.log` is written into the **recovering** process's own directory.

Retention (`cleanupExpiredDshInstances`) deletes a directory only when ownership was
acquired (i.e. no live process), no sealed/temp/quarantine artifact remains, and
everything left is metadata (`instance.json`, `owner.lock`, `recovery.log`,
`fatal.log`, `logging-health.log`). Retention is measured on the directory's mtime.

The old shared `logs/dsh-plugins/` directory is **report only**:

> `Preserved N legacy shared plugin log file(s) (S bytes). No file was moved or
> deleted: ownership cannot be established from the old naming scheme.`

A rolling upgrade can still have an older build writing there, so retiring it is an
operator decision, not an automatic one.

### Windows timing defect found and fixed during this work

`now() - stat.mtimeMs` can be **negative** on NTFS, because a directory's mtime
rounds a few milliseconds into the future relative to `Date.now()`. With
`minAgeMs: 0` the guard therefore still fired and reported `skipped-recent`, which
made recovery skip a directory that was provably quiescent — the intermittent
recovery-test failure. Fixed by making an explicit `0` disable the comparison
entirely and clamping the age at zero:

```ts
const recentGuard = minAgeMs > 0
…
if (recentGuard && Math.max(0, now() - stat.mtimeMs) < minAgeMs) { … }
```

The same clamp is applied to the retention comparison, where `retentionDays: 0`
had the same latent defect.

---

## 7. Runtime and public API (§6)

Startup order in `initializeDshRuntime()` — no active file is opened before the
process knows it owns the directory:

1. resolve context (`readDshLogContext`)
2. `mkdirSync(dshLogRoot)` (recursive) — failure → `degraded('dsh-log-root-unavailable')`
3. generate identity; `mkdirSync(instanceDir)` **non-recursive**, so a UUID collision
   is visible instead of silently merged; on `EEXIST` adopt the directory only if its
   `instance.json` names the same id, otherwise retry with a new UUID (3 attempts)
4. write `instance.json` atomically
5. acquire the OS lock (async)
6. open the active file, replay the bounded buffer

Between step 1 and step 5 records are held in memory — `MAX_PENDING_RECORDS = 2000`,
`MAX_PENDING_BYTES = 1 MiB`, oldest dropped first and counted. **There is no
fallback to a shared writable file**: losing a record is preferable to writing it
into a directory the process does not own.

API:

| Export | Rule |
| --- | --- |
| `getLogger(pluginId, defaults)` / `createLogger({ pluginId })` | sync, never throws, never creates a transport per plugin |
| `configureLogging(options)` | host/tests only; before the first record |
| `installHostLogSink(sink)` | delegate transport to DSH; a late call is **ignored and diagnosed**, because switching now would abandon an owned directory |
| `flushLogs()` | complete barrier: awaits the boot record, then every pending write and their rotations |
| `shutdownLogging()` | flush + close + release; DSH shutdown only |
| `runMaintenance({ minAgeMs, retentionDays })` | historical recovery + retention |
| `getLoggingHealth()` | `initializing \| healthy \| degraded \| unavailable` + `droppedRecords`, `rotationCount`, `lastError` |

Record shape (JSONL, one line per record):

```
time ts level msg pluginId component installationId hostType hostInstanceId edgeInstanceId dshInstanceId pid
```

`RESERVED_FIELDS` is enforced in `sanitize()` — including for `child()` defaults —
so a plugin cannot set `level`, `msg`, `pluginId`, `dshInstanceId` or any parent
identity through `fields`. `serialize()` (JSON + redaction + key sanitisation) can
never throw: a `BigInt`, a cycle or a hostile `toJSON` degrades to a diagnostic
string instead of an exception in the caller.

Process-wide state lives on `globalThis` under
`Symbol.for('@huaqiu/dsh-plugin-log/runtime')`. That is what makes "the same
package loaded by two plugins" (two module instances, possibly two copies after
bundling) share **one** destination instead of racing for the lock and losing.

Two smaller but load-bearing details:

- **Stdio guard.** DSH's stdout/stderr are pipes owned by HQ Edge. A dead parent
  turns the next write into an asynchronous `EPIPE`, which without a listener is an
  uncaught exception — a log call would take DSH down. One `error` listener per
  stream marks the stream unusable and disables console mirroring only.
- **Boot barrier.** The boot record is emitted *after* the destination is decided,
  so `ownership`/`logFile` describe reality. `flushLogs()` awaits that promise;
  without it a flush could return before the banner and its triggered rotation
  landed (this was a real, reproducible test failure).

Redaction kept its credential rules but gained a UUID exemption: the previous
"32+ opaque characters" rule blanked every identity field in the record.

---

## 8. HQ Edge side

`apps/server/src/dsh/supervisor.ts` — `buildEnv()` now ends with:

```ts
export function applyDshLoggingContext(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  try {
    const identity = getProcessIdentity()
    const runtime = getLogRuntime()
    env.HQ_EDGE_INSTALLATION_ID ??= identity.installationId
    env.HQ_EDGE_INSTANCE_ID ??= identity.edgeInstanceId
    if (identity.hostTypeSource !== 'unknown') env.HQ_HOST_TYPE ??= identity.hostType
    if (identity.hostIdentityStatus === 'provided' && identity.hostInstanceId) {
      env.HQ_HOST_INSTANCE_ID ??= identity.hostInstanceId
    }
    env.DSH_LOG_ROOT ??= path.join(runtime.instanceDir, 'dsh')
  } catch {
    /* DSH then resolves its own unscoped root */
  }
  return env
}
```

- `??=` everywhere: an operator-provided override always wins.
- `DSH_LOG_ROOT` points inside **this** Edge instance's directory, so DSH logs sit
  next to the Edge logs that describe the same session.
- HQ Edge never sets `DSH_INSTANCE_ID` — that is the whole point of the handover.
- The whole block is best-effort: if the Edge identity is unavailable, DSH falls
  back to its own unscoped root rather than failing to launch.

Tests: `apps/server/src/dsh/__tests__/dshLoggingContext.test.ts`, 5 cases
(propagates the four levels + `DSH_LOG_ROOT`; points inside the Edge instance
directory; never supplies `DSH_INSTANCE_ID`; does not clobber explicit overrides;
mutates and returns the given object). `apps/server` typecheck exits 0.

HQ Edge does **not** rotate, compress or delete DSH logs. Its own logging subsystem
and the DSH subsystem share the *rules* in §5, not the files.

---

## 9. Acceptance tests (§7)

| Spec test | Test |
| --- | --- |
| Multiple plugins use the package → one destination | `logger.test.ts` → *unifies every plugin in ONE file inside ONE instance directory* |
| Two plugins log concurrently → no corruption/loss | `logger.test.ts` → *does not create competing transports when several plugins log concurrently*; `isolation.test.ts` → *writes every plugin record through one destination with no NUL holes* (250 records) |
| Plugin unload → destination remains | `logger.test.ts` → *keeps the destination available after a plugin is unloaded*; `faults.test.ts` → *does not close the shared destination when a plugin disappears* |
| Plugin reload → no duplicate transport | `logger.test.ts` → *keeps one destination across a plugin reload (same id, no extra transport)* |
| DSH restart → new id and directory | `identity.test.ts` → *generates a different dsh_instance_id for every launch*; `isolation.test.ts` → *creates a new directory on DSH restart and preserves the previous log* |
| Two DSH under different Edge → independent | `isolation.test.ts` → *gives two DSH processes under different Edge processes independent logs* |
| Two DSH launches under one Edge → independent | `isolation.test.ts` → *gives two DSH launches under ONE Edge process independent logs* |
| DSH crash during rotation → recovery works | `isolation.test.ts` → *recovers a rotation interrupted by a crash and keeps every record*; `ownership.test.ts` → *releases the lock when the owner exits without shutting down* |
| HQ Edge restart while DSH active → no concurrent modification | `isolation.test.ts` → *never writes into a live DSH directory or loses records under concurrency*; `ownership.test.ts` → *refuses a second owner while a DSH process holds the directory*; `recovery.test.ts` → *skips a directory owned by a live DSH process*; *never deletes a live instance* |
| Destination failure → plugins not disrupted | `faults.test.ts` → *degrades without throwing when the log root cannot be created*, *refuses to write into a directory another process owns*, *never falls back to the legacy shared plugin log*; `rotation.test.ts` → ENOSPC, stream-open, publish/gzip/seal failures; `logger.test.ts` → *never throws from a log call* |
| Same package loaded twice → correct attribution | `logger.test.ts` → *writes JSONL records carrying pluginId, level, message and full identity*, *accepts a full package name as the plugin id*; `faults.test.ts` → *keeps initialization idempotent across repeated getLogger calls* |

§7 P0 items 1–12 are all implemented; items 11–12 (no competition with HQ Edge, DSH
restart isolation) are covered by the `isolation.test.ts` group
*leaves HQ Edge logs untouched when only DSH state exists* and the restart case above.

### Test inventory (93 tests / 9 files)

| File | Tests | Covers |
| --- | --- | --- |
| `logger.test.ts` | 17 | attribution, one destination, reload/unload, concurrency, reserved fields, levels, redaction, console mirroring, never-throws, health |
| `identity.test.ts` | 14 | context resolution, malformed identities → `null`, per-launch UUID, metadata corruption/NUL/mismatch |
| `home.test.ts` | 9 | root precedence, relative `HQ_EDGE_HOME` rejected, instance level always appended, `instance.json` |
| `rotation.test.ts` | 10 | lossless size rotation, no `.gz.N` chain, date rotation, never overwrite, every failure path, ENOSPC, stream-open |
| `recovery.test.ts` | 13 | sealed→archive, temp publication, quarantine, no overwrite, live skip, corrupt metadata, idempotence, retention, artifacts, legacy report |
| `isolation.test.ts` | 7 | real subprocesses: two Edges, two DSH under one Edge, restart, 250 concurrent records, crash-recovery, no `server.*` in the DSH directory |
| `ownership.test.ts` | 7 | live exclusion, release on abnormal exit, `owner.lock` diagnostic-only, one owner per directory, no cross-directory contention |
| `faults.test.ts` | 9 | unusable root, foreign directory, no legacy fallback, host sink (incl. late install), unload, idempotent init |
| `redact.test.ts` | 7 | credential rules (UUID exemption is in `logger.test.ts`) |

Subprocess tests use a real `node --import tsx` fixture (`test/fixtures/dsh-probe.ts`)
with modes `write`, `hold`, `hold-no-shutdown`, `concurrent`, `rotate`,
`rotate-crash`, `maintenance` — multi-process behaviour is not simulated in-process.

### Verification

```
pnpm --filter @huaqiu/dsh-plugin-log test     → 93/93, 9 files (4 consecutive runs)
npx tsc --noEmit (package)                    → exit 0
pnpm -r --filter "...@huaqiu/dsh-plugin-log" typecheck → only the 2 pre-existing failures
apps/server typecheck                         → exit 0
build                                         → lib/index.mjs 84.7 kB, lib/client.js 8.45 kB
```

Pre-existing, unrelated failures (unchanged, package untouched):
`packages/dsh-kicad-drc` (Koffi `Volatile<>` schema type) and
`packages/dsh-tool-plugin-update` (`Cannot find module '@huaqiu/dsh-sidebar-entry'`).

---

## 10. Known limitations / follow-ups

1. **No cross-installation cleanup.** Retention only ever walks the current DSH log
   root. An installation that is deleted leaves its `logs/instances/<edge>/` tree
   behind; retiring that is an HQ Edge concern, not DSH's.
2. **Single-writer assumption per directory** is enforced by the OS lock, not
   verified afterwards. A process that bypasses the lock (a debugger, a hand-edited
   copy) can still append.
3. **Legacy migration is manual.** `logs/dsh-plugins/` is reported, never moved.
4. **`$DSH_INSTANCE_ID` exists as an injection hook.** It is used only by tests and
   by host-driven local runs; HQ Edge must never set it. If a future host wants
   restart continuity it should generate a *new* id, not reuse one.
5. **Version not bumped.** The repo bumps all packages together in a dedicated
   `chore:` commit; this change is source-compatible with the 12 consuming packages
   (`getLogger` / `PluginLogger` only), so it needs no coordinated release.
6. **`docs/dsh-kicad-migration.md`** previously cited the old shared log path; it now
   names both, since the records it quotes were produced before this change.

# FreeRouting engine source and local changes

[English](README.md) | [简体中文](README.zh-CN.md)

This directory contains the build inputs for the engine shipped with `@huaqiu/dsh-tool-freerouting`. It uses FreeRouting **v2.5.0**, upstream revision `b647a2f824cfbc54bc4dcaee71b03b7cd945eb76`, with local patch ID `dsh-freerouting-2.5.0-1`.

The plugin ships a complete Eclipse Temurin Java 25 Windows x64 JRE. End users do not need system Java; building the engine requires a full JDK 25.

## Why these Java files exist

These are narrowly scoped changes to the upstream engine, not a new autorouter or a differential-routing algorithm.

| File                                                                       | Role                                                                                                                                                                                  | Why it is retained                                                                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/freerouting/io/specctra/SesTracePath.java`                        | Encodes track paths for the SES result. Preserves short nonzero segments at higher output precision, retains real width-bearing point copper and rejects unrepresentable coordinates. | Prevents coordinate rounding or endpoint snapping from losing or fabricating copper geometry.                                                                                                |
| `src/app/freerouting/io/specctra/SesWriter.java`                           | Modified upstream writer; delegates track-path encoding to `SesTracePath`.                                                                                                            | Connects the precision fix to actual engine output while retaining other upstream export behavior.                                                                                           |
| `src/app/freerouting/management/jobs/RoutingJobSchedulerActionThread.java` | Modified upstream job worker; publishes a fresh snapshot, invalidates stale output on export failure, preserves timeout/cancel states and ends its monitor when the job terminates.   | Prevents an earlier preview from being presented as a successful final result.                                                                                                               |
| `reviewed-changes.patch`                                                   | Human-readable differences for modified upstream files and tests.                                                                                                                     | Supports code review and comparison with upstream. It is not applied by the build and is not a complete standalone patch: the new `SesTracePath.java` module is stored separately in `src/`. |

`build.py` verifies the source archive and the three Java files against `source.lock.json`, extracts the official source into a temporary build directory, overlays those Java files and the updated tests, then invokes the official Gradle build. Removing a Java file breaks the locked source set; reverting a fix requires updating the lock and validating the affected regressions.

The review patch could be generated instead of checked in, but that requires a documented replacement workflow. It is not a runtime dependency. The Java source files remain necessary for the current source build and for reviewing the modified engine shipped to users.

The idle scheduler-loop fix is already in the pinned upstream version. There is no local copy of the old scheduler override. The worker file above fixes output publication and terminal-state handling, which are separate concerns.

## Source layout

- `upstream-2.5.0-source.zip`: complete pinned application source, resources, Gradle scripts and wrapper. It is a source input, not a Java runtime or compiled dependency bundle.
- `source.lock.json`: upstream revision, archive hash, Java release and modified source hashes.
- `src/`: the three modified or added Java source files overlaid during the build.
- `tests/upstream/`: adjusted upstream tests for the changed module and worker behavior.
- `tests/`: plugin-specific precision, final-output, scheduler and HTTP regression checks.
- `LICENSE`: the engine's GPL-3.0 license.

Generated JARs, build metadata, caches and JRE files are excluded from Git. They are prepared and included in the plugin release tarball. See the [package README](../README.md#build-from-source) for the complete build.

## Build the engine

From the plugin package directory:

```powershell
python engine/build.py --jdk 'C:/path/to/jdk-25' --output 'C:/path/to/build/freerouting.jar' --gradle-cache 'C:/path/to/gradle-cache' --check
```

The first build requires access to Gradle and Maven repositories. `--check` runs the selected upstream scheduler, worker, SES round-trip and package-architecture tests. Build output is written to the JAR's adjacent `.build.log`; `.build.json` records source provenance, the output hash and test status.

Upstream build timestamps can change the JAR hash between builds. Each JAR is verified against its own provenance record; editing that record is not a substitute for rebuilding and testing.

## Run engine regressions

From the monorepo root:

```powershell
$env:DSH_IPC_TEST_PYTHON = 'C:/Program Files/KiCad/10.0/bin/python.exe'
$env:DSH_ENGINE_TEST_JDK = 'C:/path/to/jdk-25'
pnpm --filter @huaqiu/dsh-tool-freerouting test:engine
```

Checks include real HTTP jobs, changing previews, cancellation, pass limits, deadlines, precision and KiCad import, idle scheduler allocation, failed final exports and worker termination. Editor-visible previews, final import, undo and editor-close cleanup require the package's separate live KiCad tests.

## Maintaining or removing the changes

Keep the pinned source, overlays, review diff and regression fixtures consistent. A new upstream release can replace a local fix only after the corresponding regression passes without that overlay. Do not remove the files solely to reduce repository size or replace the build with an unexplained prebuilt JAR.

The SES precision fix preserves real point copper as well as short segments, rather than deleting or extending it. Successful export is not equivalent to complete connectivity or electrical acceptance.

## License

The engine and its local changes are distributed under the license in [LICENSE](LICENSE). Java runtime notices are shipped in `bundled/jre/legal` in the prepared plugin. This engine license is distinct from the package's own metadata.

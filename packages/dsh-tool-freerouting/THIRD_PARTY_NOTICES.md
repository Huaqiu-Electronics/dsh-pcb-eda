# Third-party notices

## Plugin code

The first-party TypeScript and Python plugin code is licensed under the
[MIT License](LICENSE). This does not relicense third-party code distributed
with the plugin. Each third-party component retains its own license.

## FreeRouting engine

The engine is based on [FreeRouting](https://github.com/freerouting/freerouting)
v2.5.0, revision `b647a2f824cfbc54bc4dcaee71b03b7cd945eb76`, with local
changes identified by `dsh-freerouting-2.5.0-1`. The engine and these changes
are distributed under [GPL-3.0](engine/LICENSE), separately from the plugin's
MIT code. Upstream copyright notices are preserved in the source files.

The release includes `engine/upstream-2.5.0-source.zip`, the modified/added
Java sources in `engine/src/`, regression tests, the source hash lock and
build scripts. See [engine/README.md](engine/README.md) for the source layout
and rebuild instructions. `bundled/freerouting.jar` is built from those inputs;
its adjacent build metadata records the input and output hashes.

## Runtime and library dependencies

- Eclipse Temurin Java 25 is distributed under its upstream terms. The complete
  runtime's legal notices are retained under `bundled/jre/legal/`.
- Bundled Python wheels retain their license files and distribution metadata
  under `python/vendor/`. Pinned package versions, wheel origins and hashes are
  recorded in `python/dependencies.lock.json`.
- Node dependencies retain their own licenses in their installed packages.
  Their versions are declared in `package.json` and the workspace lockfile.

Internal design and acceptance documents in `docs/` are excluded from Git and
the plugin release. The public README files, licenses, engine sources and build
instructions remain available.

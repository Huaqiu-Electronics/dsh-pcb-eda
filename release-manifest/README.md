# @huaqiu/dsh-plugin-release-manifest

Canonical, immutable npm release catalog for the DSH ecosystem. This package is
**data only**: no runtime JavaScript, no dependencies, no release logic. It is
the single source of truth for:

- `plugins-release-manifest.json` — the complete set of officially available
  DSH plugins and their compatibility metadata;
- `edge-headless-release-manifest.json` — the published HQ Edge headless
  distributions (version, platform, archive URL and SHA-256).

HQ Edge consumes these two manifests for plugin/headless version discovery.
Its packaging build manifest stays in the `hq-edge` repository: that file
holds only HQ Edge-owned runtime dependency pins and non-registry plugin
sources, and derives published plugin versions from
`plugins-release-manifest.json` so versions are not duplicated. Repository-root
JSON files and Gitee raw URLs are no longer authoritative.

Every change is published as a new immutable package version. The npm
`latest` dist-tag identifies the current canonical catalog. Exact versions
remain available for debugging and historical investigation.

`manifestPackageVersion` in every JSON file must equal this package's
`version`. `pnpm bump` keeps this package and both stamps on the same lockstep
version as the workspace, and `pnpm publish:local` publishes this package last
so it can only describe already-published plugin versions. HQ Edge resolves
`dist-tags.latest` and rejects any delivery endpoint that does not serve that
exact version (including a mirror serving an older catalog).

## Manual release

The catalog is published by an operator as the **final step** of a plugin or
runtime release, after every referenced artifact has been published and
verified:

```sh
# From the repository root. Dry-run by default; nothing is published.
pnpm manifest:prepare --candidates-file /path/to/candidates.json

# Operator-controlled final commit point.
pnpm manifest:publish --candidates-file /path/to/candidates.json
```

`scripts/release-manifest.mjs` reads the current published catalog from npm,
preserves all existing entries unless explicitly replaced, resolves
standalone-plugin versions from npm, verifies newly published plugin artifacts,
re-checks `dist-tags.latest` to guard against a concurrent release, and writes
both JSON files here. `pnpm bump` keeps the package version, both
`manifestPackageVersion` stamps, the plugin entries and `pluginSetVersion`
aligned with the lockstep workspace version.

A candidates file may contain:

```json
{
  "plugins": { "@huaqiu/dsh-auth": "0.6.30" },
  "setVersion": "0.6.30",
  "edgeHeadless": {
    "releases": [
      {
        "version": "0.3.11",
        "sha256": "...64-hex...",
        "platform": "win",
        "arch": "x64",
        "url": "https://down.eda.cn/...zip"
      }
    ]
  }
}
```

`edgeHeadless.releases` replaces the published release list when supplied.
Omitting it preserves the existing list unchanged. A single release object may
also be supplied as `edgeHeadlessRelease` to upsert by
`version + platform + arch`.

Standalone plugins (`@huaqiu/dsh-kicad-drc`, `@huaqiu/dsh-tool-freerouting`)
are published from their own repositories. Their versions are never inferred
from this monorepo.

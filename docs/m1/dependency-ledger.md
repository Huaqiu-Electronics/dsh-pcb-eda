# M1 dependency / version ledger

Generated from the **packed** artifacts, not from workspace manifests. The
fixture's closure walk reads each tarball's `package.json`, so a declared
dependency with no artifact is a hard build error.

## Product package

| Field | Value |
|---|---|
| Package | `@huaqiu/hardware-engineering` |
| Version | `0.7.10` |
| Manifest | `packages/hardware-engineering/package.json` |
| Bundle patch | `cordis.patch.yml` (`dsh.bundle.patch`) |
| `engines.dsh` | `^0.2.2-rc.1` |
| Peer | `@deepseek-ai/cordis@^4.0.1` |
| Tarball | `dist/huaqiu-hardware-engineering-0.7.10.tgz` |
| SHA-256 | `601d8053dab8fbd446669ad112462bec9f16180fdb932d06e08cc6ae875a768a` |

Source manifests use the repository's lockstep `workspace:*` convention.
`pnpm pack` rewrites every one of them to the exact version `0.7.10`; the
packed manifest was inspected and contains **no** `workspace:` specifier.

## Direct dependencies (11, exact-pinned in the tarball)

| Package | Packed version | Tarball SHA-256 (first 16) |
|---|---|---|
| `@huaqiu/dsh-artifacts` | `0.7.10` | `320400ae5861122` |
| `@huaqiu/dsh-eda-selection` | `0.7.10` | `92779124638aae` |
| `@huaqiu/dsh-huaqiu-about` | `0.7.10` | `120ef9b056b7bb` |
| `@huaqiu/dsh-auth` | `0.7.10` | `dc6ebe55231e49` |
| `@huaqiu/dsh-tool-part-search` | `0.7.10` | `b8f8f7ba398094` |
| `@huaqiu/dsh-tool-kicad-schematic-gen` | `0.7.10` | `c73c2a8ab02111` |
| `@huaqiu/dsh-tool-pcb-viewer` | `0.7.10` | `738524b5017b18` |
| `@huaqiu/dsh-tool-quote` | `0.7.10` | `b8e862be3a1ebf` |
| `@huaqiu/dsh-tool-symbol-footprint` | `0.7.10` | `6fff7a248213ed` |
| `@huaqiu/dsh-ui-theme-huaqiu` | `0.7.10` | `8b1a8d329c5de3` |
| `@huaqiu/dsh-kicad` | `0.7.10` | `dbb7ab3603a82b` |

## Full closure found by the fixture

The fixture walks `@huaqiu/*` dependencies transitively. It found four more
workspace packages and two already-published packages:

| Package | Kind | Version | Why it is present |
|---|---|---|---|
| `@huaqiu/dsh-plugin-log` | packed | `0.7.10` | declared by `dsh-tool-part-search` / `dsh-tool-kicad-schematic-gen` |
| `@huaqiu/dsh-sidebar-entry` | packed | `0.7.10` | declared by `dsh-tool-kicad-schematic-gen` |
| `@huaqiu/component-gen-server` | packed | `0.7.10` | declared deeper in the closure |
| `@huaqiu/part-search` | published | `0.2.6` | HQSCH API client, declared by `dsh-tool-part-search` |
| `@huaqiu/kicad-sexpr-parser` | published | `0.1.1` | declared deeper in the closure |

Tarball SHA-256, remaining packed members:

| Tarball | SHA-256 |
|---|---|
| `huaqiu-dsh-plugin-log-0.7.10.tgz` | `bd5257dfbac1324baece1067148c63dea91810df1b119d7c902ae28de72d2d8a` |
| `huaqiu-dsh-sidebar-entry-0.7.10.tgz` | `ff95f1d3550e133250f9d811a66120453f9314a62f2057aeec4c558810ce98be` |
| `huaqiu-component-gen-server-0.7.10.tgz` | `3ab2a32328c5115d87d6d62de42dac90c7b5a04581e369e05eac21f5bfb85c6c` |

Third-party dependencies are linked from the resolved workspace copies
(`kicad-sexpr-parser@1.5.3`, `pdfjs-dist@6.3.289`, `sharp@0.35.4`, `fflate`,
`undici`, …). They are declared in the individual plugin manifests; the
fixture verifies that each declaration resolves to a real installed copy.

## Host-provided, not packed

`@deepseek-ai/*` packages (cordis, base/web bundles, tools, app-boot, …) are
supplied by the DSH installation. The fixture links the installation scope
rather than copying a second one, so every plugin and the host share one
`cordis` instance. A duplicate copy would break service identity silently.

## Excluded from the product bundle

These are installed but deliberately not inserted as rows:

| Package | Reason |
|---|---|
| `@huaqiu/dsh-eda-host` | 11 tools require an HQ Edge HTTP bridge absent from the target runtime. |
| `@huaqiu/dsh-tool-plugin-update` | Discovery/install is HQ Edge-owned business logic. |
| `@huaqiu/dsh-hqsch` | Teaches TypeScript-against-HQ-EDA, outside the POC workflow. |
| `@huaqiu/dsh-analytics` | Telemetry, not required to prove the product. |

Evidence: `docs/m1/evidence/activation-desktop.json` (`closure`, `installed`,
and each active row's `dir` and `version`).

# @huaqiu/hardware-artifacts

Hardware Engineering host capability. It is a local Cordis plugin, not a daemon and not an HQ Edge dependency.

- Deterministically discovers one selected `.kicad_pro`, its schematic hierarchy, boards and mechanical models. Multiple projects/boards require explicit selection; the package never silently takes the first match.
- Resolves configured KiCad and SolidCraft installations from user-scoped settings. KiCad CLI and GUI editors are resolved from one installation root; SolidCraft stays disabled when unconfigured.
- Launches the exact displayed artifact with explicit `argv`, the artifact's parent as cwd, no shell, and a detached process.
- Exposes a compact `<hardware_environment>` prompt context and `HUAQIU_*` child-process environment values without mutating global `process.env`.
- Serves read-only same-origin routes under `/api/v1/hardware`.

Native KiCad files remain authoritative. The service stores path pointers only.

# Hardware Engineering — Toolchain Onboarding, Configuration and Download Implementation Specification

**Priority:** P0  
**Type:** Implementation code specification  
**Product:** HuaQiu Electronic Design Agent Platform — Hardware Engineering  
**Target:** Huaqiu DSH Desktop, Windows x64 first  
**Primary tools:** KiCad (`kicad-cli`) and SolidCraft 3D CAD  
**UX reference:**
- `C:\code\dsh-pcb-eda\docs\prototype\huaqiu_eda_hardware_toolchain_ux_prototype.html`
- `C:\code\dsh-pcb-eda\docs\prototype\prototype_feature_ux_summary.md`

**Implementation principle:** Reuse DSH settings, filesystem, native dialogs, notifications and application lifecycle. Do not introduce a separate toolchain manager application or daemon.

---

## 1. Objective

Implement a complete onboarding and configuration experience for the external hardware design toolchain required by Hardware Engineering.

The application needs to configure two tools:

| Tool | Primary executable | Purpose |
|---|---|---|
| KiCad | `kicad-cli.exe` | BOM generation, Gerber/drill export, fabrication preparation and other KiCad CLI operations |
| SolidCraft | `solidcraft.exe` and `solidcraft-cli.exe` | 3D CAD application and supported command-line operations |

The UX must support three configuration paths for each tool:

1. Manually enter an executable path or installation directory.
2. Browse for an existing local installation using the system file picker.
3. Download a portable installation directly from the HuaQiu distribution server on Windows.

The experience consists of:

- An automatic first-launch setup wizard.
- A persistent Settings → Hardware Engineering configuration panel.
- Background discovery of pre-installed toolchains.
- Download progress and automatic extraction.
- Executable validation and version reporting.
- Configuration status synchronization.
- Non-blocking reminders when setup is skipped or incomplete.

The setup wizard must never block application startup or require a successful pre-installation discovery operation.

## 2. Architecture and ownership

### 2.1 Reuse existing DSH infrastructure

Before implementation, inspect the current DSH source and use the existing mechanisms for:

- Plugin registration and lifecycle.
- Settings sections and configuration forms.
- Persistent user configuration.
- Native file/folder selection dialogs.
- Filesystem access.
- Background subprocess execution.
- Notifications/toasts.
- Sidebar navigation and status indicators.
- Application startup and first-launch state.

The existing DSH settings infrastructure should own the configuration persistence.

Hardware Engineering owns:

- Toolchain discovery logic.
- Toolchain manifest interpretation.
- Executable validation.
- Version detection.
- Download and extraction orchestration.
- Toolchain-specific configuration UI.
- Agent-facing toolchain capability reporting.

Do not introduce another settings database or generic filesystem service.

### 2.2 Package boundaries

Implement within the existing Hardware Engineering plugin structure.

Prefer keeping the implementation in the existing packages:

- `@huaqiu/hardware-engineering`
- `@huaqiu/dsh-hardware-ui`

Use the existing DSH configuration and host APIs.

Extract a separate reusable package only if source inspection demonstrates that the functionality is independently reusable and the existing package boundaries make direct implementation inappropriate.

### 2.3 Runtime constraints

- DSH Desktop owns application lifecycle.
- No additional daemon.
- No HQ Edge runtime dependency.
- No Python runtime dependency.
- No Docker dependency.
- No external browser automation.
- No development-machine-only executable paths.
- Windows x64 is the initial full download/install target.
- Other platforms retain manual configuration and official download links.

---

## 3. Toolchain configuration model

### 3.1 Configuration semantics

Store the installation location as the primary configuration, then resolve the actual executables from it.

For KiCad, support:

- An installation root containing `bin`.
- A `bin` directory.
- A direct `kicad-cli.exe` path.

For SolidCraft, support:

- An installation root containing `solidcraft.exe` and `solidcraft-cli.exe`.
- A direct `solidcraft.exe` path.
- A direct `solidcraft-cli.exe` path where the UI can still resolve the other executable from the same installation.

Do not require users to paste two paths when the portable distribution provides both executables in one directory.

### 3.2 Suggested logical configuration

Use the existing DSH settings schema and naming conventions. The following is the required logical information, not a requirement to create this exact JSON structure:

```ts
interface HardwareToolchainConfiguration {
  kicad: {
    installPath?: string;
    cliPath?: string;
    version?: string;
    source?: "manual" | "browse" | "download" | "detected";
    validatedAt?: number;
  };

  solidcraft: {
    installPath?: string;
    appPath?: string;
    cliPath?: string;
    version?: string;
    source?: "manual" | "browse" | "download" | "detected";
    validatedAt?: number;
  };
}
```

Persist only necessary user configuration.

Do not persist transient download progress, discovery results or UI state as toolchain configuration.

### 3.3 Configuration authority

The persisted configuration is authoritative.

Background discovery may suggest installations but must not silently replace an already configured, valid installation.

A newly discovered installation must not overwrite a manually configured path.

If a configured path becomes invalid, show its invalid status and offer discovery or browsing as recovery options.

---

## 4. First-launch setup wizard

### 4.1 Automatic onboarding

On the first eligible application launch, automatically present the Hardware Engineering toolchain setup wizard.

The wizard should explain why the tools are useful:

**KiCad**

- Schematic and PCB-related operations.
- BOM generation.
- Gerber and drill export.
- Fabrication preparation.
- KiCad CLI operations used by the agent.

**SolidCraft**

- 3D CAD-related operations.
- Supported command-line operations.
- Mechanical model processing where the configured implementation requires it.

Do not imply that all graphical ECAD previews require KiCad CLI. The browser-based schematic and PCB document renderers remain separate capabilities.

### 4.2 Non-blocking discovery — mandatory

Pre-installed toolchain discovery must not block the first-launch wizard.

The required startup sequence is:

1. DSH starts normally.
2. Hardware Engineering initializes.
3. The wizard becomes eligible to open.
4. The wizard opens without waiting for executable discovery.
5. Discovery starts asynchronously.
6. Detected installations update the corresponding wizard cards when available.
7. Users can interact with the wizard while discovery continues.

A discovery failure must never prevent:

- Application startup.
- Wizard display.
- Manual path input.
- Native file selection.
- Settings navigation.
- Wizard dismissal.

Do not perform recursive disk scans or long-running filesystem operations on the UI thread.

### 4.3 Discovery presentation

Each tool card should initially show a neutral discovery state, such as:

`Checking for an existing installation...`

When discovery finishes:

- Valid installation found: show its detected path and version.
- Installation found but invalid: show the path and a useful validation result.
- Nothing found: show `Not configured`.
- Discovery failed: show a non-blocking warning and leave manual configuration available.

A discovery timeout or failure must not be treated as a fatal setup error.

### 4.4 Wizard layout

Use the existing DSH UI framework and the supplied prototype as the visual reference.

The wizard should include:

- A short explanation of the two tools.
- One configuration card for KiCad.
- One configuration card for SolidCraft.
- Configuration actions on each card.
- Current status.
- A clear `Skip for Now` action.
- A clear completion action when the required configuration is ready.

Do not create a separate multi-page installer.

### 4.5 Three configuration paths

Each tool card must expose:

**A. Manual Input**

Allow the user to enter an executable path or installation directory.

**B. Select Local File...**

Open a real native OS file picker. Do not simulate the file picker with a browser file input or a hardcoded list of paths.

**C. Download from HuaQiu Server**

On supported Windows x64 installations, fetch the toolchain manifest and offer the appropriate portable download.

The three paths should remain available independently. Failure in one path must not disable the others.

### 4.6 Skip and dismissal

Users can select `Skip for Now` or close the wizard.

Both actions must:

- Dismiss the wizard without blocking the application.
- Preserve existing valid configuration.
- Mark onboarding as deferred rather than completed.
- Show a non-intrusive notification explaining where to configure the tools.
- Subtly pulse or highlight the main sidebar Settings entry.
- Keep the Settings → Hardware Engineering configuration panel available.

Do not repeatedly reopen the wizard on every application launch after the user has explicitly skipped it.

### 4.7 Completion behavior

When both tools are configured and validated:

- Mark the setup as complete.
- Stop the incomplete-configuration reminder.
- Update the sidebar status indicator.
- Allow the wizard to close normally.

The implementation should not require both tools to be configured before the user can use DSH or other Hardware Engineering features.

---

## 5. Background toolchain discovery

### 5.1 Discovery requirements

Implement non-blocking discovery for existing installations.

At minimum, support the following example Windows locations:

**KiCad**

```text
C:\Program Files\KiCad\10.0\bin
C:\Users\<user>\AppData\Local\Programs\KiCad\9.0\bin
```

**SolidCraft**

```text
C:\Program Files\SolidCraft
```

These are examples, not an exhaustive hardcoded installation catalog.

### 5.2 Discovery strategy

Inspect existing DSH and Huaqiu KiCad installation conventions first.

Use a bounded discovery strategy, such as:

- Known standard installation directories.
- Existing configured executable paths.
- Relevant installation metadata or registry entries where appropriate.
- User-local installation directories.
- Other known Huaqiu-managed installation locations.

Do not recursively scan the entire disk.

Do not assume that the first matching directory is the correct installation.

### 5.3 Candidate validation

A discovered candidate is not considered configured until its executable has been validated.

For KiCad:

- Resolve `kicad-cli.exe`.
- Verify that the executable exists.
- Invoke its version command using the existing supported subprocess mechanism.
- Parse and retain the reported version.

For SolidCraft:

- Resolve `solidcraft.exe`.
- Resolve `solidcraft-cli.exe` when present.
- Verify the executable files.
- Use the supported version-reporting command after confirming the actual CLI interface in the installed distribution.

Do not invent command-line flags or assume SolidCraft and KiCad expose identical version commands.

### 5.4 Discovery and user configuration precedence

Use this precedence:

1. Explicit user configuration.
2. Previously downloaded and validated installation.
3. Valid discovered installation.
4. Not configured.

Discovery must not overwrite an explicit valid user choice.

If multiple valid installations exist, select according to a documented deterministic policy or present the candidates for user selection. Do not silently choose an arbitrary version.

### 5.5 Discovery updates

Discovery results should update the wizard and Settings panel through the shared configuration/UI state.

Do not maintain separate discovery state in the wizard and Settings panel.

---

## 6. Manual path input and native browsing

### 6.1 Manual input

Retain a text input field for each tool.

The input should accept:

- An installation directory.
- A `bin` directory for KiCad.
- A direct executable path.

Normalize and resolve the input before validation.

Do not silently transform a valid user path into an unrelated installation.

### 6.2 Browse action

Add a `Browse...` or `Select Local File...` button next to each path input.

Use DSH's native file-dialog capability if available.

If the current plugin API does not expose the required dialog, add the smallest reusable host capability to invoke a native file or folder picker.

Suggested filters:

- KiCad: `kicad-cli.exe`
- SolidCraft: `solidcraft.exe` and `solidcraft-cli.exe`

If the user selects an executable, resolve its installation root and related executables where possible.

### 6.3 Validation and save

Retain the existing `Validate and save` workflow.

Validation must:

1. Resolve the executable path.
2. Check that the expected executable exists.
3. Check that it is accessible.
4. Invoke its supported version command.
5. Parse the version.
6. Save the configuration only after successful validation.

If validation fails:

- Preserve the previous valid configuration.
- Show an actionable error.
- Keep the user's newly entered path available for correction.
- Do not mark the tool as configured.

Do not require administrator privileges to configure a toolchain.

---

## 7. Windows toolchain manifest and download

### 7.1 Manifest endpoint

Fetch:

`https://kicad.eda.cn/agent-toolchains.json`

Use the manifest as the authoritative source of downloadable versions, checksums, platform, architecture and URLs.

Do not hardcode download URLs or checksums in the UI.

### 7.2 Manifest schema

The current expected schema is:

```json
{
  "schemaVersion": 1,
  "kicad": [
    {
      "version": "10.0.7-2",
      "sha256": "f4f350fea2e4633f313791d70b00c198a845204026a82bbe0b4e278ad1d70b99",
      "platform": "win",
      "arch": "x64",
      "url": "https://down.eda.cn/data/kicad-release/kicad-huaqiu-10.0.7-2-x86_64.zip"
    }
  ],
  "solidcraft": [
    {
      "version": "0.49.1",
      "sha256": "1bf84ea12c8e98949441b7aea2ce97305aeafb4b1b82795797bd4012bbd3b90f",
      "platform": "win",
      "arch": "x64",
      "url": "https://down.eda.cn/data/solidcraft-release/solidcraft-0.49.1-windows-x64-portable.zip"
    }
  ]
}
```

Treat this as an example manifest, not a permanent version pin.

### 7.3 Manifest parsing and validation

Implement a typed schema for the manifest.

Validate:

- `schemaVersion`.
- Tool entry structure.
- Version string.
- SHA-256 format.
- Supported platform.
- Supported architecture.
- HTTPS download URL.
- Expected tool identity.

Reject malformed or unsupported entries.

For the initial Windows implementation, select entries matching:

```text
platform = win
arch = x64
```

Do not silently use an entry for another platform or architecture.

If the manifest cannot be fetched or parsed, show a clear download-unavailable state. Manual configuration and browsing must remain functional.

### 7.4 Download UI

Each tool card must expose an action similar to:

- `Download KiCad (v10.0.7-2)`
- `Download SolidCraft (v0.49.1)`

Use the current version from the manifest.

While downloading, show:

- Downloading state.
- Progress percentage when the response provides a reliable total size.
- Downloaded bytes and total bytes where appropriate.
- Failure or cancellation state.
- Extraction state.
- Installation/validation state.

Do not display fabricated progress when the server does not provide a usable content length.

### 7.5 Download implementation

Use the existing DSH host-side HTTP/download and filesystem capabilities.

Do not download large toolchain archives inside the browser UI process if the existing architecture provides a host-side mechanism.

The download must:

- Stream to a temporary file.
- Support cancellation.
- Avoid loading the complete archive into memory.
- Report progress to the UI.
- Validate the final archive size and SHA-256.
- Reject incomplete or corrupted downloads.
- Clean up temporary files after failure.

### 7.6 Integrity verification

Verify SHA-256 against the manifest before extraction.

The expected checksum must come from the validated manifest entry.

If the checksum does not match:

- Reject the archive.
- Do not extract it.
- Do not register it as installed.
- Remove or quarantine the temporary download.
- Show a clear integrity failure message.

Do not allow a checksum failure to fall back to unverified extraction.

---

## 8. Portable installation and extraction

### 8.1 Installation location

Use a per-user application-managed toolchain directory.

Follow existing Huaqiu DSH application-data conventions where available.

Do not extract into:

- `C:\Program Files`.
- The KiCad installation directory.
- The DSH installation directory.
- The user's Downloads directory.

The exact root should be selected from the existing DSH user-data convention and documented in the implementation report.

The intended structure is versioned and isolated, for example:

```text
<DSH user data>/
└── toolchains/
    ├── kicad/
    │   └── 10.0.7-2/
    │       ├── bin/
    │       ├── etc/
    │       ├── lib/
    │       └── share/
    └── solidcraft/
        └── 0.49.1/
            ├── solidcraft.exe
            ├── solidcraft-cli.exe
            └── ...
```

The example illustrates the logical layout; follow the actual archive contents and DSH conventions.

### 8.2 KiCad archive layout

The current portable KiCad archive extracts to:

```text
kicad-huaqiu-10.0.7-2-x86_64/
├── bin/
│   ├── kicad-cli.exe
│   └── ...
├── etc/
├── lib/
└── share/
```

The configured CLI path must resolve to:

```text
<installation root>\bin\kicad-cli.exe
```

Preserve the complete extracted directory structure.

Do not copy only `kicad-cli.exe`; its runtime depends on the surrounding distribution.

### 8.3 SolidCraft archive layout

The current portable SolidCraft archive extracts to:

```text
solidcraft-0.49.1-windows-x64-portable/
├── solidcraft.exe
├── solidcraft-cli.exe
├── LICENSE-APACHE
├── LICENSE-MIT
├── NOTICE
├── README.md
└── THIRD-PARTY-LICENSES.txt
```

The configured paths must resolve to:

```text
<installation root>\solidcraft.exe
<installation root>\solidcraft-cli.exe
```

Preserve the complete extracted distribution.

Do not assume the archive will always contain exactly these files without validating the actual archive contents.

### 8.4 Safe extraction

Implement extraction with the following safeguards:

- Reject path traversal entries.
- Reject absolute paths and drive-prefixed archive entries.
- Prevent extraction outside the intended version directory.
- Handle duplicate entries safely.
- Enforce reasonable archive and extracted-size limits.
- Handle extraction errors without registering a partial installation.
- Never overwrite a valid installation in place.

Extract into a staging directory first.

Only after successful extraction and executable validation should the installation be promoted to its final versioned directory.

### 8.5 Atomic installation

The download/install sequence must be:

1. Fetch manifest.
2. Validate manifest entry.
3. Download archive to temporary storage.
4. Verify SHA-256.
5. Extract into staging directory.
6. Validate expected executable layout.
7. Run executable version validation.
8. Promote staging directory to final versioned location.
9. Persist configuration.
10. Update the UI.

Do not persist a configured path before installation is validated.

If any stage fails, preserve the previous configuration and remove incomplete staging data.

### 8.6 Existing version handling

If the target version is already installed and valid:

- Reuse it.
- Avoid downloading it again.
- Update configuration to the existing validated installation if the user explicitly chooses that version.

Do not delete older installations automatically.

Do not overwrite an installation that is currently configured or in use.

---

## 9. Cross-platform fallback

### 9.1 Windows

Windows x64 supports:

- Manifest discovery.
- Direct download.
- SHA-256 verification.
- Portable extraction.
- Automatic configuration.

If the manifest, download, checksum, extraction or validation operation fails, provide the fallback links described below.

### 9.2 Other platforms

For platforms without a supported HuaQiu portable distribution:

- Keep manual configuration.
- Keep native file selection.
- Provide official download links.

KiCad:

`https://www.kicad.org/download/`

SolidCraft:

`https://github.com/tangency-labs/solidcraft/releases/`

Open these links using the system default browser.

Do not attempt to use the Windows portable ZIP installation flow on unsupported platforms.

### 9.3 Windows fallback

If a Windows download or installation fails, also offer the relevant official download page.

Do not automatically open the browser when a recoverable failure occurs. Give the user an explicit fallback action.

---

## 10. Settings → Hardware Engineering panel

### 10.1 Integration

Add a Hardware Engineering section to the existing DSH Settings UI.

Reuse the existing settings extension mechanism, including the current `settings.section` and `ctx.configForms` capabilities if still available in the target branch.

Do not replace the existing DSH settings page.

### 10.2 Tool cards

Provide two independent configuration cards.

<pre>
Hardware Engineering

Toolchain Configuration

┌─────────────────────────────────────────────┐
│ KiCad                                       │
│                                             │
│ Version: v10.0.7-2                          │
│ Status: Configured                          │
│                                             │
│ Installation path                           │
│ [ C:\...\KiCad\10.0\bin             ]       │
│ [Browse...] [Validate and save]             │
│                                             │
│ [Download KiCad (v10.0.7-2)]                │
│                                             │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ SolidCraft                                  │
│                                             │
│ Version: v0.49.1                            │
│ Status: Configured                          │
│                                             │
│ Installation path                           │
│ [ C:\...\SolidCraft                 ]       │
│ [Browse...] [Validate and save]             │
│                                             │
│ [Download SolidCraft (v0.49.1)]             │
│                                             │
└─────────────────────────────────────────────┘
</pre>

The actual layout should follow the supplied HTML prototype and current DSH design system.

### 10.3 Status presentation

Each card should display:

- Configured version.
- Installation path.
- Current validation status.
- Available download version.
- Active download/extraction progress.
- A useful error when validation fails.

Use clear status semantics:

| State | Presentation |
|---|---|
| Configured and valid | Green status, version displayed |
| Not configured | Amber status |
| Discovering | Neutral progress state |
| Downloading | Progress indicator |
| Extracting | Progress or activity indicator |
| Validation failed | Error status |
| Download unavailable | Neutral warning with fallback |

Do not display a green configured state until executable validation succeeds.

### 10.4 Sidebar indicator

Display a small status dot next to the main Settings entry whenever required toolchain configuration is incomplete.

The indicator must:

- Reflect the shared configuration state.
- Update when a tool is configured or becomes invalid.
- Stop showing when all required toolchains are valid.
- Remain visually subtle.

Use the existing DSH sidebar extension mechanism. Do not modify unrelated sidebar behavior.

### 10.5 Wizard and Settings synchronization

The wizard and Settings panel must read and update the same configuration state.

Examples:

- A successful download in the wizard immediately updates Settings.
- A manual path saved in Settings updates the wizard if it is still open.
- A configured tool becoming invalid updates both views.
- Discovery updates both views without overwriting user configuration.

Do not duplicate configuration state or implement two independent validation systems.

---

## 11. Toast notifications and reminders

Use the existing DSH notification/toast mechanism.

Required notifications include:

- Toolchain detected.
- Path validated and saved.
- Download started.
- Download completed.
- Extraction completed.
- Installation validated.
- Download failed.
- Checksum mismatch.
- Invalid executable path.
- Wizard skipped.
- Setup still incomplete.

Notifications must be concise and non-blocking.

Do not show modal error dialogs for ordinary discovery or download failures.

For a skipped wizard:

- Show a short notification explaining that configuration remains available under Settings → Hardware Engineering.
- Trigger the subtle Settings indicator/pulse.
- Do not interrupt the user's current task.

Avoid repeated reminder toasts on every application startup.

---

## 12. Agent integration

### 12.1 Capability visibility

The agent should know whether the required toolchains are configured and validated.

Expose compact toolchain context through the existing DSH agent/plugin context mechanism.

Example logical context:

```ts
interface HardwareToolchainCapabilities {
  kicad: {
    available: boolean;
    version?: string;
    cliPath?: string;
  };

  solidcraft: {
    available: boolean;
    version?: string;
    appPath?: string;
    cliPath?: string;
  };
}
```

Use actual existing DSH context and tool-registration conventions.

Do not inject unnecessary absolute paths into every conversation if the agent only needs capability/version information for the current operation.

### 12.2 Missing toolchain behavior

If an agent operation requires a missing toolchain:

- Return a structured error identifying the missing capability.
- Explain that the user can configure it under Settings → Hardware Engineering.
- Do not crash the tool.
- Do not repeatedly ask the user to paste paths into the conversation.

The user should configure toolchains through the UI.

### 12.3 Capability-specific requirements

Do not make every Hardware Engineering feature depend on both tools.

Examples:

| Capability | KiCad CLI | SolidCraft |
|---|---:|---:|
| Schematic document preview using browser renderer | Not required | Not required |
| PCB document preview using browser renderer | Not required | Not required |
| KiCad BOM export | Required | Not required |
| Gerber/drill export | Required | Not required |
| STEP/STP preview | Depends on selected renderer implementation | Depends on selected renderer implementation |
| SolidCraft-specific CLI operation | Not required | Required |

A missing SolidCraft installation must not prevent schematic, PCB or fabrication workflows that only require KiCad.

A missing KiCad CLI must not prevent standalone STEP/STP preview.

### 12.4 Ordering workflow

The existing agent-driven fabrication ordering workflow must use the configured KiCad CLI path.

When it is unavailable:

- The agent must explain that KiCad CLI is not configured.
- The user can navigate to Settings → Hardware Engineering.
- The agent must not silently use an unrelated executable from PATH.

The order workflow remains conversational. Do not add an Order button or Order tab as part of toolchain configuration.

---

## 13. Relationship with document preview and rendering

Toolchain configuration must remain independent from DSH document MDI.

The existing MDI remains responsible for opening and rendering:

- `.kicad_sch`
- `.kicad_pcb`
- `.step`
- `.stp`

The toolchain configuration panel does not become a preview navigation system.

KiCad CLI may be required for operations such as manufacturing exports and optional 3D conversion.

SolidCraft may be used for supported mechanical CLI operations or conversion if that is the selected implementation.

Do not make graphical document rendering depend on launching the native applications.

Do not add a SolidCraft launch button or native file-opening workflow.

---

## 14. Error handling and recovery

### 14.1 Discovery failures

Examples:

- Permission denied.
- Directory unavailable.
- Executable missing.
- Version command timeout.
- Unsupported version output.

Expected behavior:

- Record the discovery failure.
- Keep the wizard usable.
- Show `Not configured` or a useful warning.
- Allow manual input and browsing.

### 14.2 Manifest failures

Examples:

- Network unavailable.
- HTTP failure.
- Invalid JSON.
- Unsupported schema version.
- Missing tool entry.
- Invalid checksum.
- Unsupported platform/architecture.

Expected behavior:

- Keep manual and browse paths available.
- Show download unavailable.
- Offer the official download page.

### 14.3 Download failures

Examples:

- Network interrupted.
- Server returns an error.
- Download cancelled.
- Disk full.
- Checksum mismatch.
- Invalid ZIP.
- Extraction failure.
- Executable validation failure.

Expected behavior:

- Do not register a partial installation.
- Preserve the previous valid configuration.
- Clean up temporary files.
- Show a recoverable error.
- Allow retry or manual installation.

### 14.4 Concurrent operations

Prevent:

- Two simultaneous downloads of the same toolchain version.
- Discovery overwriting a manual path.
- Settings saving while an installation is only partially extracted.
- A cancelled download later being marked successful.
- An old asynchronous validation result overwriting a newer configuration.

Use operation identity/revision checks and cancellation where supported.

---

## 15. Implementation sequence

### M1 — Source audit and integration design

Inspect:

- DSH plugin settings extension.
- `ctx.configForms`.
- Settings section registration.
- Native file/folder picker capability.
- Host filesystem access.
- Subprocess execution.
- Notifications/toasts.
- Sidebar status/indicator extension.
- Application startup and first-launch state.
- Existing Huaqiu KiCad path discovery/configuration, if any.

Deliver a concise source map before changing code.

Do not build a parallel settings or filesystem implementation.

**Exit condition:** Every required host/UI capability has a source-confirmed owner and integration point.

### M2 — Configuration state and validation

Implement:

- Shared configuration schema.
- Persistent configuration.
- Path normalization.
- Executable resolution.
- KiCad version validation.
- SolidCraft executable and CLI validation.
- Configuration status model.

**Exit condition:** Both toolchains can be configured manually and validated successfully.

### M3 — Background discovery

Implement:

- Known-path discovery.
- Existing installation candidate validation.
- Deterministic candidate handling.
- Non-blocking asynchronous execution.
- Wizard and Settings state updates.

**Exit condition:** Discovery can run without delaying first-launch wizard display or application startup.

### M4 — First-launch wizard

Implement:

- Automatic first-launch presentation.
- Tool explanation.
- Two tool cards.
- Manual input.
- Native browse.
- Discovery results.
- Skip/dismiss behavior.
- Completion behavior.
- Settings reminder and sidebar indicator.

**Exit condition:** The complete onboarding flow works without requiring either tool to be installed beforehand.

### M5 — Manifest and download

Implement:

- Manifest retrieval.
- Schema validation.
- Version selection.
- Download progress.
- Cancellation.
- SHA-256 verification.
- Temporary storage.

**Exit condition:** Both Windows x64 archives can be downloaded and verified.

### M6 — Extraction and automatic configuration

Implement:

- Safe ZIP extraction.
- Versioned installation directories.
- Atomic promotion.
- Executable resolution.
- Version validation.
- Configuration persistence.
- Existing installation reuse.
- Failure cleanup.

**Exit condition:** A successful download automatically installs and configures the selected toolchain.

### M7 — Settings panel and notifications

Implement:

- Persistent Settings → Hardware Engineering panel.
- Browse buttons.
- Download actions.
- Inline progress.
- Version/status presentation.
- Sidebar indicator.
- Toast notifications.
- Shared wizard/settings state.

**Exit condition:** All configuration operations can be repeated or corrected from Settings after onboarding.

### M8 — Agent capability integration

Implement:

- Compact toolchain capability context.
- Structured missing-toolchain errors.
- Correct capability-specific dependency handling.
- KiCad CLI resolution for fabrication workflows.

**Exit condition:** Agent tools consume the validated configured executables and report missing capabilities clearly.

### M9 — Packaging and Windows verification

Implement:

- Bundle dependency integration.
- Windows x64 packaged build.
- Fresh-install test.
- Existing-installation discovery test.
- Download/install test.
- Upgrade test.
- Offline/manual configuration test.

**Exit condition:** The installed Huaqiu DSH Desktop build supports the complete toolchain UX without development-machine dependencies.

---

## 16. Acceptance criteria

### First launch

- [ ] Wizard appears automatically on first eligible launch.
- [ ] Wizard appears without waiting for discovery.
- [ ] Discovery runs asynchronously.
- [ ] Discovery failure cannot block the wizard.
- [ ] Manual input remains immediately usable.
- [ ] Native browse remains immediately usable.
- [ ] Download entrypoints remain available when the manifest can be loaded.
- [ ] Skip and close dismiss the wizard.
- [ ] Skip does not repeatedly reopen the wizard on every startup.
- [ ] Skipping produces a non-blocking notification.
- [ ] Settings indicator/pulse appears when configuration is incomplete.

### Discovery

- [ ] Detects the example KiCad system installation path.
- [ ] Detects the example user-local KiCad installation path.
- [ ] Detects the example SolidCraft installation path.
- [ ] Validates discovered executables.
- [ ] Displays detected versions.
- [ ] Does not overwrite an explicit valid user configuration.
- [ ] Handles multiple installations deterministically.
- [ ] Does not perform an unbounded disk scan.

### Manual configuration

- [ ] Accepts KiCad installation root.
- [ ] Accepts KiCad `bin` directory.
- [ ] Accepts direct `kicad-cli.exe` path.
- [ ] Accepts SolidCraft installation root.
- [ ] Accepts direct SolidCraft executable paths.
- [ ] Native browse opens the OS file picker.
- [ ] Invalid paths are not saved as valid configuration.
- [ ] Previous valid configuration survives validation failure.

### Download

- [ ] Fetches `agent-toolchains.json`.
- [ ] Validates schema and entries.
- [ ] Selects Windows x64 entries.
- [ ] Displays manifest versions.
- [ ] Shows real download progress when measurable.
- [ ] Supports cancellation.
- [ ] Verifies SHA-256.
- [ ] Rejects invalid or corrupted archives.
- [ ] Cleans up failed downloads.
- [ ] Does not require elevated privileges.

### Installation

- [ ] KiCad is extracted with its complete `bin`, `etc`, `lib`, `share` layout.
- [ ] KiCad CLI path resolves correctly.
- [ ] SolidCraft is extracted with both expected executables when provided.
- [ ] SolidCraft paths resolve correctly.
- [ ] Extraction cannot escape the target directory.
- [ ] Installation is promoted only after validation.
- [ ] Previous valid installations are preserved.
- [ ] Configuration is automatically populated after successful installation.

### Settings

- [ ] Settings → Hardware Engineering is available after wizard dismissal.
- [ ] Both tool cards display path and status.
- [ ] Browse actions work.
- [ ] Download actions work.
- [ ] Progress is displayed inline.
- [ ] Version badges reflect validated versions.
- [ ] Sidebar status reflects actual configuration.
- [ ] Wizard and Settings share configuration state.

### Agent

- [ ] Agent can determine whether KiCad CLI is available.
- [ ] Agent can determine whether SolidCraft is available.
- [ ] Missing KiCad CLI produces a structured actionable error.
- [ ] Missing SolidCraft does not block unrelated KiCad workflows.
- [ ] Fabrication tools use the configured KiCad CLI.
- [ ] No unrelated PATH executable is silently substituted.

### Packaging

- [ ] Windows x64 installer contains all required plugin code.
- [ ] No development-only local dependency links remain.
- [ ] No Python or Docker runtime dependency is introduced.
- [ ] No HQ Edge runtime dependency is introduced.
- [ ] Toolchain downloads and extraction work in the packaged application.
- [ ] Existing DSH settings and navigation behavior remain intact.

---

## 17. Required deliverables

The implementation agent must provide:

1. Source map of the DSH settings, filesystem, native dialog, subprocess, notification and sidebar extension APIs.
2. Shared toolchain configuration implementation.
3. KiCad and SolidCraft discovery implementation.
4. First-launch wizard.
5. Settings → Hardware Engineering panel.
6. Native file picker integration.
7. Manifest retrieval and validation.
8. Windows x64 download implementation.
9. SHA-256 verification.
10. Safe portable extraction and automatic configuration.
11. Progress and notification implementation.
12. Agent-facing toolchain capability integration.
13. Automated tests for discovery, validation, download, extraction and state synchronization.
14. Windows x64 packaged build verification.
15. Known limitations and unmet acceptance criteria.

For every host modification, explain why the existing plugin API could not satisfy the requirement and why the change is the smallest reusable extension.

---

## 18. Non-goals and prohibitions

Do not:

- Block application startup on toolchain discovery.
- Require toolchains to be installed before the wizard can open.
- Force users to configure both tools before using DSH.
- Perform recursive whole-disk scans.
- Overwrite valid manual configuration during discovery.
- Extract toolchains into Program Files or the DSH installation directory.
- Extract only `kicad-cli.exe` from the KiCad distribution.
- Treat an unverified download as an installed toolchain.
- Save a configuration before executable validation succeeds.
- Run installation or download work on the UI thread.
- Require administrator privileges for per-user installation.
- Build a separate toolchain manager application.
- Introduce another settings database.
- Introduce a daemon or HQ Edge dependency.
- Make all Hardware Engineering capabilities depend on both tools.
- Add a SolidCraft native-launch workflow.
- Add a dedicated Order entrypoint.

---

## 19. Final UX principle

The user should not need to know where KiCad or SolidCraft is installed, understand executable paths, or manually assemble a portable installation.

On first launch, Hardware Engineering explains the tools and starts discovery in the background. If an installation is found, the user can validate and use it. If not, they can browse, paste a path or download the supported portable version. If they skip, the application remains fully usable and Settings remains an obvious place to finish configuration.

**Discovery must never gate onboarding. Configuration must never gate application startup. The agent must use only validated toolchain capabilities.**
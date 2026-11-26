# HuaQiu Electronic Design Agent Platform — Hardware Toolchain UX Prototype Summary

This prototype demonstrates an improved onboarding and configuration workflow for **KiCad (`kicad-cli`)** and **SolidCraft 3D CAD**, removing the friction of manually copying and pasting executable paths.

---

### 1. First-Launch Setup Wizard
* **Automatic Onboarding:** Launches automatically when a user opens the application for the first time, explaining why the EDA/MCAD engines are needed (schematic/PCB previews, GLB/3D rendering, BOM, and Gerber exports).
* **Three Configuration Paths per Tool:**
  1. **Manual Input:** Paste a direct executable path or installation directory.
  2. **System File Explorer (`Select Local File...`):** Click to browse and pick an existing local binary (`kicad-cli.exe` / `SolidCraft.exe`).
  3. **Direct Server Download (`Download from HuaQiu Server`):** One-click download from `down.eda.cn` (`kicad-huaqiu-10.0.7-2-x86_64.exe.zip` and `SolidCraft-0.49.1-windows-x64.exe.zip`) with real-time progress tracking and automatic path extraction/linking upon completion.
* **Clear Deferral & Navigation Guidance:** Users who click **Skip for Now** or close the wizard receive a non-intrusive toast notification and a subtle visual pulse on the sidebar **Settings** button, reminding them they can configure the tools anytime under **Settings → Hardware Engineering**.

---

### 2. Enhanced `Settings → Hardware Engineering` Panel
* **Unified Path Selection:** Retains the existing text input fields and **Validate and save** workflow while adding a **`Browse...`** button next to each input to open the system file explorer.
* **Integrated Server Download Entrypoints:** Provides direct **`Download KiCad (v10.0.7-2)`** and **`Download SolidCraft (v0.49.1)`** links inside each tool card, complete with inline progress bars and auto-population of the path field once downloaded.
* **Live Status & Validation Feedback:**
  * Displays real-time version badges (e.g., `v10.0.8` in green when configured vs. `Not configured` in amber).
  * Shows a small indicator dot next to **Settings** in the main sidebar whenever toolchain configuration is incomplete.
  * Synchronizes state seamlessly between the First-Launch Wizard and the Settings panel.

---

### 3. Interactive File Explorer & Feedback Simulation
* **File Explorer Dialog:** Simulates a native OS file picker pre-populated with realistic Windows and macOS installation paths (plus an option to trigger the browser's actual OS file dialog).
* **Toast Notification System:** Provides clean, non-blocking confirmation messages for path validation, file selection, downloads, and skipped setup steps.
#!/usr/bin/env python3
"""Read-only diagnostic for a KiCad IPC connection.

Use before a write script.  It does not edit or save the current PCB.
"""

from __future__ import annotations

import sys


def main() -> int:
    try:
        from kipy import KiCad
    except ModuleNotFoundError:
        print("kicad-python/kipy not found. Use the KiCad IPC plugin environment or install the matching official package.")
        return 2

    kicad = None
    try:
        kicad = KiCad(timeout_ms=5000)
        if not kicad.check_version():
            print("Connected, but kicad-python and the KiCad API version do not match.")
            return 3

        board = kicad.get_board()
        if board is None:
            print("Connected to KiCad API, but no .kicad_pcb is open in PCB Editor.")
            return 4

        print(f"Connected to KiCad {kicad.get_version()}.")
        print(f"Current PCB: {board.name}")
        return 0
    except Exception as exc:
        print(f"Could not connect to KiCad IPC API: {exc}")
        print("Please confirm:")
        print("  1. PCB Editor is open (opening the project manager alone is not enough).")
        print("  2. The API service is enabled in KiCad Preferences -> Plugins, and PCB Editor has been restarted.")
        print("  3. If running in DSH, the current task has Full Access; without Full Access the KiCad named pipe cannot be accessed.")
        return 1
    finally:
        if kicad is not None:
            close = getattr(kicad, "close", None)
            if callable(close):
                close()


if __name__ == "__main__":
    sys.exit(main())

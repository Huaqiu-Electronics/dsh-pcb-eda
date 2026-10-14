"""Load the fixed bundled Python libraries without global installs or PATH changes."""

import importlib
import os
import sys
from pathlib import Path

VENDOR = Path(__file__).parent / "vendor"
sys.path[:0] = [str(VENDOR), str(VENDOR / "win32"), str(VENDOR / "win32/lib")]
# Keep this cookie for the one-shot process lifetime, including delayed DLL loads.
_dll_directory = os.add_dll_directory(str(VENDOR / "pywin32_system32"))
# Load the official shim before an extension loads its DLL. Otherwise pywin32
# retrieves an already-loaded DLL name through a MAX_PATH-sized native buffer.
pywintypes = importlib.import_module("pywintypes")
psutil = importlib.import_module("psutil")
win32api = importlib.import_module("win32api")
win32job = importlib.import_module("win32job")

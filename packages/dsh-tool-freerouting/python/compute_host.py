"""One-shot process ownership commands; no KiCad import and no resident service."""

import json
import sys
from pathlib import Path

# Preserve the extended Windows path, as kicad_helper does for sibling imports.
sys.path.insert(0, str(Path(__file__).parent))
from protocol_requests import compute_request
from windows_compute import (
    launch,
    recover_launch,
    release,
    release_directory,
    state,
    stop,
    stop_directory,
)
from windows_processes import confirm_board, process_identities
from windows_resources import sample


def main() -> None:
    """Read one request and return one JSON response."""
    request = compute_request(sys.stdin.buffer)
    command = request["command"]
    if command == "process-identities":
        result = process_identities(request["processes"])
    elif command == "confirm-board":
        result = confirm_board(request["paths"])
    elif command == "launch":
        result = launch(request["argv"], request["owner"], request.get("directory"))
    elif command == "stop":
        stop(request["record"])
        result = {"state": state(request["record"])}
    elif command == "release":
        release(request["record"])
        result = {"released": True}
    elif command == "state":
        result = {"state": state(request["record"])}
    elif command == "recover-launch":
        recover_launch(request["directory"])
        result = {"recovered": True}
    elif command == "stop-directory":
        stop_directory(request["directory"])
        result = {"stopped": True}
    elif command == "release-directory":
        release_directory(request["directory"])
        result = {"released": True}
    elif command == "sample":
        result = sample(request["pids"])
    else:
        raise ValueError("Unsupported compute command")
    print(json.dumps(result))


if __name__ == "__main__":
    main()

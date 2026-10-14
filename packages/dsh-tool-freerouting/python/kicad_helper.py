"""One request per process. stdout is reserved for the JSON protocol; never save the live PCB."""

import contextlib
import importlib.metadata
import json
import struct
import sys
from pathlib import Path

# CPython can normalize its automatic script-directory entry without the
# Windows extended-path prefix. An installed pnpm path can then exceed MAX_PATH
# for our sibling modules even though vendor imports succeed. Keep both paths
# explicit and derived from the namespace-preserving __file__ of this helper.
helper_directory = Path(__file__).parent
sys.path[:0] = [str(helper_directory / "vendor"), str(helper_directory)]


class PreflightError(Exception):
    code = "HELPER_PREFLIGHT_FAILED"


def validate_environment() -> None:
    """Require the selected KiCad ABI and the bundled dependency versions."""
    if sys.platform != "win32" or sys.version_info[:2] != (3, 11) or struct.calcsize("P") != 8:
        raise PreflightError("需要所选 KiCad 10 的 Windows x64 Python 3.11")
    lock = json.loads((Path(__file__).parent / "dependencies.lock.json").read_text())
    for package in lock["packages"]:
        try:
            distribution = importlib.metadata.distribution(package["name"])
        except importlib.metadata.PackageNotFoundError:
            raise PreflightError("插件依赖缺失：" + package["name"])
        if distribution.version != package["version"] or not Path(
            distribution.locate_file("")
        ).resolve().is_relative_to((Path(__file__).parent / "vendor").resolve()):
            raise PreflightError("插件固定版本依赖不兼容：" + package["name"])


def main() -> None:
    outcome = "unchanged"
    try:
        validate_environment()
        from protocol_requests import helper_request

        command = sys.argv[1]
        request = helper_request(sys.stdin.buffer, command)
        from ipc_context import discover, export
        from ipc_import import fill, import_session, review_session
        from ipc_preview import clear_preview, preview_session
        from routing_repair import repair_dsn

        action = {
            "discover": discover,
            "export": export,
            "review": review_session,
            "repair": repair_dsn,
            "import": import_session,
            "fill": fill,
            "preview": preview_session,
            "clear-preview": clear_preview,
        }[command]
        # Native pcbnew can print status lines; keep them off the helper protocol.
        with contextlib.redirect_stdout(sys.stderr):
            data = action(request)
        result = {"ok": True, "data": data}
    except Exception as cause:
        code = getattr(cause, "code", "HELPER_PREFLIGHT_FAILED")
        if code == "IMPORT_UNCERTAIN" or (
            code != "HELPER_REQUEST_INVALID" and len(sys.argv) > 1 and sys.argv[1] == "fill"
        ):
            outcome = "uncertain"
        else:
            outcome = getattr(cause, "outcome", outcome)
        # Transport/native exceptions may include credentials; return only explicit domain messages.
        message = (
            str(cause)
            if hasattr(cause, "code")
            else "KiCad helper 预检或通信失败，请检查 Python、依赖与 IPC 设置"
        )
        result = {"ok": False, "code": code, "error": message, "outcome": outcome}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

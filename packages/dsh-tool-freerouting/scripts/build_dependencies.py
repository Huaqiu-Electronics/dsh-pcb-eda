"""Prepare pinned runtime artifacts using pip and the official JRE archive."""

import hashlib
import json
import re
import shutil
import subprocess
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path


def digest(path: Path) -> str:
    with path.open("rb") as content:
        return hashlib.file_digest(content, "sha256").hexdigest()


def download_verified(url: str, checksum: str, directory: Path) -> Path:
    """Cache only SHA-256 verified downloads; reject partial or corrupt files."""
    parsed = urllib.parse.urlsplit(url)
    filename = Path(urllib.parse.unquote(parsed.path)).name
    if parsed.scheme != "https" or not filename or not re.fullmatch(r"[a-f0-9]{64}", checksum):
        raise ValueError("Artifact requires an HTTPS URL and a SHA-256 lock")
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / filename
    if target.exists() and digest(target) == checksum:
        return target
    partial = target.with_suffix(target.suffix + ".partial")
    deadline = time.monotonic() + 300
    received = 0
    try:
        with urllib.request.urlopen(url, timeout=30) as response, partial.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                received += len(chunk)
                if time.monotonic() > deadline or received > 160 * 1024 * 1024:
                    raise TimeoutError("Artifact download exceeded its time or size limit")
                output.write(chunk)
        if digest(partial) != checksum:
            raise ValueError("Artifact SHA-256 mismatch: " + filename)
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return target


def run_logged(argv: list[str], log: Path, timeout: int) -> None:
    """Keep verbose developer-tool output in a file with a bounded error tail."""
    with log.open("wb") as output:
        reply = subprocess.run(argv, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    if reply.returncode:
        with log.open("rb") as output:
            output.seek(max(0, log.stat().st_size - 3800))
            print(output.read().decode(errors="replace"))
        raise RuntimeError("Build command failed; see " + str(log))


def replace_directory(source: Path, target: Path, backup: Path) -> None:
    """Publish a prepared directory and restore the old one if its move fails."""
    existed = target.exists()
    if existed:
        target.rename(backup)
    try:
        source.rename(target)
    except OSError:
        if existed:
            backup.rename(target)
        raise


def prepare_vendor(root: Path, work: Path, cache: Path, python: Path) -> Path:
    lock = json.loads((root / "python/dependencies.lock.json").read_text(encoding="utf-8"))
    expected = "".join(
        f"{package['name']}=={package['version']} --hash=sha256:{package['sha256']}\n"
        for package in lock["packages"]
    )
    requirements = root / "python/requirements.lock.txt"
    if requirements.read_text(encoding="utf-8") != expected:
        raise ValueError("Python requirements and download locks disagree")
    wheels = cache / "wheels"
    for package in lock["packages"]:
        download_verified(package["wheel"], package["sha256"], wheels)
    vendor = work / "vendor"
    run_logged(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-index",
            "--find-links",
            str(wheels),
            "--only-binary=:all:",
            "--require-hashes",
            "--no-compile",
            "--no-deps",
            "--target",
            str(vendor),
            "-r",
            str(requirements),
        ],
        cache / "pip-install.log",
        120,
    )
    # Test the same bundled-loader boundary used by the real helper, without
    # falling back to globally installed pywin32 or other Python packages.
    shutil.copy2(root / "python/runtime_dependencies.py", work / "runtime_dependencies.py")
    shutil.copy2(root / "python/kicad_helper.py", work / "kicad_helper.py")
    shutil.copy2(root / "python/dependencies.lock.json", work / "dependencies.lock.json")
    code = (
        "import sys; sys.path.insert(0,sys.argv[1]); "
        "from kicad_helper import validate_environment; validate_environment(); "
        "import runtime_dependencies,kipy,pynng,google.protobuf"
    )
    run_logged(
        [
            str(python),
            "-I",
            "-S",
            "-B",
            "-c",
            code,
            str(work),
        ],
        cache / "vendor-import.log",
        30,
    )
    return vendor


def prepare_jre(root: Path, work: Path, cache: Path) -> Path:
    lock = json.loads((root / "bundled/runtime.lock.json").read_text(encoding="utf-8"))
    archive = download_verified(lock["archive_url"], lock["archive_sha256"], cache / "downloads")
    extracted = work / "runtime"
    with zipfile.ZipFile(archive) as contents:
        contents.extractall(extracted)
    roots = list(extracted.iterdir())
    if len(roots) != 1 or not roots[0].is_dir():
        raise ValueError("JRE archive must contain one installation root")
    jre = roots[0]
    for relative, key in (("bin/java.exe", "java_exe_sha256"), ("release", "release_sha256")):
        if digest(jre / relative) != lock[key]:
            raise ValueError("Extracted JRE does not match its lock: " + relative)
    if not (jre / "lib/modules").is_file() or not (jre / "legal").is_dir():
        raise ValueError("JRE is incomplete")
    return jre

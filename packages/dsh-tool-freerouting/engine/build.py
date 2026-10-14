"""Build the pinned, complete FreeRouting source with the reviewed DSH changes."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def digest(path):
    """Stream the artifact hash without loading a JAR into memory."""
    with path.open("rb") as content:
        return hashlib.file_digest(content, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jdk", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--gradle-cache", required=True, type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    lock = json.loads((ROOT / "source.lock.json").read_text(encoding="utf-8"))
    archive = ROOT / lock["source_archive"]
    if digest(archive) != lock["source_sha256"]:
        raise ValueError("Official source archive does not match its pinned SHA-256")
    sources = sorted((ROOT / "src").rglob("*.java"))
    for source in sources:
        name = source.relative_to(ROOT / "src").as_posix()
        if digest(source) != lock["patch_sources"][name]:
            raise ValueError("Reviewed source hash changed: " + name)
    if len(sources) != len(lock["patch_sources"]):
        raise ValueError("Reviewed engine source set changed")
    java = args.jdk.resolve() / "bin/java.exe"
    version = subprocess.run([str(java), "-version"], capture_output=True, timeout=15, check=True)
    if b'version "25.' not in version.stdout + version.stderr:
        raise ValueError("Building FreeRouting 2.5.0 requires a full JDK 25")
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    # Build beside the output, so large source/dependency files stay off the
    # system TEMP drive. Only this invocation's temporary directory is removed.
    with tempfile.TemporaryDirectory(prefix="freerouting-source-", dir=output.parent) as directory:
        work = Path(directory)
        with zipfile.ZipFile(archive) as original:
            original.extractall(work)
        for source in sources:
            destination = work / "src/main/java" / source.relative_to(ROOT / "src")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        official_tests = ROOT / "tests/upstream"
        for source in official_tests.rglob("*.java"):
            destination = work / "src/test/java" / source.relative_to(official_tests)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        init = work / "dsh-engine-build.gradle"
        init.write_text(
            "allprojects { afterEvaluate { tasks.named('executableJar') { manifest { attributes "
            + "'DSH-Engine-Patch': "
            + repr(lock["patch_id"])
            + " } } } }\n",
            encoding="utf-8",
        )
        environment = dict(os.environ)
        environment.update(
            JAVA_HOME=str(args.jdk.resolve()),
            GRADLE_USER_HOME=str(args.gradle_cache.resolve()),
            BUILD_REVISION=lock["upstream_revision"],
        )
        environment["PATH"] = str(args.jdk.resolve() / "bin") + os.pathsep + environment["PATH"]
        environment["JAVA_TOOL_OPTIONS"] = "-Djdk.net.unixdomain.tmpdir=C:/Windows/Temp"
        tasks = ["executableJar"]
        if args.check:
            tasks += [
                "test",
                "--tests",
                "app.freerouting.management.jobs.RoutingJobSchedulerTest",
                "--tests",
                "app.freerouting.management.jobs.RoutingJobSchedulerActionThreadTest",
                "--tests",
                "app.freerouting.io.SpecctraPackageArchTest",
                "--tests",
                "app.freerouting.io.specctra.SesRoundTripTest",
            ]
        log = output.with_suffix(".build.log")
        with log.open("wb") as stream:
            result = subprocess.run(
                [
                    str(work / "gradlew.bat"),
                    "--no-daemon",
                    "--console=plain",
                    "--max-workers=2",
                    "--init-script",
                    str(init),
                    *tasks,
                ],
                cwd=work,
                env=environment,
                stdout=stream,
                stderr=stream,
                timeout=900,
            )
        if result.returncode:
            print(log.read_bytes()[-3800:].decode(errors="replace"))
            raise RuntimeError("Complete-source engine build failed; see " + str(log))
        built = work / "build/libs/freerouting-current-executable.jar"
        temporary = output.with_suffix(".building.jar")
        try:
            shutil.copy2(built, temporary)
            temporary.replace(output)
        finally:
            temporary.unlink(missing_ok=True)
    provenance = {
        "source": lock,
        "output_sha256": digest(output),
        "upstream_tests_passed": args.check,
    }
    metadata = output.with_suffix(".build.json")
    metadata.write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "patch": lock["patch_id"],
                "upstream_revision": lock["upstream_revision"],
                "output_sha256": digest(output),
                "log": str(log),
            }
        )
    )


if __name__ == "__main__":
    main()

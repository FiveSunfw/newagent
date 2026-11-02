"""Create a platform-specific, hash-locked requirements file from pip's report."""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


def canonicalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: lock_from_report.py <pip-report.json> <requirements.lock>", file=sys.stderr)
        return 2

    report_path, lock_path = map(Path, sys.argv[1:])
    report = json.loads(report_path.read_text(encoding="utf-8"))
    environment = report.get("environment", {})
    pins: dict[str, tuple[str, str]] = {}

    for item in report.get("install", []):
        metadata = item.get("metadata", {})
        name = canonicalize(metadata.get("name", ""))
        version = metadata.get("version", "")
        hashes = item.get("download_info", {}).get("archive_info", {}).get("hashes", {})
        digest = hashes.get("sha256")
        if not name or not version or not digest:
            raise ValueError(f"pip report lacks package metadata or SHA-256: {metadata.get('name', '<unknown>')}")
        pins[name] = (version, digest)

    if not pins:
        raise ValueError("pip report contains no resolved packages")

    py = environment.get("python_version", "unknown")
    system = environment.get("platform_system", "unknown")
    machine = environment.get("platform_machine", "unknown")
    lines = [
        "# Generated from requirements.in using pip's resolved install report.",
        f"# Locked at: {datetime.now(timezone.utc).isoformat(timespec='seconds')}.",
        f"# Target: Python {py}, {system} {machine}.",
        "# Regenerate on the target Python/platform with scripts/ragas/setup.ps1.",
        "",
    ]
    for name, (version, digest) in sorted(pins.items()):
        lines.append(f"{name}=={version} --hash=sha256:{digest}")

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(f"Locked {len(pins)} distributions for Python {py} on {system} {machine}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

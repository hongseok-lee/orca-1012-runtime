#!/usr/bin/env python3
"""Dependency-free checks for public repository provenance and review tooling."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

PIN = "776e424e76405a06851dd9ec9ff3b58ffbdb3eea"
UPSTREAM = "https://github.com/stablyai/orca"
TEMPLATE_SECTIONS = (
    "Full task specification", "Actual changes", "Visual evidence",
    "Source, backend, and Expo revisions", "Verification and limitations",
    "Build and application scope", "Team lead review",
)
SECRET = re.compile(
    rb"(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"
    rb"|tskey-[A-Za-z0-9_-]{10,}"
    rb"|(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])"
    rb"|(?<![A-Za-z0-9_-])(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,}|AIza[0-9A-Za-z_-]{35})(?![A-Za-z0-9_-])"
)


def check(root, verify_import=False):
    errors = []
    manifest = json.loads((root / "provenance/upstream-import.json").read_text())
    if manifest.get("source_commit") != PIN or manifest.get("repository") != UPSTREAM:
        errors.append("unexpected upstream provenance")
    entries = manifest["imported_files"]
    imported = {item["path"]: item["sha256"] for item in entries}
    if len(imported) != len(entries):
        errors.append("duplicate imported path")
    license_path = root / "LICENSE"
    if hashlib.sha256(license_path.read_bytes()).hexdigest() != imported.get("LICENSE"):
        errors.append("upstream license notice changed")
    required = ("src/main", "src/shared", "src/cli", "src/renderer", "mobile/package.json")
    for name in required:
        if not (root / name).exists():
            errors.append("missing product source: " + name)
    excluded = {item["path"] for item in manifest["excluded_paths"]}
    if "mobile/google-services.json" not in excluded or (root / "mobile/google-services.json").exists():
        errors.append("service credential configuration must remain excluded")
    workflows = sorted(path.name for path in (root / ".github/workflows").iterdir())
    if workflows != ["foundation-check.yml"]:
        errors.append("workflow set requires explicit foundation policy review")
    workflow = (root / ".github/workflows/foundation-check.yml").read_text()
    if "pull_request_target" in workflow or "contents: write" in workflow:
        errors.append("foundation workflow must remain read-only")
    if not re.search(r"run: python3 tooling/check_repository_foundation\.py", workflow):
        errors.append("missing lightweight foundation job")
    template = (root / ".github/PULL_REQUEST_TEMPLATE.md").read_text()
    for heading in TEMPLATE_SECTIONS:
        if "## " + heading not in template:
            errors.append("missing PR section: " + heading)
    if "@hongseok-lee" not in (root / ".github/CODEOWNERS").read_text():
        errors.append("missing review routing")
    paths = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
    for name in filter(None, paths):
        parts = Path(name).parts
        if any(part in {".codex", "template-snapshots", ".aws", ".terraform"} for part in parts):
            errors.append("private state path prohibited: " + name)
        if Path(name).name == ".env" or Path(name).name.startswith(".env."):
            errors.append("environment file prohibited: " + name)
        path = root / name
        data = path.read_bytes()
        unchanged_upstream = hashlib.sha256(data).hexdigest() == imported.get(name)
        if not unchanged_upstream and SECRET.search(data):
            errors.append("credential-shaped literal in new or changed file: " + name)
    if verify_import:
        for name, digest in imported.items():
            path = root / name
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                errors.append("upstream import hash mismatch: " + name)
    return errors, len(imported)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-import", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    errors, count = check(root, args.verify_import)
    if errors:
        for error in errors:
            print("FAIL: " + error)
        return 1
    print("PASS: repository foundation; " + str(count) + " upstream manifest entries")
    print("Scope: static repository checks only; backend/Expo/visual/product tests not run")
    return 0


if __name__ == "__main__":
    sys.exit(main())

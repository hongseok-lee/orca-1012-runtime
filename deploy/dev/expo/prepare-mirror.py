#!/usr/bin/env python3
"""Extract a server-local tar stream and verify the ephemeral execution copy.

No package-manager command is run. The input must contain only public tracked
source, its installed dependencies, and approved generated runtime inputs.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import sys
import tarfile
import time

root = Path(sys.argv[1])
evidence = Path(sys.argv[2])
if root.exists():
    raise SystemExit("destination already exists; refusing to replace it")
root.mkdir(mode=0o700)
entries = {}
started = time.time()
bytes_copied = 0

def safe(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("unsafe archive member")
    return str(path)

def progress(phase):
    value = dict(phase=phase, entries=len(entries), bytesCopied=bytes_copied,
                 elapsedSeconds=round(time.time()-started, 2))
    evidence.write_text(json.dumps(value))
    evidence.chmod(0o600)

with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as archive:
    for item in archive:
        name = safe(item.name)
        destination = root / name
        for parent in destination.parents:
            if parent == root:
                break
            if parent.is_symlink():
                raise ValueError("archive writes through symlink parent")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if item.isdir():
            destination.mkdir(exist_ok=True)
            continue
        if name in entries:
            raise ValueError("duplicate archive member")
        if item.issym():
            target = item.linkname
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
            if target.startswith("/") or resolved == ".." or resolved.startswith("../"):
                raise ValueError("symlink escapes execution copy")
            destination.symlink_to(target)
            entries[name] = dict(kind="symlink", target=target)
        elif item.islnk():
            target = safe(item.linkname)
            os.link(root / target, destination)
            entries[name] = dict(kind="hardlink", target=target)
        elif item.isfile():
            digest = hashlib.sha256()
            source = archive.extractfile(item)
            with destination.open("xb") as output:
                while True:
                    block = source.read(1024*1024)
                    if not block:
                        break
                    output.write(block)
                    digest.update(block)
                    bytes_copied += len(block)
            destination.chmod(item.mode & 0o777)
            os.utime(destination, (item.mtime, item.mtime))
            entries[name] = dict(kind="file", sha256=digest.hexdigest(), mode=item.mode & 0o777)
        else:
            raise ValueError("unsupported archive member type")
        if len(entries) % 2000 == 0:
            progress("copying")
progress("verifying-local-content")
for name, expected in entries.items():
    path = root / name
    if expected["kind"] == "symlink":
        assert path.is_symlink() and os.readlink(path) == expected["target"]
        assert path.exists(), "copied symlink target is absent"
        assert path.resolve().is_relative_to(root.resolve()), "resolved link escapes mirror"
    elif expected["kind"] == "hardlink":
        assert os.path.samefile(path, root / expected["target"])
    else:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024*1024), b""):
                digest.update(block)
        assert digest.hexdigest() == expected["sha256"], "local content differs"
        assert path.stat().st_mode & 0o777 == expected["mode"]
canonical = json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
proof = dict(phase="verified", entries=len(entries), bytesCopied=bytes_copied,
             elapsedSeconds=round(time.time()-started, 2),
             contentAndLayoutSha256=hashlib.sha256(canonical).hexdigest(),
             serverStreamVsLocalContent=True, symlinksPreserved=True,
             hardlinksPreserved=True, packageManagerInvoked=False,
             kinds={kind: sum(v["kind"] == kind for v in entries.values())
                    for kind in ("file", "symlink", "hardlink")})
evidence.write_text(json.dumps(proof, indent=2))
evidence.chmod(0o600)
print(json.dumps(proof))

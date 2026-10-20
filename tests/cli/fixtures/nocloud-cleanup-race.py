"""Owned cleanup syscall schedule around the actual seed command."""
import json
import os
from pathlib import Path
import runpy
import sys

helper, source, output, root = sys.argv[1:]
root = Path(root)
real_unlink, real_rename = os.unlink, os.rename
inserted = False
foreign = b"foreign seed replacement must survive"


def replace(directory):
    global inserted
    real_rename("seed.iso", root / "original-owned.iso", src_dir_fd=directory)
    fd = os.open("seed.iso", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
    os.write(fd, foreign)
    os.close(fd)
    inserted = True


def unlink(path, *args, **kwargs):
    if path == "seed.iso" and not inserted:
        replace(kwargs["dir_fd"])
    return real_unlink(path, *args, **kwargs)


def rename(source, destination, *args, **kwargs):
    if source == "seed.iso" and not inserted:
        replace(kwargs["src_dir_fd"])
    return real_rename(source, destination, *args, **kwargs)


os.unlink, os.rename = unlink, rename
sys.argv = [helper, "--source", source, "--output", output]
try:
    runpy.run_path(helper, run_name="__main__")
except SystemExit as error:
    code = error.code
finally:
    os.unlink, os.rename = real_unlink, real_rename
locations = []
for path in root.rglob("*"):
    if path.is_file() and not path.is_symlink() and path.stat().st_size == len(foreign) and path.read_bytes() == foreign:
        locations.append(str(path.relative_to(root)))
print(json.dumps({"replacementInserted": inserted, "foreignLocations": locations}))
sys.exit(code)

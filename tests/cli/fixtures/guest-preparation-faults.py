"""Owned syscall-protocol faults around the actual preparation executable."""
import json
import os
from pathlib import Path
import runpy
import sys

helper, scenario = sys.argv[1:]
real_stat, real_rename, real_fsync, real_chmod = os.stat, os.rename, os.fsync, os.fchmod
swapped = False
mutated = False
foreign = b"unrelated concurrent output"


def swap():
    global swapped
    real_rename("bun", "owned-moved-partial")
    Path("bun").write_bytes(foreign)
    swapped = True


def fail_sync(fd):
    raise OSError("owned fixture output sync failure")


def race_stat(path, *args, **kwargs):
    value = real_stat(path, *args, **kwargs)
    if path == "bun" and kwargs.get("follow_symlinks") is False and not swapped:
        swap()
    return value


def race_rename(source, destination, *args, **kwargs):
    if source == "bun" and not swapped:
        swap()
    return real_rename(source, destination, *args, **kwargs)


def mutate(fd, mode):
    global mutated
    real_chmod(fd, mode)
    os.pwrite(fd, b"X", 0)
    mutated = True


if scenario == "cleanup-swap":
    os.fsync, os.stat, os.rename = fail_sync, race_stat, race_rename
elif scenario == "output-mutation":
    os.fchmod = mutate
else:
    raise AssertionError("Unknown owned fault scenario")
sys.argv = [helper]
try:
    runpy.run_path(helper, run_name="__main__")
except SystemExit as error:
    code = error.code
finally:
    os.stat, os.rename, os.fsync, os.fchmod = real_stat, real_rename, real_fsync, real_chmod
preserved = []
for path in Path.cwd().rglob("*"):
    if path.is_file() and not path.is_symlink() and path.stat().st_size == len(foreign) and path.read_bytes() == foreign:
        preserved.append(str(path.relative_to(Path.cwd())))
print(json.dumps({"replacementInjected": swapped, "inPlaceMutationInjected": mutated,
                  "foreignLocations": preserved, "outputExists": Path("bun").exists()}))
sys.exit(code)

"""One immutable worker identity and deadline; no command can extend either."""
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from worker_deadline import root_main

if len(sys.argv) != 5 or Path('/proc/sys/kernel/random/boot_id').read_text().strip() != sys.argv[4]:
    raise SystemExit(1)
sys.argv = sys.argv[:4]
root_main()

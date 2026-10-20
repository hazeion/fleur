"""Owned ISO protocol fixture; not evidence of native hdiutil execution."""
from pathlib import Path
import struct
import sys

output = Path(sys.argv[sys.argv.index("-o") + 1])
source = Path(sys.argv[sys.argv.index("-o") + 2])
image = bytearray(22 * 2048)
def both(value, width):
    return value.to_bytes(width, "little") + value.to_bytes(width, "big")
def record(name, block, size, directory=False):
    count = len(name)
    row = bytearray(33 + count + (count % 2 == 0))
    row[0] = len(row)
    row[2:10] = both(block, 4)
    row[10:18] = both(size, 4)
    row[25] = 2 if directory else 0
    row[28:32] = both(1, 2)
    row[32] = count
    row[33:33 + count] = name
    return row
for sector, kind in [(16, 1), (17, 2), (18, 255)]:
    row = bytearray(2048)
    row[0] = kind
    row[1:6] = b"CD001"
    row[6] = 1
    if kind != 255:
        label = b"CIDATA" if kind == 1 else "cidata".encode("utf-16-be")
        row[40:40 + len(label)] = label
        row[80:88] = both(22, 4)
        row[128:132] = both(2048, 2)
        row[156:190] = record(b"\x00", 19, 2048, True)
        if kind == 2:
            row[88:91] = b"%/E"
    image[sector * 2048:(sector + 1) * 2048] = row
entries = record(b"\x00", 19, 2048, True) + record(b"\x01", 19, 2048, True)
for block, name in [(20, "user-data"), (21, "meta-data")]:
    data = (source / name).read_bytes()
    if len(data) > 2048:
        raise RuntimeError("Fixture source exceeds its worked-example extent")
    entries += record(name.encode("utf-16-be"), block, len(data))
    image[block * 2048:block * 2048 + len(data)] = data
image[19 * 2048:19 * 2048 + len(entries)] = entries
with open(output, "xb") as file:
    file.write(image)

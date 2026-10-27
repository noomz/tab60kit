#!/usr/bin/env python3
"""Behavior test for decode_updater.py.

Usage: python3 -I test_decode_updater.py <Tab60firmwareV1.01.13.exe> <empty-work-dir>
"""
import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import decode_updater as du  # noqa: E402

POK3RTOOL_VECTOR = "b77f3fe9d3dfe86e9326633d5edf6f4c1c092c9efa0550d60832a8f4d93d5f3d"
EXE_SHA256 = "fc7ee18829eaccb2c3d56d76af0e24f739d7bbf8640221790fb9d39d716849dd"


def package_encode(buf: bytes) -> bytes:
    b = bytearray(((y & 0x0F) << 4) | (((y >> 4) + 7) & 0x0F) for y in buf)
    n = len(b)
    for i in range(1, n, 2):
        b[i - 1], b[i] = b[i], b[i - 1]
    for i in range(4, n - 1, 5):
        b[i - 4], b[i] = b[i], b[i - 4]
    return bytes(b)


def run(exe: Path, out: Path):
    p = subprocess.run([sys.executable, "-I", str(HERE / "decode_updater.py"), str(exe), str(out)],
                       capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def main():
    exe, work = Path(sys.argv[1]), Path(sys.argv[2])
    work.mkdir(parents=True, exist_ok=True)
    data = exe.read_bytes()
    assert hashlib.sha256(data).hexdigest() == EXE_SHA256, "input is not the V1.01.13 updater"
    failures = []

    def check(cond, label):
        print(("PASS " if cond else "FAIL ") + label)
        if not cond:
            failures.append(label)

    for section in (data[-du.TRAILER_SIZE:], data[0x2D7A00:0x2D7A00 + 34268], data[0x2DFFDC:0x2DFFDC + 180]):
        check(package_encode(du.package_decode(section)) == section, f"encoder inverts decoder on a {len(section)}-byte section")

    code, log = run(exe, work / "a")
    meta = json.loads((work / "a" / "304_V1.01.13.json").read_text()) if code == 0 else {}
    layout = (meta.get("layouts") or [{}])[0]
    fw = layout.get("firmware", {})
    check(code == 0, f"real updater extracts (exit {code})")
    check(len(meta.get("layouts", [])) == 1 and layout.get("name") == "US Layout", "exactly one layout, 'US Layout'")
    check(fw.get("sha256") == POK3RTOOL_VECTOR, "image sha256 equals pok3rtool test_extract.sh vector")
    check(hashlib.sha256((work / "a" / fw.get("file", "missing")).read_bytes()).hexdigest() == POK3RTOOL_VECTOR if fw else False,
          "image file on disk has the vector hash")
    check(fw.get("cortex_m", {}).get("implied_base") == "0x3200", "vector table implies app base 0x3200")
    check(layout.get("version_block", {}).get("magic_word_0xb0") == "0x001c5aa5", "version block magic 0x001c5aa5 (vendor decode)")
    check(meta.get("package", {}).get("version") == "V1.01.13" and meta.get("package", {}).get("product") == "304", "trailer version and product")

    code2, _ = run(exe, work / "b")
    same = (work / "a" / "SHA256SUMS").read_text() == (work / "b" / "SHA256SUMS").read_text() if code2 == 0 else False
    check(same, "second run writes identical outputs")

    trailer_at = len(data) - du.TRAILER_SIZE
    trailer = bytearray(du.package_decode(data[trailer_at:]))

    def with_trailer(mutate):
        t = bytearray(trailer)
        mutate(t)
        return data[:trailer_at] + package_encode(bytes(t))

    def with_section(at, size, mutate, xor=False):
        plain = bytearray(du.package_decode(data[at:at + size]))
        if xor:
            plain = bytearray(du.cykb_xor(bytes(plain)))
        mutate(plain)
        if xor:
            plain = bytearray(du.cykb_xor(bytes(plain)))
        return data[:at] + package_encode(bytes(plain)) + data[at + size:]

    signed = bytearray(data)
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    struct.pack_into("<II", signed, pe + 24 + 96 + 32, len(data), 8)

    cases = {
        "text file": (b"hello, not an exe\n" * 10, "not a PE file"),
        "PE headers only": (data[:0x400], "section table points past end"),
        "16 bytes appended": (data + b"\0" * 16, "no maav102 signature"),
        "last byte cut": (data[:-1], "no maav102 signature"),
        "signature byte changed": (with_trailer(lambda t: t.__setitem__(0xB1A, ord("x"))), "no maav102 signature"),
        "firmware size +52": (with_trailer(lambda t: struct.pack_into("<I", t, 0x848, 34268 + 52)), "does not tile the overlay"),
        "no layouts": (with_trailer(lambda t: struct.pack_into("<II", t, 0x848, 0, 0)), "lists no firmware images"),
        "8-byte firmware": (with_trailer(lambda t: struct.pack_into("<II", t, 0x848, 8, 37300 - 2852 - 8)), "and at least 64 bytes"),
        "authenticode dir set": (bytes(signed), "Authenticode"),
        "image SP outside SRAM": (with_section(0x2D7A00, 34268, lambda b: struct.pack_into("<I", b, 0, 0x12345678), xor=True), "outside SRAM"),
        "image reset vector even": (with_section(0x2D7A00, 34268, lambda b: struct.pack_into("<I", b, 4, 0x32C0), xor=True), "not Thumb"),
        "version magic broken": (with_section(0x2DFFDC, 180, lambda b: b.__setitem__(0xB0, 0)), "version block magic missing"),
    }
    for label, (blob, reason) in cases.items():
        path = work / f"case-{label.replace(' ', '_')}.exe"
        path.write_bytes(blob)
        code, log = run(path, work / f"out-{label.replace(' ', '_')}")
        check(code == 2 and reason in log, f"refuses {label}: exit {code}, {log.strip()[:110]!r}")

    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

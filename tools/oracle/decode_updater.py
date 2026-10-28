#!/usr/bin/env python3
"""Extract firmware from a Cheng Yong (CYKB) "maav102" updater exe, such as the Vortex TAB 60 updater.

Usage: python3 -I decode_updater.py <updater.exe> <outdir>

The exe is only read as bytes, never executed. Any input whose structure is not fully
recognized is refused with exit code 2. Format and evidence: docs/updater-package.md.
"""
import hashlib
import json
import re
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

TRAILER_SIZE = 0xB24
SIGNATURE_AT = 0xB19
SIGNATURE = b".maaV102\0\0"
STRING_FIELDS = (("title", 0x026), ("company", 0x22E), ("product", 0x436), ("version", 0x63E))
STRING_FIELD_BYTES = 0x208
LAYOUT_TABLE_AT = 0x848
LAYOUT_SLOTS = 9
LAYOUT_RECORD_SIZE = 0x50
VERSION_BLOCK_SIZE = 0xB4
VERSION_MAGIC_AT = 0xB0
VERSION_MAGIC = 0x5AA5
VERSION_PATCH_LEN = 0x1A
CYKB_XOR_KEY = (0xE7C29474, 0x79084B10, 0x53D54B0D, 0xFC1E8F32, 0x48E81A9B, 0x773C808E, 0xB7483552,
                0xD9CB8C76, 0x2A8C8BC6, 0x0967ADA8, 0xD4520F5C, 0xD0C3279D, 0xEAC091C5)
SRAM_START, SRAM_END = 0x2000_0000, 0x2001_0000
VECTOR_TABLE_MIN = 0x40
KEIL_RESET_STUB = re.compile(rb".\x48\x80\x47.\x48\x00\x47", re.S)


class Refused(Exception):
    pass


@dataclass(frozen=True)
class Layout:
    slot: int
    name: str
    firmware_size: int
    version_block_size: int
    layout_id: int
    gate_byte_46: int
    gate_byte_47: int
    gate_u32_48: int
    u32_4c: int


@dataclass(frozen=True)
class Trailer:
    raw: bytes
    strings: dict
    identity: bytes
    vid: int
    identity_pid: int
    identity_u16_08: int
    identity_u16_0a: int
    identity_u32_0c: int
    u32_10: int
    boot_vid: int
    boot_pid: int
    app_vid: int
    app_pid: int
    write_block_size: int
    u16_846: int
    layouts: tuple


def package_decode(buf: bytes) -> bytes:
    """Undo the updater's per-section scrambling, mirroring its sub_401000.

    The 5-byte swap pass stops one group early when len % 5 == 0. pok3rtool does not stop
    early, so it corrupts bytes len-6 and len-2 of such sections, e.g. the 180-byte version block.
    """
    b = bytearray(buf)
    n = len(b)
    for i in range(4, n - 1, 5):
        b[i - 4], b[i] = b[i], b[i - 4]
    for i in range(1, n, 2):
        b[i - 1], b[i] = b[i], b[i - 1]
    return bytes((((x - 7) << 4) & 0xFF) | (x >> 4) for x in b)


def cykb_xor(buf: bytes) -> bytes:
    words = struct.unpack(f"<{len(buf) // 4}I", buf)
    return struct.pack(f"<{len(words)}I", *(w ^ CYKB_XOR_KEY[i % len(CYKB_XOR_KEY)] for i, w in enumerate(words)))


def sum32(buf: bytes) -> int:
    return sum(struct.unpack(f"<{len(buf) // 4}I", buf)) & 0xFFFF_FFFF


def sha256(buf: bytes) -> str:
    return hashlib.sha256(buf).hexdigest()


def utf16z(raw: bytes) -> str:
    return raw.decode("utf-16le").split("\0", 1)[0]


def pe_overlay_offset(data: bytes) -> int:
    if data[:2] != b"MZ":
        raise Refused("not a PE file (no MZ header)")
    pe, = struct.unpack_from("<I", data, 0x3C)
    if data[pe:pe + 4] != b"PE\0\0":
        raise Refused("not a PE file (no PE signature)")
    sections, = struct.unpack_from("<H", data, pe + 6)
    optional_size, = struct.unpack_from("<H", data, pe + 20)
    optional = pe + 24
    magic, = struct.unpack_from("<H", data, optional)
    if magic != 0x10B:
        raise Refused(f"not a PE32 image (optional header magic 0x{magic:x})")
    directories, = struct.unpack_from("<I", data, optional + 92)
    if directories > 4 and struct.unpack_from("<II", data, optional + 96 + 4 * 8)[1]:
        raise Refused("exe carries an Authenticode certificate in its overlay; known updaters are unsigned")
    table = optional + optional_size
    ends = [sum(struct.unpack_from("<II", data, table + 40 * i + 16)) for i in range(sections)]
    if not ends or max(ends) > len(data):
        raise Refused("PE section table points past end of file")
    return max(ends)


def parse_trailer(t: bytes) -> Trailer:
    if t[SIGNATURE_AT:SIGNATURE_AT + len(SIGNATURE)] != SIGNATURE:
        raise Refused(f"no maav102 signature: decoded trailer bytes 0x{SIGNATURE_AT:x}.. are {t[SIGNATURE_AT:SIGNATURE_AT + 10]!r}")
    strings = {name: utf16z(t[at:at + STRING_FIELD_BYTES]) for name, at in STRING_FIELDS}
    u32_00, vid, identity_pid, u16_08, u16_0a, u32_0c, u32_10, boot_vid, boot_pid, app_vid, app_pid = \
        struct.unpack_from("<IHHHHIIIIII", t, 0)
    layouts = []
    for slot in range(LAYOUT_SLOTS):
        at = LAYOUT_TABLE_AT + slot * LAYOUT_RECORD_SIZE
        fw_size, ver_size = struct.unpack_from("<II", t, at)
        layout_id, b46, b47, u48, u4c = struct.unpack_from("<HBBII", t, at + 0x44)
        layouts.append(Layout(slot, utf16z(t[at + 8:at + 0x44]), fw_size, ver_size, layout_id, b46, b47, u48, u4c))
    return Trailer(t, strings, t[:0x10], vid, identity_pid, u16_08, u16_0a, u32_0c, u32_10,
                   boot_vid, boot_pid, app_vid, app_pid, t[0x24], struct.unpack_from("<H", t, 0x846)[0],
                   tuple(layouts))


def locate_sections(file_size: int, overlay: int, layouts) -> dict:
    """Walk backwards from the trailer exactly as the updater does: slot 8 first, version block then firmware."""
    pos = file_size - TRAILER_SIZE
    spans = {}
    for layout in reversed(layouts):
        pos -= layout.version_block_size
        version_at = pos
        pos -= layout.firmware_size
        spans[layout.slot] = (pos, version_at)
    if pos != overlay:
        raise Refused(f"package does not tile the overlay: package starts at {pos:#x}, overlay at {overlay:#x}")
    return spans


def patch_version_block(block: bytes, trailer: Trailer) -> bytes:
    """The updater overwrites the length word and the first 26 string bytes before writing the block."""
    at = dict(STRING_FIELDS)["version"]
    return struct.pack("<I", VERSION_PATCH_LEN) + trailer.raw[at:at + VERSION_PATCH_LEN] + block[4 + VERSION_PATCH_LEN:]


def describe_version_block(block: bytes) -> dict:
    length, = struct.unpack_from("<I", block, 0)
    magic_word, = struct.unpack_from("<I", block, VERSION_MAGIC_AT)
    return {
        "string": utf16z(block[4:4 + length]),
        "string_bytes": length,
        "words_0x78": [f"0x{w:08x}" for w in struct.unpack_from("<7I", block, 0x78)],
        "vid": f"0x{struct.unpack_from('<H', block, 0x90)[0]:04x}",
        "pid": f"0x{struct.unpack_from('<H', block, 0x92)[0]:04x}",
        "magic_word_0xb0": f"0x{magic_word:08x}",
    }


def cortex_m_vectors(img: bytes, trailer: Trailer) -> dict:
    sp, reset = struct.unpack_from("<II", img, 0)
    if not (SRAM_START < sp <= SRAM_END and sp % 4 == 0):
        raise Refused(f"decoded image has no Cortex-M vector table: initial SP 0x{sp:08x} is outside SRAM")
    if not reset & 1:
        raise Refused(f"decoded image has no Cortex-M vector table: reset vector 0x{reset:08x} is not Thumb")
    handlers = [v for v in struct.unpack_from("<15I", img, 4) if v not in (0, 0xFFFF_FFFF)]
    stubs = [m.start() for m in KEIL_RESET_STUB.finditer(img) if m.start() % 2 == 0]
    bases = [(reset & ~1) - at for at in stubs]
    bases = [b for b in bases if b >= 0 and b % 0x100 == 0 and all(b <= (h & ~1) < b + len(img) for h in handlers)]
    base = bases[0] if len(bases) == 1 else None
    usb = re.search(rb"\x12\x01[\x00-\x02][\x01\x02]...[\x08\x10\x20\x40]" + struct.pack("<HH", trailer.app_vid, trailer.app_pid), img, re.S)
    return {
        "initial_sp": f"0x{sp:08x}",
        "reset": f"0x{reset:08x}",
        "system_handlers": [f"0x{v:08x}" for v in struct.unpack_from("<15I", img, 4)],
        "all_system_handlers_thumb": all(h & 1 for h in handlers),
        "implied_base": None if base is None else f"0x{base:x}",
        "implied_base_evidence": None if base is None else f"Keil reset stub (ldr r0,=SystemInit; blx r0; ldr r0,=__main; bx r0) at image offset 0x{(reset & ~1) - base:x}",
        "implied_end": None if base is None else f"0x{base + len(img):x}",
        "usb_device_descriptor": None if not usb else {
            "image_offset": usb.start(),
            "vid": f"0x{trailer.app_vid:04x}",
            "pid": f"0x{trailer.app_pid:04x}",
            "bcd_device": f"0x{struct.unpack_from('<H', img, usb.start() + 12)[0]:04x}",
        },
    }


def safe(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9.]+", "_", text).strip("_") or "unnamed"


def extract(exe: Path, outdir: Path) -> dict:
    data = exe.read_bytes()
    try:
        overlay = pe_overlay_offset(data)
    except struct.error as e:
        raise Refused(f"truncated or malformed PE headers ({e})")
    if len(data) - overlay < TRAILER_SIZE:
        raise Refused(f"overlay is {len(data) - overlay} bytes, smaller than the {TRAILER_SIZE}-byte maav102 trailer")
    try:
        trailer = parse_trailer(package_decode(data[-TRAILER_SIZE:]))
    except UnicodeDecodeError as e:
        raise Refused(f"trailer string field is not UTF-16LE ({e})")
    present = [l for l in trailer.layouts if l.firmware_size]
    if not present:
        raise Refused("trailer lists no firmware images")
    spans = locate_sections(len(data), overlay, trailer.layouts)

    stem = f"{safe(trailer.strings['product'])}_{safe(trailer.strings['version'])}"
    outdir.mkdir(parents=True, exist_ok=True)
    outputs = {}
    layouts = []
    for layout in present:
        fw_at, ver_at = spans[layout.slot]
        if layout.firmware_size % 4 or layout.firmware_size < VECTOR_TABLE_MIN:
            raise Refused(f"slot {layout.slot}: firmware size {layout.firmware_size} must be a multiple of 4 "
                          f"and at least {VECTOR_TABLE_MIN} bytes")
        if layout.version_block_size != VERSION_BLOCK_SIZE:
            raise Refused(f"slot {layout.slot}: version block is {layout.version_block_size} bytes, expected {VERSION_BLOCK_SIZE}")
        wire = package_decode(data[fw_at:fw_at + layout.firmware_size])
        image = cykb_xor(wire)
        vectors = cortex_m_vectors(image, trailer)
        block = package_decode(data[ver_at:ver_at + layout.version_block_size])
        if struct.unpack_from("<H", block, VERSION_MAGIC_AT)[0] != VERSION_MAGIC:
            raise Refused(f"slot {layout.slot}: version block magic missing at 0x{VERSION_MAGIC_AT:x}")
        patched = patch_version_block(block, trailer)
        name = f"{stem}_bin{layout.slot + 1}_{safe(layout.name)}"
        outputs[f"{name}.bin"] = image
        outputs[f"{name}.version.bin"] = patched
        layouts.append({
            "slot": layout.slot,
            "updater_arg": f"bin:{layout.slot + 1}",
            "name": layout.name,
            "layout_id": f"0x{layout.layout_id:04x}",
            "version_gate": {"byte_46": f"0x{layout.gate_byte_46:02x}", "byte_47": f"0x{layout.gate_byte_47:02x}",
                             "u32_48": f"0x{layout.gate_u32_48:08x}"},
            "u32_4c": f"0x{layout.u32_4c:08x}",
            "firmware": {
                "file": f"{name}.bin",
                "exe_offset": fw_at,
                "size": layout.firmware_size,
                "write_blocks": -(-layout.firmware_size // trailer.write_block_size),
                "sha256": sha256(image),
                "wire_sha256": sha256(wire),
                "wire_sum32": f"0x{sum32(wire):08x}",
                "cortex_m": vectors,
            },
            "version_block": {
                "file": f"{name}.version.bin",
                "exe_offset": ver_at,
                "size": layout.version_block_size,
                "sha256": sha256(patched),
                "bytes_changed_by_updater_patch": sum(a != b for a, b in zip(block, patched)),
                "gate_fields_match_layout_record": block[0x7A:0x80] == trailer.raw[LAYOUT_TABLE_AT + layout.slot * LAYOUT_RECORD_SIZE + 0x46:][:6],
                **describe_version_block(patched),
            },
        })

    meta = {
        "format": "maav102",
        "input": {"file": exe.name, "size": len(data), "sha256": sha256(data), "overlay_offset": overlay,
                  "overlay_size": len(data) - overlay},
        "package": {
            "exe_offset": overlay,
            "trailer_offset": len(data) - TRAILER_SIZE,
            "trailer_size": TRAILER_SIZE,
            "signature": SIGNATURE.rstrip(b"\0").decode(),
            **trailer.strings,
            "stored_checksum": None,
            "device": {
                "identity_hex": trailer.identity.hex(),
                "vid": f"0x{trailer.vid:04x}",
                "identity_pid": f"0x{trailer.identity_pid:04x}",
                "identity_u16_08": f"0x{trailer.identity_u16_08:04x}",
                "identity_u16_0a": f"0x{trailer.identity_u16_0a:04x}",
                "identity_u32_0c": f"0x{trailer.identity_u32_0c:08x}",
                "u32_10": f"0x{trailer.u32_10:08x}",
                "boot_vid": f"0x{trailer.boot_vid:04x}",
                "boot_pid": f"0x{trailer.boot_pid:04x}",
                "app_vid": f"0x{trailer.app_vid:04x}",
                "app_pid": f"0x{trailer.app_pid:04x}",
                "write_block_size": trailer.write_block_size,
            },
            "u16_846": f"0x{trailer.u16_846:04x}",
            "empty_slots": [l.slot for l in trailer.layouts if not l.firmware_size],
        },
        "ciphers": {
            "package": "per section: swap bytes (5k, 5k+4) while 5k+4 <= n-2, swap byte pairs, then x -> ((x-7)<<4 | x>>4) & 0xff",
            "firmware": "after package decode: little-endian u32 words XOR a 13-word key (pok3rtool cykb.py xor_key); the updater sends this 'wire' form",
        },
        "layouts": layouts,
    }
    outputs[f"{stem}.json"] = (json.dumps(meta, indent=2) + "\n").encode()
    for name, blob in outputs.items():
        (outdir / name).write_bytes(blob)
    (outdir / "SHA256SUMS").write_text("".join(f"{sha256(blob)}  {name}\n" for name, blob in sorted(outputs.items())))
    return meta


def main(argv) -> int:
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 64
    try:
        meta = extract(Path(argv[1]), Path(argv[2]))
    except Refused as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 2
    p = meta["package"]
    print(f"{meta['format']}: {p['title']!r} product {p['product']!r} version {p['version']!r}")
    for l in meta["layouts"]:
        fw = l["firmware"]
        print(f"  {l['updater_arg']} {l['name']!r}: {fw['size']} bytes, sha256 {fw['sha256']}, base {fw['cortex_m']['implied_base']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

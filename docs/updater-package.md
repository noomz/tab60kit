# The updater package format

Code comments in this repository cite this page for how `core/updater.ts` reads the vendor updater. Each fact has a label. VERIFIED means seen in the bytes, in disassembly, or in a script result. INFERRED means it follows from verified facts. GUESS means a hypothesis with weak support.

## How this was learned

The official updater (Tab60firmwareV1.01.13.exe, sha256 fc7ee18829eaccb2c3d56d76af0e24f739d7bbf8640221790fb9d39d716849dd) was read as bytes. It was never run, and no Vortex bytes are in this repository or redistributed. It was read only to learn the container format needed to extract the firmware on the user's own machine. Addresses cite that file.

The exe is 3,017,652 bytes. It is a PE32 i386 MFC program with no Authenticode signature. The extracted plain image has sha256 `b77f3fe9d3dfe86e9326633d5edf6f4c1c092c9efa0550d60832a8f4d93d5f3d`. pok3rtool's test list gives the same input and output hashes for this exe (https://github.com/pok3r-custom/pok3rtool/blob/7da3d5169bd5d7218464d302024e97c0d109999a/test_extract.sh#L78). The decoder here follows the updater's own routine, not pok3rtool's code, so the match cross-checks two implementations.

## Container

The package is the PE overlay: everything after the last section. Its format is called maav102, after the signature string in the trailer. [VERIFIED]

| File offset | Bytes | Region |
|---|---|---|
| 0x2D7A00 | 34,268 | Slot 0 firmware section |
| 0x2DFFDC | 180 | Slot 0 version block |
| 0x2E0090 | 2,852 | Trailer, which ends at the end of the file |

The format has room for nine layout slots. Slots 1 to 8 are empty here, so the only image is slot 0, "US Layout". The vendor's `bin:N` argument selects slot N - 1. [VERIFIED]

The updater finds the package from the file tail. It reads the last 0xB24 bytes, decodes them, and checks the signature. It then walks slots 8 down to 0. For each slot it steps back by the version block size and reads that block, then steps back by the firmware size and reads the firmware. The file order is therefore firmware 0, version block 0, firmware 1, version block 1, and so on, then the trailer. [VERIFIED, routine 0x404390]

Each layout record in the trailer is 80 bytes, starting at trailer offset 0x848 + 80 x slot:

| Offset | Type | Field | Slot 0 |
|---|---|---|---|
| 0x00 | u32 | firmware size | 34,268 |
| 0x04 | u32 | version block size | 180 |
| 0x08 | UTF-16LE, 30 units | layout name | "US Layout" |
| 0x44 | u16 | layout ID | 0x0001 |
| 0x46 | u8, u8, u32 | version gate | 0x80, 0x00, 0x00010013 |

The version block is 180 bytes. It holds the version string at offset 0x04 (UTF-16LE, 26 bytes), the same gate bytes at 0x7A, a VID and PID pair (0x04D9, 0x0304) at 0x90, and the magic 0x5AA5 at offset 0xB0. [VERIFIED]

## Scramble

Each section is scrambled on its own, with no key. The swap positions restart at offset 0 in every section: the trailer, each version block and each firmware section. [VERIFIED, routine 0x401000, called at 0x4044A8, 0x4045A3 and 0x4045F5]

To undo it on a section of n bytes, do these steps in order:

1. For i = 4, 9, 14, and so on, while i <= n - 2, swap byte i - 4 with byte i.
2. For i = 1, 3, 5, and so on, while i <= n - 1, swap byte i - 1 with byte i.
3. Replace each byte x with ((x - 7) << 4 | x >> 4) & 0xFF.

A zero byte encodes as 0x07, so the raw trailer ends in a long run of 0x07.

The bound in step 1 matters. The updater runs that loop floor((n - 6) / 5) + 1 times. pok3rtool's decoder loops while i < n (https://github.com/pok3r-custom/pok3rtool/blob/7da3d5169bd5d7218464d302024e97c0d109999a/pok3rtool/package.py#L23-L43). That is one extra swap when n is a multiple of 5. The 180-byte version block is such a section, so pok3rtool swaps bytes 174 and 178 and reads the magic as 0x00FF5AA5 instead of 0x001C5AA5. The firmware section (34,268 bytes) and the trailer (2,852 bytes) are not multiples of 5, so pok3rtool's firmware output for this exe is still correct. [VERIFIED]

The scrambled firmware section is not yet the image. Its 32-bit little-endian words are XORed with a 13-word key (word i uses key word i mod 13). The updater never removes this layer. It sends and checksums the buffer that the scramble decoder returns, which is called the wire form. The bootloader removes the XOR when it writes flash. [VERIFIED for the updater, INFERRED for the bootloader] The key comes from pok3rtool (https://github.com/pok3r-custom/pok3rtool/blob/7da3d5169bd5d7218464d302024e97c0d109999a/pok3rtool/cykb.py#L71-L99):

```
E7C29474 79084B10 53D54B0D FC1E8F32 48E81A9B 773C808E B7483552
D9CB8C76 2A8C8BC6 0967ADA8 D4520F5C D0C3279D EAC091C5
```

Applying the XOR twice gives the input back, so one function turns the wire form into the plain image and back. Of the four firmware ciphers pok3rtool knows, only this one yields a valid vector table. The still-XORed section also repeats with the key's 52-byte period. [VERIFIED]

## Trailer identity

The trailer is the last 2,852 bytes (0xB24), after the scramble is removed. [VERIFIED]

| Offset | Type | Field | V1.01.13 value |
|---|---|---|---|
| 0x000 | 16 bytes | identity | `00000000d904041340700404ffffffff` |
| 0x014 | u32 | `boot_vid` | 0x04D9 |
| 0x018 | u32 | `boot_pid` | 0x1304 |
| 0x01C | u32 | `app_vid` | 0x04D9 |
| 0x020 | u32 | `app_pid` | 0x0304 |
| 0x024 | u8 | `write_block_size` | 52 |
| 0x026 | UTF-16LE, 260 units | title | "KB upgrade" |
| 0x22E | UTF-16LE, 260 units | company | "IAP Version V1.0.0" |
| 0x436 | UTF-16LE, 260 units | product | "304" |
| 0x63E | UTF-16LE, 260 units | version | "V1.01.13" |
| 0x848 | 9 x 80 bytes | layout records | slot 0 used |
| 0xB19 | 10 bytes | signature | `.maaV102\0\0` |

- The updater compares the 16 identity bytes with 16 bytes it reads from the keyboard. On a mismatch it selects no layout and shows "HW Setup Error!". [VERIFIED, 0x404E80 to 0x404EE0] Inside the identity, the bytes at 0x004 to 0x007 are VID 0x04D9 and PID 0x1304, which is 0x0304 with bit 0x1000 set. pok3rtool treats that bit as boot mode. The field names `boot_pid` and `app_pid` come from pok3rtool, so they are INFERRED. The values match the live keyboard.
- The flash routine reads `write_block_size` and writes the firmware in ceil(size / 52) blocks. The firmware section is exactly 659 x 52 bytes. [VERIFIED, 0x40511F and 0x405204]
- The updater copies the first 26 bytes of the version string into the version block before it writes the block. The extractor does the same. For V1.01.13 the copy changes no bytes. [VERIFIED, 0x405578 to 0x405594]
- The updater checks the signature after decoding the trailer. On a mismatch it shows "Fail to find firmware information!". [VERIFIED, 0x4044C9 to 0x404528]
- The meaning of the other trailer fields (0x000 u32, 0x008, 0x00A, 0x00C, 0x010, 0x846) is unknown. None of them blocks extraction.

The version gate compares the slot's gate bytes with three values the keyboard reports, and passes when the package is greater than or equal. If the keyboard reports 0xFF in both bytes, the updater treats it as blank and passes. An equal version passes, although the error text says "The update version is the same or older!". [VERIFIED by code reading, 0x40678E to 0x4067C5. Not tested at run time.]

## Image base

The plain image is Cortex-M3 code linked at 0x3200. [VERIFIED]

- The vector table has 48 entries, 16 system and 32 IRQ. The initial stack pointer is 0x20003FE0, inside SRAM. The reset vector is 0x000032C1, a Thumb address.
- At 0x32C0 sits the Keil startup stub: `ldr r0,=SystemInit; blx r0; ldr r0,=__main; bx r0`. It starts right after the vector table, at image offset 0xC0. SystemInit is 0x3431 and `__main` is 0x32DD.
- NMI, HardFault, SVCall and PendSV each point at `b .` (0xE7FE). The reserved slots hold 0xFFFFFFFF.
- The image has 126 distinct odd 32-bit words below 0x40000. At base 0x3200, 39 of them land on a `push {..., lr}`. The best other base scores 6.
- The image spans 0x3200 to 0xB7DB. A USB device descriptor at image address 0xAFA0 holds VID 0x04D9, PID 0x0304, bcdDevice 0x0110 and no serial string.

The extractor derives the base the same way. It takes the reset vector, finds the Keil stub in the plain image, and subtracts the stub's offset. A base is accepted only if it is a multiple of 0x100 and every non-blank handler address falls inside the image at that base. If not exactly one base fits, `impliedBase` is null. The package itself carries no load address, so a flasher must check that the bootloader's firmware offset matches 0x3200 before it writes. [INFERRED]

## Refusals

`parseMaav102` in `core/updater.ts` returns a refusal instead of guessing. It checks in this order, and the Python decoder uses the same order. The Python decoder prints `REFUSED: <reason>` and exits with code 2.

| Code | When |
|---|---|
| `not-pe` | No MZ header, no PE signature, truncated headers, or a section table that points past the end of the file. |
| `not-pe32` | The optional header magic is not 0x10B. |
| `signed-exe` | The Authenticode certificate directory is set. Known updaters are unsigned, and a certificate would sit in the overlay. |
| `overlay-too-small` | The overlay is shorter than the 2,852-byte trailer. |
| `no-maav102-signature` | The decoded trailer does not hold `.maaV102\0\0` at offset 0xB19. |
| `bad-string-field` | A trailer string field is not valid UTF-16LE. |
| `no-firmware` | Every slot has firmware size 0. |
| `sections-do-not-tile` | The sections the trailer lists do not fill the overlay exactly. There is a gap or an overlap. |
| `different-board` | The 16 identity bytes differ from the TAB 60 identity above. |
| `bad-firmware-size` | A firmware size is not a multiple of 4, or is under 64 bytes. |
| `bad-version-block` | A version block is not 180 bytes (`size`), or lacks the magic 0x5AA5 at 0xB0 (`magic`). |
| `no-vector-table` | The plain image has an initial SP outside SRAM (above 0x20000000 and at most 0x20010000), or an even reset vector. |

The vendor updater has its own refusals when it cannot pick a slot: "Layout Fail!", "HW Setup Error!" and "Get Info Error!". [VERIFIED, 0x4065E5 to 0x4066E8] Those happen against a live keyboard, which this tool does not need to read for extraction.

## Checksums

The package stores no checksum of the firmware. Ten candidates were tried over the raw overlay bytes, the wire form and the plain image: a 32-bit word sum, CRC-32, a byte sum and CRC-16-CCITT. None occurs in the trailer or the version block. [VERIFIED for these candidates]

The updater computes a checksum at run time instead. After it writes the firmware, it sums the wire form as little-endian u32 words modulo 2^32 (routine 0x402B00). It asks the keyboard for its own sum (routine 0x408780) and compares the two. On a mismatch it erases and rewrites the firmware, for at most three attempts in total, then shows "Fail to  CheckSum FW Data!". [VERIFIED, 0x405402 to 0x405467]

For V1.01.13 the wire sum32 is 0xF3D3DBD2. pok3rtool says the device sums the encrypted data (https://github.com/pok3r-custom/pok3rtool/blob/7da3d5169bd5d7218464d302024e97c0d109999a/pok3rtool/cykb.py#L376-L386), so a good flash should return the same value. [INFERRED] `core/firmware.ts` also holds the zlib CRC-32 of the wire form (0xF1ACB333), which is pok3rtool's second check. The updater itself does not use a CRC.

After the firmware, the updater writes the version block and reads it back in 60-byte chunks to compare. The write pointer is 0 for the version block. For the firmware it is a u16 from the keyboard's firmware info reply. The package does not say which flash addresses those values mean. [VERIFIED calls at 0x405538 and 0x4051B2]

## Parity oracle

`tools/oracle/decode_updater.py` is the reference decoder. It uses only the Python standard library and is run with `python3 -I`. It writes the plain image, the patched version block, a JSON metadata file and a `SHA256SUMS` file.

`core/updater.ts` is a pure TypeScript port of it. `bun run real-exe` runs both on the vendor exe and compares their outputs byte for byte, and checks the twelve refusal cases below against the real file. CI holds no vendor bytes. It builds synthetic packages with `testing/maav102.ts`, whose `scramble` is written from the description above rather than from the decoder's `unscramble`, so the two check each other.

`tools/oracle/test_decode_updater.py` runs 23 checks. Eleven cover the real exe, a second run and an encoder round trip. The other twelve feed mutated copies of the exe and expect a refusal with a specific reason. `testing/updater-cases.ts` holds the same twelve for the TypeScript port:

1. A text file: `not-pe`.
2. PE headers only: `not-pe`.
3. 16 bytes appended: `no-maav102-signature`.
4. Last byte cut: `no-maav102-signature`.
5. One signature byte changed: `no-maav102-signature`.
6. Firmware size plus 52: `sections-do-not-tile`.
7. No layouts: `no-firmware`.
8. An 8-byte firmware: `bad-firmware-size`.
9. Authenticode directory set: `signed-exe`.
10. Image stack pointer outside SRAM: `no-vector-table` (`sp-outside-sram`).
11. Even reset vector: `no-vector-table` (`reset-not-thumb`).
12. Version magic broken: `bad-version-block` (`magic`).

A decoder that used pok3rtool's swap bound would fail case 12 on the real exe, so the suite detects that defect. [VERIFIED]

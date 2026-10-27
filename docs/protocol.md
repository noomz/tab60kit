# Vortex TAB 60 update protocol

This page describes how tab60kit talks to the Vortex TAB 60 over USB HID. It covers the update protocol ("CYKB") that the firmware and its bootloader speak. It is the reference for `core/protocol.ts`, `core/flashmap.ts`, `core/chip.ts` and `core/device.ts`.

Every claim carries one of three labels.

- **VERIFIED**: seen in source code, in a document, or in a byte-level check of a file or of a recorded session.
- **INFERRED**: derived from verified facts by a stated step.
- **GUESS**: plausible but unsupported. Treat it as a hypothesis.

A claim with no label is a plain description of what this tool does. "Not known" means no source answers it.

## Packet framing

All traffic uses 64-byte HID reports on the vendor interface. There is no report ID (report ID 0). VERIFIED.

Request, 64 bytes, zero padded:

| Byte | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `cmd` | Command family. VERIFIED |
| 1 | 1 | `sub` | Sub-command. For WRITE it is the payload length. VERIFIED |
| 2..3 | 2 | argument | Always `00 00` on the update commands. See below |
| 4.. | up to 60 | payload | Little-endian. WRITE carries at most 52 bytes |

- **Bytes 2..3.** pok3rtool sends `0x0000` here. The official updater never writes these bytes, so they stay zero in every frame it builds (updater 0x408xxx wrappers). VERIFIED. The ROM ISP of the same chip family puts a CRC-16 in this position. That the update protocol ignores a non-zero value is a GUESS. The app firmware reads bytes 2..3 as an argument for some of its own commands, so this tool holds them at zero on update rows.
- **Fields.** Addresses, lengths and sums are little-endian u32 values (LE u32). Offsets in ERASE, SUM, CRC and the write address count from absolute `0x3000`. See [Flash map](#flash-map). VERIFIED.
- **WebHID.** Send with `sendReport(0, packet64)`. Replies arrive as `inputreport` events with `reportId` 0. INFERRED from report ID 0.

Reply, 64 bytes:

| Byte | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `cmd` | Echo of the request. VERIFIED |
| 1 | 1 | `sub` | Echo of the request. VERIFIED |
| 2..3 | 2 | argument | `00 00`. pok3rtool rejects any other value. VERIFIED |
| 4.. | up to 60 | payload | Little-endian. VERIFIED |

Two replies do not follow the echo rule.

- **Write ack.** A WRITE (`1F n`) is answered by `1E 02`, then a u32 with the next write address (the offset after the bytes just written). VERIFIED. The vendor updater accepts this reply for a sent `1F` (updater 0x40770F). VERIFIED.
- **Error marker.** A reply that starts with bytes `FF AA` is an error. Bytes 4 and 5 repeat the `cmd` and `sub` of the request that failed. VERIFIED in pok3rtool and in the vendor updater (updater 0x407731).

The vendor updater drops any report that is not one of three cases: an echo of bytes 0..3, the `1E 02` write ack, or an `FF AA` naming the sent command. A waiting command then times out. VERIFIED. tab60kit's reply check is at least this strict.

Reset commands (`11 00`, `11 01`) get no reply. The board re-enumerates instead. The vendor updater sends them without waiting for an answer. VERIFIED.

## Modes and device IDs

The board has two USB personalities. Each has its own product ID, so each needs its own WebHID permission. Every reset drops the open device handle. INFERRED.

| Mode | VID:PID | Product string | Status |
|---|---|---|---|
| Normal ("app") | `04D9:0304` | "USB-HID Keyboard" | VERIFIED. Measured on the board. bcdDevice `0x0110` |
| Update ("IAP") | `04D9:1304` | "USB-HID IAP" | VERIFIED. Observed on the board in the U1 session. Before that it was INFERRED: the bootloader PID is the app PID with bit `0x1000` set (pok3rtool's rule, and six sibling bootloader dumps agree) |

- **Vendor interface.** Interface 1 in both modes. HID class, 64-byte input and output reports, no feature reports. Top-level collection: usage page `0xFF00`, usage `0x01`. VERIFIED. The report descriptor is `06 00 FF 09 01 A1 01 09 02 15 00 26 FF 00 75 08 95 40 81 02 09 03 15 00 26 FF 00 75 08 95 40 91 02 C0`. VERIFIED, from the firmware image and six sibling bootloader dumps.
- **WebHID filter.** `{vendorId: 0x04d9, productId: 0x0304 or 0x1304, usagePage: 0xff00, usage: 0x01}`. The usage-page filter keeps the keyboard interfaces out of the permission.
- **Reset to IAP.** `11 00`, sent in app mode. The board re-enumerates as `04D9:1304`. VERIFIED.
- **Reset to app.** `11 01`, sent in update mode. The board re-enumerates as `04D9:0304`. VERIFIED.
- **Which mode am I in.** The product ID says it. READ MODE (`12 02`) says it too, with reply byte 0 equal to 0 in update mode and 1 in normal mode. This was confirmed on the board over 63 reads (U1). The official updater never sends READ MODE (see [Sequences](#sequences)).
- **ROM ISP.** A different USB device, `04D9:8010`, appears only when a BOOT pin is strapped at power-up. It is the chip maker's recovery loader and uses another protocol. tab60kit does not speak it. The board's location for the strap is not known.
- **MCU.** Most likely a Holtek HT32F52352 (Cortex-M0+), sold with the marking "HT50F52352". The firmware's 48-entry vector table fits this. INFERRED. The TAB 60 marking itself is a GUESS until someone opens the case.

## Commands

The table lists every command tab60kit may send for flashing and for reading the chip. "Mode" says where the command exists. A command is only known to work in the modes listed. "IAP" rows were only ever sent in update mode, and their behavior in app mode is not known.

| cmd/sub | Name | Request payload | Reply payload | Mode | Label |
|---|---|---|---|---|---|
| `12/00` | READ BL INFO | none | 60 bytes of absolute `0x400`. See [BL info block](#bl-info-block) | app, IAP | VERIFIED. Confirmed on the board in both modes |
| `12/01` | READ FW INFO | none | 4 bytes of absolute `0x3C00` | IAP in this tool. The vendor updater also sends it in app mode | VERIFIED |
| `12/02` | READ MODE | none | byte 0: 0 = IAP, 1 = app | app, IAP | VERIFIED. pok3rtool only. The vendor updater never sends it |
| `12/20..22` | READ VERSION PAGE, part i | none | 60 bytes of absolute `0x3000 + 60*i` | app, IAP | VERIFIED |
| `11/00` | RESET to IAP | none | none. The board re-enumerates | app | VERIFIED |
| `11/01` | RESET to app | none | none. The board re-enumerates | IAP | VERIFIED |
| `1D/00` | ERASE | u32 offset, u32 length | echo, sent when the erase is done | IAP | VERIFIED. Page granular |
| `1D/01` | SUM | u32 offset, u32 length | u32 sum | IAP | VERIFIED |
| `1D/02` | CRC | u32 offset, u32 length | u32 CRC-32 | IAP | VERIFIED in pok3rtool. The vendor updater never sends it |
| `1E/01` | SET WRITE ADDRESS | u32 offset | echo | IAP | VERIFIED |
| `1F/n` | WRITE n bytes (n up to 52) | n bytes of encoded image | `1E 02` + u32 next offset | IAP | VERIFIED |

Notes on single commands:

- **READ FW INFO.** The 4 bytes at `0x3C00` come back as `04 00 02 00` on this board. The vendor updater reads the u16 at payload bytes 2..3 (value 2) and uses it to pick a version part (`12 22`). It does not use it as a write address. VERIFIED. tab60kit never compares this value.
- **READ VERSION PAGE.** The board serves parts 0 to 7. The tool reads parts 0 to 2, which is the 180-byte version block. VERIFIED. Part i answers `12 20+i`.
- **ERASE.** In the vendor updater the offset is always 0. A range that starts above 0 has no vendor precedent. VERIFIED. The vendor timeout is `max(500 ms, floor(length / 10240) * 1000 ms)`, which is 11 s for the whole window. A single page needs 500 ms. VERIFIED.
- **SUM.** The 32-bit wrapping sum of the encoded image's LE u32 words. VERIFIED. See [Image encoding](#image-encoding-and-checksums).
- **CRC.** Standard CRC-32 (reflected polynomial `0x04C11DB7`, init and xorout `0xFFFFFFFF`) of the encoded image. VERIFIED in pok3rtool source. Not sent by the vendor updater, so tab60kit treats it as a lower-evidence check.
- **SET WRITE ADDRESS.** The vendor updater always follows a SET with a GET (`1E 00`, payload `FF FF FF FF`, reply u32 = cursor) and accepts only an equal value. VERIFIED. tab60kit does not send GET WRITE ADDRESS. Its timeout in the vendor updater is 1000 ms.
- **WRITE.** `sub` is the payload length. Both pok3rtool and the vendor updater send 52-byte chunks from the image start. VERIFIED. 52 bytes is one period of the XOR key, so keep that chunking. If the bootloader restarts the key at every chunk, other sizes would decode wrong. INFERRED.
- **Other commands.** PING (`10 02`), DISCONNECT USB (`11 02`) and READ ANY ADDRESS (`12 FF`, patched firmware only) exist but tab60kit does not send them. The normal firmware also has a key-configuration command set (`41`, `51`, `52`). It is outside this document.

## BL info block

READ BL INFO returns a struct that sits at absolute `0x400`. The reply carries it from payload offset 0, which is packet byte 4. Python format string: `<IIHHHHIIIIHHH10sI`, 0x34 (52) bytes. VERIFIED.

| Off | Type | Name | What it holds |
|---|---|---|---|
| 0x00 | u32 | a | Not known. 4 on sibling boards |
| 0x04 | u32 | b | Not known. 0 |
| 0x08 | u16 | boot_vid | IAP vendor ID. `0x04D9` |
| 0x0A | u16 | boot_pid | IAP product ID. `0x1304` here |
| 0x0C | u16 | c | Not known. `0x7040` here |
| 0x0E | u16 | d | Not known. `0x0404` here. Differs by chip family |
| 0x10 | u32 | e | Not known. `0xFFFFFFFF` |
| 0x14 | u32 | f | Not known. 1. The vendor updater reads the u16 at 0x14 as its layout ID |
| 0x18 | u32 | g | Not known. `0xFFFFFFFF` |
| 0x1C | u32 | h | Not known |
| 0x20 | u16 | fw_offset | App offset from `0x3000`. `0x200` here |
| 0x22 | u16 | fw_pages | Number of pages from `0x3000` up to the option-byte page. `0xE7` here |
| 0x24 | u16 | page_size | Flash page size. `0x200` here |
| 0x26 | char[10] | model | "KB" plus the app PID in hex on sibling boards |
| 0x30 | u32 | m | Not known. `0xFFFFFFFF` |

- **Values this board reports.** `fw_offset 0x200`, `fw_pages 0xE7`, `page_size 0x200`, and bytes 4..19 equal to `00000000 d9040413 40700404 ffffffff`. VERIFIED, recorded in `fixtures/u1-macos.json` in both modes. Sibling bootloaders (Cypher, which shares the chip family) report the same three layout numbers. VERIFIED.
- **Identity.** The vendor updater compares bytes 4..19 with an identity block in its own package and fails with "HW Setup Error!" on a mismatch. VERIFIED. tab60kit does the same: it refuses a board whose identity or layout numbers differ from the expected ones. It never adapts to them.
- **Erase length.** pok3rtool computes it as `fw_pages * page_size`. The vendor updater computes `fw_pages * fw_offset`. On this board both are `0xE7 * 0x200`. The two names may be swapped in pok3rtool. Because `fw_offset` equals `page_size` here, both give the same frames. The tool refuses a board where they differ.
- **Derived end.** `0x3000 + 0xE7 * 0x200 = 0x1FE00`, the option-byte page. INFERRED.

## Flash map

Absolute addresses on the HT32F52352-class layout. The protocol base for offsets is `0x3000`.

| Region | Absolute range | Label |
|---|---|---|
| IAP bootloader | `0x00000`..`0x02FFF` | INFERRED. Cannot be read or checked over USB |
| BL info block | `0x00400`, 52 bytes used, 60 readable | VERIFIED layout on sibling dumps. The window answers on this board |
| Version page | `0x03000`..`0x031FF` (one 512-byte page) | INFERRED from `fw_offset` = `page_size` = `0x200` |
| App region | `0x03200`..`0x1FDFF` (117,760 bytes at most) | Base VERIFIED by the image's vector table. End INFERRED from `fw_pages` |
| V1.01.13 image | `0x03200`..`0x0B7DB` (34,268 bytes) | VERIFIED file size |
| Option bytes, security bits | `0x1FE00`..`0x1FFFF` | VERIFIED for the HT32F52352. That this board uses that chip is a GUESS |
| FW info word | `0x03C00`, 4 bytes | VERIFIED as a read window. Not compared |
| ROM ISP loader | `0x1F000000`..`0x1F000FFF` | VERIFIED for the HT32F52352 |

- **The window.** tab60kit sends only offsets inside `[0x3000, 0x1FE00)`. The bootloader below it and the option bytes above it are never addressed. The app region is `[0x3200, 0x1FE00)`. Inside the protocol, offsets count from `0x3000`, so the app starts at offset `0x200`.
- **Page size.** 512 bytes (`0x200`). ERASE must be page-aligned.
- **Image base.** The V1.01.13 image is linked at `0x3200`. Its reset vector is `0x32C1`. VERIFIED. pok3rtool's older C++ code hard-codes `0x3400` for TAB boards. Flashing a TAB with it would put the image at the wrong address. INFERRED.
- **Not readable.** The stock protocol cannot read flash. You can read the BL info window, the 4-byte FW info, and the version page. SUM and CRC cover any range at or above `0x3000`. The bootloader and the option bytes cannot be verified over USB. INFERRED from the command list.
- **Lock state.** Whether the chip's flash security is on is not known.

## Version page

The first 180 bytes (`0xB4`) at absolute `0x3000` are the version block. The official updater package stores it as a block of its own. VERIFIED. READ VERSION PAGE parts 0 to 2 return it in 60-byte pieces. All fields are little-endian.

| Off | Type | Field | Label |
|---|---|---|---|
| 0x00 | u32 | Byte length of the version string. `0xFFFFFFFF` means the page is erased | VERIFIED |
| 0x04 | bytes | Version string in UTF-16LE. The rest up to `0x77` is `0xFF` | VERIFIED |
| 0x78 | u32 | `0x00800004` in every known sample. A "programmed" word | VERIFIED value. Meaning not known |
| 0x7C | u32 | Version number. 4 in a TAB 90 package | VERIFIED value. Meaning not known |
| 0x80 | u32 | `0x142` in a TAB 90 package | VERIFIED value. Meaning not known |
| 0x84 | u32 | `0xEFFFFFFF` | VERIFIED |
| 0x88 | u32 | 1 | VERIFIED |
| 0x8C | u32 | 0 | VERIFIED |
| 0x90 | u16, u16 | App VID, app PID (`04D9`, `0346` in the TAB 90 package) | VERIFIED |
| 0xB0 | u32 | Magic. The low half is `0x5AA5` | VERIFIED. The upper bits differ between samples (`0x001C5AA5` written by pok3rtool, `0x00FF5AA5` in a TAB 90 dump), so only the low half is checked |

- **String format.** The official package and pok3rtool's older C++ code write UTF-16LE. pok3rtool 2.0 writes and reads UTF-8, which differs from the official format. VERIFIED. tab60kit decodes UTF-16LE.
- **Write the package's block as is.** Both pok3rtool versions build a block that differs from the official one. Never synthesize it. INFERRED design rule.
- **Vendor patch.** Before the vendor updater writes the block, it sets the u32 at offset 0 to `0x1A` (26) and copies 26 bytes from its package trailer to offset 4. VERIFIED. A catalog block that is already in that final form needs no change.
- **A page is "official"** when its SHA-256 equals one in the tool's catalog of known updater blocks. Erased means all bytes `0xFF`.
- Not known: what the field at `0x7C` and `0x80` mean, and whether the bootloader reads any field other than `0x78` and `0xB0`.

## Boot rule

After a reset the IAP decides whether to start the app or to stay in update mode.

- **Rule (INFERRED).** The IAP boots the app only over a version page that holds the magic (`0x5AA5` at offset `0xB0`) and a programmed word at `0x78` (not `0xFFFFFFFF`). With an erased page, or a page without these, it stays in update mode.
- **Basis.** pok3rtool's source says "the bootloader checks that this list of words is non-FF" and "this magic value needs to be present". Its wiki says the bootloader has "some protection … from jumping blindly into any data". VERIFIED quotes. The rule itself is derived from them. It has not been tested by cutting a flash short.
- **No image check.** The bootloader does not check the app image. A valid version page over a broken image makes the board jump into broken code, and it may hit a hard fault loop. pok3rtool's README warns that this can brick the board. VERIFIED quote.
- **Consequence.** Write the version block last. An interrupted flash then leaves an erased version page, and the board stays in update mode where it can be flashed again. tab60kit's chip report uses this rule to say where the next reset will go: normal mode, update mode, or into an unchecked or damaged image.

## Image encoding and checksums

- **Encoding.** The image on the wire is the plain firmware with each LE u32 word `i` XORed with `key[i % 13]`. VERIFIED in both pok3rtool versions. The bootloader decodes on write. INFERRED, because the decoded images in the public firmware dumps are plain Thumb code. The key is:
  `e7c29474 79084b10 53d54b0d fc1e8f32 48e81a9b 773c808e b7483552 d9cb8c76 2a8c8bc6 0967ada8 d4520f5c d0c3279d eac091c5`
- **SUM and CRC** are computed by the board over the re-encoded flash contents. The host computes the same value over the encoded image. VERIFIED (pok3rtool comment).
- **Range.** Both checks start at the image base (offset `0x200`) and cover the image length. A check that starts at another offset has an unknown key alignment. INFERRED. For the V1.01.13 image, SUM over (`0x200`, 34,268) is `0xF3D3DBD2`. VERIFIED, from the vendor updater's code and the recorded session.

## Sequences

### What tab60kit does

Prove the image, erase, write the image, write the version block last, boot.

1. **Prove the image.** Check the firmware file against the catalog (size and hashes) before any command leaves.
2. **Attach.** Read BL info. Refuse the board if the identity or the layout numbers differ from [BL info block](#bl-info-block). In normal mode, send `11 00` and reconnect as `04D9:1304`.
3. **Erase.** Two ERASE commands: first the version page `[0, 0x200)`, then the app region `[0x200, 0x1CE00)`. Erasing the version page first means that any interruption afterwards leaves the board in update mode (see [Boot rule](#boot-rule)).
4. **Write the image.** `1E 01` with offset `0x200`, then `1F` writes of 52 bytes (`sub` = `0x34`) of the encoded image, the last one shorter. Check each ack's next offset.
5. **Check.** SUM over the image (and CRC where allowed). Compare with the catalog. On a mismatch, go back to step 3. Do not write the version block.
6. **Write the version block last.** `1E 01` with offset 0, then four `1F` writes (52, 52, 52, 24 bytes). Read parts 0 to 2 back and compare.
7. **Boot.** `11 01`, then wait for `04D9:0304`.

### The vendor updater's order

The official V1.01.13 updater, read as bytes. Retry limit is 15 sends everywhere. Timeouts are 500 ms unless noted.

| Step | Frames |
|---|---|
| App mode: read | `12 00`, `12 20`, `12 01`, `12 22` (the part number comes from FW info) |
| Reset | `11 00` (no reply wait) |
| Update mode: read | The same four reads again |
| Erase | One `1D 00`: offset 0, length `fw_pages * fw_offset` = `0x1CE00`, so the version page and the app together |
| Set cursor | `1E 01` with `0x200`, then `1E 00` read-back, retried until equal |
| Write image | `1F` (`sub` = `0x34`) x 659 chunks of 52 (the last shorter). On a wrong or missing ack, set the cursor again to the chunk start and resend |
| Check | One `1D 01` over (`0x200`, image size). On mismatch, erase and write again, at most 3 passes |
| Version block | `1E 01` with 0, `1F` x4, then read parts 0 to 2 back. On mismatch, erase `[0, 0x200)` and write once more |
| Boot | `11 01` (no reply wait) |
| On any failure | `1D 00` over `[0, 0x400)`, which wipes the version page and the first app page, so the board stays in update mode |

The vendor does a 3 ms busy wait after every send, and sleeps of 10, 100 and 200 ms between phases. VERIFIED. tab60kit does not copy this pacing.

### pok3rtool's order

pok3rtool 2.0 (Python): reset to IAP, read BL info, one ERASE of `[0, fw_pages * page_size)`, set the cursor, write the image, SUM and CRC, erase the version page again and write the version block, reset to app. It writes the block last as well. VERIFIED. The older C++ order erases the version block first and then the image range, and uses address `0x3400` for TAB boards (wrong for this one).

### Differences

| Topic | tab60kit | Vendor updater | pok3rtool 2.0 |
|---|---|---|---|
| Erase | Two commands: `[0, 0x200)`, then `[0x200, 0x1CE00)` | One command `[0, 0x1CE00)`. Page 0 alone is erased only in recovery | One command `[0, fw_pages * page_size)` |
| Erase offsets | One above 0. This has no vendor precedent | Always 0 | Always 0 |
| Write cursor read-back | Not sent (`1E 00` is not in the command list) | Every SET is followed by a GET, retried | Confirms with `1E 00` |
| Checks | SUM, and CRC where allowed | SUM only | SUM and CRC |
| Version block | Written last, from the catalog | Written last. Re-erase and rewrite once on a bad read-back | Written last, but synthesized, in UTF-8 |
| On failure | Leaves the version page erased | Erases `[0, 0x400)` | Not known |
| Mode check | Product ID, and READ MODE | Product ID only | READ MODE |

- The vendor erases the whole window in one command. tab60kit uses two, so that the version page is gone before any app page changes. A single erase would depend on the bootloader erasing pages in ascending order, which nothing documents. This is a design choice, not vendor behavior. The second erase starts above offset 0, which the vendor never does.
- The vendor's failure erase destroys the first app page. tab60kit does not copy that.
- The vendor updater has one quirk in its version-block rewrite path: it does not reset the write cursor to 0 before rewriting. INFERRED from the code. tab60kit does not copy it.

## Sources

- **pok3rtool**, the open tool for these boards: https://github.com/pok3r-custom/pok3rtool . Read: the Python 2.0 code (`cykb.py`, `device.py`, `package.py`) and the older C++ code (`proto_cykb.cpp`, `kbscan.cpp`). The sources were read, not run.
- **pok3r_re_firmware**, the reverse-engineering notes, decoded firmware images and sibling bootloader dumps: https://github.com/pok3r-custom/pok3r_re_firmware . It includes a decoded V1.01.13 TAB 60 image and a Holtek user manual for the HT32F52342/52352.
- **The official V1.01.13 updater**, read as bytes, never run or redistributed. Addresses such as "updater 0x40xxxx" are virtual addresses in that executable (image base `0x400000`).
- **Recorded sessions** in `fixtures/` of this repo: `u1-macos.json` (units U1, read-only checks in both modes: mode, BL info, device descriptors), `u10-macos.json` and `u11-macos.json` (app-mode key configuration reads and writes), and `u12-macos.json`. These are the board-side evidence for the VERIFIED labels that say "on the board".
- Not covered by any source: a recorded TAB 60 flash by an open tool, a TAB 60 bootloader dump, the chip marking, and the flash lock state.

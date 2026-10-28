# Units

The work is split into units, U0 to U15. Each unit ends in a check that can fail. A unit starts only when the units it depends on pass. File names in the repo use these names (`lab/u10.ts`, `fixtures/u11-macos.json`, `tools/u12-verdict.ts`).

A hardware unit has a lab page. The page runs under a lab clearance that names exactly the commands the session needs (gate G1, see [design.md](design.md)). It records a transcript. A verdict tool in `tools/` checks the transcript and, on a full pass, writes the capture to `fixtures/`. A commit then moves the unit's commands to "confirmed", citing that capture.

No hardware unit runs before a wired USB stability test passes, and no unit that writes flash runs on a link that fails the link gate.

## Status

| Unit | What | Board | Status | Capture |
|---|---|---|---|---|
| U0 | Scaffold: layout, strict TypeScript, CI, package entries, CSP | no | Done | |
| U1 | Bootloader round trip and read-only deep check | yes | Confirmed 2026-10-12, macOS | `fixtures/u1-macos.json` |
| U2 | Static audit of the commands the vendor updater sends | no | Done 2026-10-24 | |
| U3 | Extractor port with parity against `tools/oracle/decode_updater.py` | no | Done | local only (`bun run real-exe`) |
| U4 | Property tests over the flash window and the egress audit | no | Done | |
| U5 | Fake board, convergence loop, link gate, drop sweep | no | Done | |
| U6 | Connect and Deep check in the shipped page | yes | Confirmed 2026-10-18, macOS | `testing/fixtures/tab60kit-u6-*.json` |
| U7 | First write: V1.01.13 over itself | yes | Confirmed 2026-10-28, macOS | `fixtures/u7-macos.json` |
| U8 | Drop drill: unplug during a write, then resume | yes | Not started. Runs only if the maintainer chooses to risk it | |
| U9 | Keymap model and the 61-key table | no | Done | local only (`bun run real-image`) |
| U10 | Read the key override store | yes | Confirmed 2026-10-19, macOS | `fixtures/u10-macos.json` |
| U11 | Config gate and one key write in RAM | yes | Confirmed 2026-10-24, macOS | `fixtures/u11-macos.json` |
| U12 | Keymap editor | yes | Confirmed 2026-10-24, macOS | `fixtures/u12-macos.json` |
| U13 | Linux | yes | Not started | |
| U14 | Windows | yes | Not started | |
| U15 | node-hid shell and uhid CI (after version 1) | yes | Only if a trigger fires | |

## What each unit checks

**U0.** CI is green. A test in `web/` that imports a core file outside the two package entries fails to resolve. `probes/run.sh` reports 0 failures. The built `index.html` carries `connect-src 'none'` and `script-src 'self'`.

**U1.** Nine checks on the real board, recorded by `lab/u1.ts` and judged by `tools/u1-verdict.ts`:

1. After the reset, the chooser lists "USB-HID IAP".
2. The device is 04D9:1304 with one collection on usage page 0xFF00, usage 1, and 64-byte reports.
3. READ MODE returns 0 in update mode and 1 in normal mode.
4. BL info reports fw_offset 0x200, page_size 0x200, fw_pages 0xE7, and the expected identity bytes.
5. FW INFO returns the same 4 bytes on every read. They are recorded and never compared.
6. The version page hashes to the catalog's V1.01.13 block.
7. SUM over the image returns 0xF3D3DBD2.
8. After RESET to app, the board enumerates as 0x0304 and types.
9. In each mode, READ MODE answers 30 times in a row at 500 ms spacing.

**U2.** Every command row with `vendor-updater` evidence cites a call site in the updater. Differences from pok3rtool's flash sequence are listed for review ([protocol.md](protocol.md) "Sequences").

**U3.** On the real exe: the TypeScript extractor's output equals the Python oracle's byte for byte, the catalog hashes and checksums match, the twelve mutated exes are refused with the right reasons, and `admit` admits V1.01.13 and refuses it with one byte flipped. CI runs the same assertions on a synthetic package.

**U4.** 10,000 random BL info payloads and 100,000 random frames go through `connect` and the egress audit. Every frame the audit passes stays inside the window. A mutation that lets one page past the end must fail the test.

**U5.** The drop sweep loses the link at every packet, from six starting states, with `rewrite` off and on, with and without an MCU reset. Every run must finish official with no board violation. Mutations of the flash policy must fail the sweep.

**U6.** Two deep checks from the shipped page give transcripts identical apart from timing, with U1's command sequence.

**U7.** The link gate holds for 15 s before the first ERASE. The board gets two ERASE commands (version page, then app region) and 663 writes whose payload hashes match the image and the version block. A deep check afterwards passes. A keylog trial over Bluetooth on batteries passes. Every set write address is read back with get write address. Then `erase`, `setWriteAddress`, `write`, and `getWriteAddress` move to "confirmed". Passed on 2026-10-28: both ERASEs answered with no fallback, all 663 chunks matched with none resent, and 0 of 162 characters missed over Bluetooth.

**U8.** Unplug the cable during the image write. The board comes back in update mode with an erased version page, one Reconnect resumes the job, and a deep check passes. If nothing enumerates, recovery moves to the vendor updater on a Windows PC, and then to SWD.

**U9.** Every key's default usage equals its byte in the ROM keymap at flash 0xB205 of the user's own image. Applying `planKeymap`'s writes to random documents gives back the document. `parseKeymapDoc` rejects unknown keys, layers, and usages.

**U10.** After a battery pull, the reads of all three layers match `predictLayers` for the board's OS key mode, except differences listed in `fixtures/u10-expected-diffs.json`. One difference is approved: Esc on layer 2 reads default although the factory table writes 0x70 there. See [app-firmware.md](app-firmware.md) "Override store".

**U11.** Open the gate, write Caps Lock as Left Control on layer 0, read it back, and confirm it types Left Control over USB and over Bluetooth. Restore it, close the gate, and confirm the query shows 0. Write again, power cycle with no save, and confirm Caps Lock is back.

**U12.** Apply a document of several keys from the editor and confirm each key with the keylog harness. Reload the page and the document comes back from storage. After a power cycle, one Apply restores it.

**U13.** Without the udev rule, Connect shows the permission screen with the exact rule text ([webhid.md](webhid.md) "Linux udev rule"). With the rule, the deep check passes with the same command sequence as on macOS.

**U14.** On Windows with Chrome or Edge, Connect lists "USB-HID Keyboard" with no driver install, the chooser lists "USB-HID IAP" after the reset, and the deep check passes. The vendor updater stays closed during the unit.

**U15.** A node-hid shell over the same core, with a CI job that exposes the fake board as a Linux uhid device. Built only if WebHID cannot reach the bootloader, if USB drops make mid-flash picks routine, or if someone needs scripted flashing.

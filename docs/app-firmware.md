# Stock app firmware V1.01.13: what tab60kit relies on

This document describes the app firmware that ships on the Vortex TAB 60 (USB 04D9:0304), version V1.01.13. It covers the vendor HID commands, the keymap, and the settings store. The code cites it where a comment names an address or a `sub_XXXX` routine.

## How this was learned

The official updater and the V1.01.13 firmware it carries were read as bytes. They were never run, and no Vortex bytes are in this repository or redistributed. They were read only to learn the commands and data formats needed to talk to the keyboard. Every address in this document and in the code cites V1.01.13 (Thumb, linked at 0x3200), so anyone with the same file can check it.

Each claim carries one label.

| Label | Meaning |
|---|---|
| VERIFIED | Seen in the bytes or in the disassembly at the cited address. |
| INFERRED | Follows from verified facts, but the code path was not traced to the end or not tried on a board. |
| GUESS | A hypothesis with weak or no direct evidence. |

Addresses below 0x20000000 are flash (ROM). Addresses from 0x20000000 are SRAM. Names like `sub_5E98` are routines at that flash address. Board captures of the commands in this document are in `fixtures/u10-macos.json`, `fixtures/u11-macos.json`, and `fixtures/u12-macos.json`. A claim marked VERIFIED here is a static claim unless the text says a board confirmed it.

## Command map

### Transport and frame

The firmware serves three USB interfaces. Interface 1 is the vendor interface on usage page 0xFF00. It carries 64-byte reports with no report ID. VERIFIED.

A report arrives on the OUT endpoint (EP4). The main loop copies it into **one** 64-byte buffer at SRAM 0x20000514. The dispatcher sub_75D8 reads it, writes the reply into the same buffer, and sends it on the IN endpoint (EP3). VERIFIED. So the keyboard handles one command at a time. A host must not send a second command before the first reply arrives. Two writers on the same device will corrupt each other's frames.

Frame bytes: 0 = cmd, 1 = sub, 2..3 = u16 LE argument `arg` (read at 0x7BA6), 4..63 = payload. VERIFIED. The updater-style commands (cmd below 0x40) treat bytes 2..3 as an echoed checksum field. The config commands (cmd 0x40 and above) read them as `arg`. A host that always writes zero there reads `arg = 0` on every config frame.

**Replies.** A successful handler writes its payload at byte 4 and zero-fills the rest (sub_7720, 0x7720 to 0x774A). It does not touch bytes 0..3, so the reply echoes `cmd sub arg_lo arg_hi`. VERIFIED.

**Error marker.** A handler that returns 0 gets this reply. Bytes 0..3 are `FF AA 00 00`. Bytes 4..7 are request bytes 0..3. The rest is zero. VERIFIED (0x7684 to 0x76A8, literal 0xAAFF at 0x76B4). When bit 6 of the gate byte 0x200006FA is set, the firmware sends no reply at all. VERIFIED (0x7662 to 0x7670). Never set bit 6.

**No internal-flash writes.** The image contains no code that erases or programs the MCU's own flash. The flash controller is touched once, at the cache register in the clock setup sub_36F4. VERIFIED. The app does save settings, but to an external SPI flash chip (see [Override store](#override-store)). Only the bootloader, which is not part of this image, can program internal flash.

### Commands below 0x40

All are read-only except the reset. VERIFIED.

| cmd/sub | Handler | Effect | Used by tool |
|---|---|---|---|
| 0x10/0x02 | 0x760E | Ping. Replies a zero u32. Ignores the request payload. | no |
| 0x11/0x00 | sub_76B8(0) | Reset into the bootloader (magic word in SRAM 0x20003FFC, then a system reset). | yes (app mode) |
| 0x11/0x01 | sub_76B8(1) | Reset into the app. | yes (in the bootloader only) |
| 0x11/0x02 | sub_76B8(2) | USB disconnect, no reset. | no |
| 0x12/0x00 | 0x7650 | READ BL INFO: 52 bytes (0x34) from flash 0x400, then **8 zero bytes appended** to fill 60. | yes |
| 0x12/0x01 | 0x7672 | READ FW INFO: 4 bytes from flash 0x3C00. | yes (bootloader only) |
| 0x12/0x02 | 0x767A | READ MODE: one byte, 1 = app. | yes |
| 0x12/0x20+i | 0x7620 | READ VERSION PAGE part i, i = 0..7: 60 bytes from flash `0x3000 + 60*i`. | yes (parts 0..2) |
| other | 0x769A | Error marker, or silence. | no |

The flash-write family (erase, set address, write, checksum) and the arbitrary read 0x12/0xFF are not in the app. VERIFIED.

### Commands from 0x40

Dispatcher sub_7B90. Every case works on SRAM or on the SPI flash. The "tool" column is what tab60kit sends today.

| cmd | Handler | What it does | Gate | Tool |
|---|---|---|---|---|
| 0x40 | 0x7BDC | Info reads (see below). | no | no |
| 0x41 | 0x7CAE | Gate and config mode. See [Gate](#gate). | no | yes |
| 0x42, 0x43, 0x44 | 0x7D0A, 0x7D6A, 0x7D8A | Profile or layer enable, a config flag bit, and the macro buffer (800 bytes at 0x200010F4). Not traced further. | no | no |
| 0x50 | 0x7DE2 | Profile control: reload (sub 0x00), reset (0x10), save (0x55), self-test (0x20). | **yes** | no |
| 0x51 | 0x7EB2 | Writes. See table below. | **yes** | 0x20 only |
| 0x52 | 0x7FEC | Reads. See table below. | no | 0x20, 0x21 |
| 0x53 | 0x7E36 | LED zone writes. | yes | no |
| 0x55 | 0x7EAC | Raw protocol, only when the gate byte is exactly 0x04. | n/a | never |
| 0xC0 | 0x8132 | Macro and key injection. | no | no |

**"Gate" means** `[0x200006FA] & 0x81` must be non-zero, or the command gets the error marker. cmd 0x50, 0x51, and 0x53 test it (0x7DE2, 0x7EB2, 0x7E36). cmd 0x52 does not. VERIFIED.

### cmd 0x52: reads (no gate)

Entry 0x7FEC. All rows VERIFIED at the cited address. Reply payload starts at byte 4.

| sub | `arg` | Reply | Tool |
|---|---|---|---|
| 0x00 | ignored | 1 byte: current profile, SRAM 0x20001032 | no |
| 0x01 | zone < 5 | 32 bytes of LED zone data | no |
| 0x10 | ignored | 16 status bytes. Side effect: clears byte 0x20000745. | no |
| 0x18 | idx < 20 | 2 bytes from slot table `0x20000754 + 2*arg` | no |
| **0x20** | key index <= 0x2FF | u16 LE override entry | yes |
| **0x21** | 0..0x3F, only `arg & 0xF` used | 16 u16 LE override entries, layer 0 | yes |
| 0x28, 0x29, 0x30, 0xA8 | various | LED and RGB state (12 bytes, 18 bytes from ROM 0xB6F4, the selected RGB layer, 48-byte RGB chunks) | no |
| other | | error marker | |

No 0x52 sub copies the 80-byte active keymap into a reply. VERIFIED. The keymap at SRAM 0x20000590 cannot be read over USB. A host must rebuild it (see [Keymap at boot](#keymap-at-boot)).

### cmd 0x51: writes (gated)

When a write sub succeeds, it branches to 0x7FE4 and falls into the cmd 0x52 handler with the same sub. So the reply is a read-back, with byte 0 still 0x51. If gate bit 6 is set, there is no reply. VERIFIED.

| sub | Guard | Writes | Saves flash? | Tool |
|---|---|---|---|---|
| 0x00 | b4 < 5 | Requests a **profile switch** (SRAM 0x2000000F). See [Profile switch](#profile-switch-0x510x00). | later, yes | no |
| 0x01 | zone < 5 | 32 bytes of LED zone data | **yes, at once, every call** | no |
| 0x10 | none | Win lock bit (0x2000077F bit 0) and bytes 0x2000077C..E | no | no |
| 0x18 | idx < 20 | slot table entry | no | no |
| **0x20** | store bounds | one key override | **no** | yes |
| 0x21 | `arg` <= 0x3F | 16 layer-0 key overrides | no | no |
| 0x28, 0x2B, 0x2C | various | LED mode and LED records (not fully traced) | no | no |
| 0x30, 0xA8 | b4 < 4, `arg` < 14 | RGB layer select, and 48 bytes into an **RGB** layer record, not a key | no | no |

There is no 0x51 sub 0x11: that frame gets the error marker. VERIFIED. The key writes are 0x51/0x20 and 0x51/0x21. Subs 0x30 and 0xA8 are RGB, not keys.

### Other commands that save or reset

These are not used by the tool. They are listed because a stray frame can do real damage. VERIFIED unless noted.

| Frame | Effect |
|---|---|
| 0x50/0x00 | Reload the current profile from flash. Drops unsaved RAM edits. |
| 0x50/0x10, b4 = 0 | Reset the current profile in RAM only (store to 0xFF, factory layer 2, OS key mode 0x10). Becomes permanent on the next save. |
| 0x50/0x10, b4 != 0 | **Factory reset of all 5 profiles and the global block, written to flash.** |
| 0x50/0x20, b4 != 0 | Writes the global block twice as a self-test. |
| 0x50/0x55 | Saves the current profile to flash. |
| 0x55 with gate byte 0x04 | Raw protocol: RAM writes, flash reads at host-chosen offsets, global block reload and save. Never send gate value 0x04. |

## Keymap at boot

The firmware copies an 80-byte ROM keymap from flash 0xB205 to SRAM 0x20000590 at boot (sub_5314). VERIFIED. Each byte is the HID usage of one **matrix cell**. Cells are numbered 0..79 in matrix order, not in keyboard-row order. Then sub_91EC builds a 256-byte reverse map at SRAM 0x200005E0: `reverse[usage] = cell`. When two cells hold the same usage, the lowest cell wins. VERIFIED.

Boot runs sub_5314 (ROM copy), then loads the saved profile, then sub_5330(0), which is US QWERTY. Mode 1 applies a 34-pair Dvorak remap from ROM 0xB255. Mode 2 applies a 17-pair remap from 0xB299. The layout mode byte is SRAM 0x2000102A. VERIFIED.

Cells that matter to the tool:

| Cell | ROM usage | Role |
|---|---|---|
| 60 | 0xE7 (R GUI) | **Fn** position. Overwritten by the marker 0xD8 at boot. |
| 54 | 0x65 (App) | **Pn** position. Overwritten by the marker 0xD9 at boot. |
| 72 | 0x2C | Space (first switch position) |
| 79 | 0xC9 | Space (second switch position) |
| 57 | 0x35 | Grave (not a cap on the ANSI board) |
| 53, 71 | 0x32, 0x64 | ISO keys (not caps on the ANSI board) |

**Fn and Pn markers.** After the OS-key-mode swaps, sub_5F4C writes the marker 0xD8 into the Fn cell and 0xD9 into the Pn cell. The cell numbers come from two bytes at SRAM 0x20000E50 and 0x20000E51. Their defaults are `3C 36` (cells 60 and 54), copied from ROM 0xAA14. VERIFIED. So on the wire the Fn key has active usage 0xD8, and Pn has 0xD9. The ROM usages 0xE7 and 0x65 are then no longer present in the active keymap. INFERRED.

Holding a key whose active usage is 0xD8 selects layer 1. Holding 0xD9 selects layer 2. VERIFIED (0x50B8 to 0x50D6). The user can move Fn and Pn with Fn + L_Shift or Pn + L_Shift (see [Key combinations](#key-combinations-that-save-to-flash)), so cells 60 and 54 are defaults, not fixed.

**Space.** Both cells 72 and 79 type Space. The scan path replaces usage 0xC9 with 0x2C after the store lookup (0x5AB2 to 0x5ABA). VERIFIED. 0xC9 is a placeholder that lets the store address the second position on its own. Which position carries the real space bar on a TAB 60 is not decidable from the image. A tool that remaps Space should write both usages 0x2C and 0xC9. INFERRED.

**The active keymap is not a fixed table.** It depends on three bytes: the layout mode (0x2000102A), the OS key mode (0x2000102B), and the two marker cell bytes. A host that wants the active keymap must compute it:

1. Start from the 80 ROM bytes.
2. Apply the layout remap (mode 0 needs none).
3. Apply the OS key mode swaps ([OS key mode](#os-key-mode)). sub_5368 looks each pair up in the reverse map built before the loop, so the pairs swap cleanly.
4. Write the Fn and Pn markers into their cells.

`core/keymap.ts` does this.

## OS key mode

The OS key mode is SRAM **0x2000102B**. It is the last byte of the saved profile block (see [Override store](#override-store)). VERIFIED. Do not confuse it with the byte at 0x2000000F, which is a pending profile switch ([Profile switch](#profile-switch-0x510x00)).

| Value | Name | Swaps applied to the active keymap |
|---|---|---|
| 0x10 | Windows | none |
| 0x20 | Mac | ROM 0xAA25: `e2 e3 e3 e2 e6 e7 e7 e6`. Left Alt and Left GUI swap. Right Alt and Right GUI swap. |
| 0x40 | Caps/Ctrl | ROM 0xAA21: `39 e0 e0 39`. Caps Lock and Left Ctrl swap. |

The swaps come from sub_5F4C (0x5F4E to 0x5F9A), which reads the mode byte, calls sub_5368 with the pair list, and then writes the Fn and Pn markers. VERIFIED. The name "Mac" for 0x20 is INFERRED from the Alt/GUI swap.

**How the mode is set.** No HID frame writes 0x2000102B directly. VERIFIED. Three things set it:

- The function codes 0x13D (0x10), 0x13E (0x20), and 0x13F (0x40). The factory layer-2 table puts them on usages 0x14 (Q), 0x1A (W), and 0x08 (E). They sit on layer 2, the layer held with the marker 0xD9, so they are Pn+Q, Pn+W, and Pn+E. The maintainer confirmed the Pn combinations on the board on 2026-10-29. Pressing one sets the byte and **saves the profile** (sub_5674 at 0x58DE, save at 0x5898).
- A store reset (sub_4540) sets it to 0x10.
- A profile switch loads the byte stored in the other profile.

Because the store is addressed by usage and the swap moves usages between cells, a write made in one mode lands on a different physical key in another mode. For example, usage 0x39 sits on the Caps Lock cell in modes 0x10 and 0x20, but on the Left Ctrl cell in mode 0x40. INFERRED from verified steps.

## Override store

The app keeps per-key overrides in a table in SRAM. Reads and writes go through one accessor, `sub_5E98(idx, val)` (0x5E98 to 0x5F32). VERIFIED.

| Item | Value | Evidence |
|---|---|---|
| Index `idx` | `layer << 8 \| usage index`, bounded at 0x2FF, so layers 0, 1, 2 | 0x5EA2 |
| Usage index `k` | A usage that is in the **active** keymap, not a cell number. The accessor maps it through the reverse map. | 0x5EB6 to 0x5EBA |
| Usage not in the active keymap | `reverse[k] = 0xFF`, so the accessor returns 0x01FF | 0x5EBC, 0x5F08 |
| Value `val` | 0x0003 means "read". Any other value up to 0x3FF is a write. | 0x5EDA, 0x5EAC |
| Byte store | `0x20000D24 + layer*80 + cell` (3 x 80 bytes) | 0x5EC0 to 0x5ED6 |
| Flag bits | 2 bits per cell at `0x20000E14 + layer*20 + cell/4`, shift `(cell & 3) * 2` | 0x5F18 to 0x5F20 |
| Read result | `flags << 8 \| byte`. A byte of 0xFF returns 0x00FF and ignores the flags. | 0x5F0E to 0x5F2C |
| Write of byte 0xFF | Stores 0xFF and leaves the flags alone. | 0x5EE4 |

The store is addressed by cell inside, but by usage on the wire. Two OS key modes can therefore map the same usage to different cells.

**Value format.** A value is `flags << 8 | code`.

| Flags | Meaning |
|---|---|
| 0 | A plain HID usage `code`. Usages 0xE0..0xE7 go to the modifier path. This is the only safe choice for an ordinary remap. |
| 1 | A **function code** `0x100 + code`, run by sub_5674: profile switch, OS key mode, layout, Win lock, LED effects, link and Bluetooth slots, recording. Many of them save flash when pressed. |
| 2, 3 | Routed to sub_5674, which has no case for them. The key does nothing. INFERRED. |

VERIFIED for the dispatch (0x4EAE to 0x4F40, 0x5674). The value 0x01E0 is not "Left Ctrl with flags 1". It is function code 0x1E0, which does nothing. Use `0x00E0`.

**Special values.** 0x0003 and 0x00FF are explained in [Reading the store](#reading-the-store). The default restore is the frame `51 20 UU LL FF 00` (VERIFIED, 0x5EE4).

**Fn and Pn cannot be written (0x51BC).** The store lookup skips marker usages 0xD8..0xDF (0x51BC to 0x51C4), and layer selection uses the keymap usage before the lookup (0x50AE). So an override on the Fn or Pn key is stored but never takes effect, and it cannot lock a typist out of the layers. VERIFIED. The tool refuses to write to these keys.

**Reset values.** sub_44A4 resets the store: `memset(0x20000D24, 0xFF, 0x12C)`, which is 3 x 80 bytes plus 3 x 20 flag bytes. It then calls sub_4540, which:

- clears Win lock (0x2000077F = 0),
- sets the OS key mode 0x2000102B to 0x10 and the layout 0x2000102A to 0,
- rebuilds the keymap with sub_5330(0),
- writes the **31 factory layer-2 pairs** from ROM 0xB2D6 with `sub_5E98(0x200 | usage, 0x100 | code)`, so layer 2, flags 1,
- copies the Fn and Pn cell bytes `3C 36` from ROM 0xAA14 to 0x20000E50/51.

All VERIFIED (0x44A4 to 0x44DC, 0x4540 to 0x4596). The 31 pairs are (usage, code): 29 70, 1e a0, 1f a1, 20 a2, 21 82, 22 83, 26 ac, 27 ad, 2d a8, 2e a9, e2 30, 2b 35, 31 36, 0d 31, 0e 32, 0f 33, 33 34, 11 10, 10 11, 36 12, 37 13, e0 5f, e5 68, e3 60, 14 3d, 1a 3e, 08 3f, 04 92, 16 93, 1d 90, 1b 91. So a reset store is **not** all 0xFF: layer 2 holds these function codes. They are written by cell under the Windows keymap (mode 0x10), so in another OS key mode a read by active usage lands on the swapped cell. VERIFIED, and it matched a board read.

**The Esc pair.** Sometimes layer 2 usage 0x29 (Esc) reads 0x00FF instead of 0x170. The cause is an ordering fault in sub_4540. On a board whose flash holds no valid profile, both marker cells are 0 (bss) when the keymap is rebuilt. Cell 0 (Esc) then holds a marker, so `reverse[0x29]` is 0xFF and the first pair writes nothing. The `3C 36` copy comes only afterwards (0x4588). INFERRED from verified steps, and it matches a board read (30 of 31 factory entries present).

**Where it is saved.** The app saves to an external SPI NOR flash with 25-series opcodes: READ 0x03, PAGE PROGRAM 0x02, WREN 0x06, SECTOR ERASE 0x20, RDSR 0x05. VERIFIED (0x8774 to 0x88A4). The chip itself was not traced. A fitted chip is INFERRED, and board reads of the factory layer 2 table fit it.

| Flash address | Size | SRAM | Header check | Saved by |
|---|---|---|---|---|
| 0x000000 | 0xC8 | 0x2000102C (global: profile index, LED zones) | 0x8001 | sub_4684 |
| `(p+1) * 0x1000`, p = 0..4 | 0x8DC | 0x20000750 (profile: RGB layers, key store, Fn/Pn cells, mode bytes up to 0x2000102B) | 0x0009 under mask 0xF0FF | sub_4668(p) |

Each save recomputes a checksum and runs erase then program (sub_8FF8, sub_8F24). VERIFIED. Boot loads the global block, then the current profile block (0xA50C to 0xA524). If a block is invalid, boot writes defaults and saves them. VERIFIED.

The profile block covers 0x20000750..0x2000102B. The override store (0x20000D24..0x20000E4F), the Fn and Pn cell bytes, Win lock, the layout byte, and the OS key mode all lie inside it. So a save of the profile saves all of them together. See [Key combinations that save to flash](#key-combinations-that-save-to-flash).

## Reading the store

Read with cmd 0x52. It needs no gate. Neither sub writes SRAM outside the reply buffer. VERIFIED.

**Bulk read of layer 0: 0x52/0x21.** Sixteen frames, `arg = a` for a = 0..15.

```
request  52 21 aa 00 | 60 x 00
reply    52 21 aa 00 | w0 .. w15 (16 x u16 LE) | 28 x 00
         w_i = entry for active usage 16*a + i
```

The firmware uses only `arg & 0xF` (0x80A4 `lsls #0x1C; lsrs #0x18`). So `arg` 16 and up aliases and never reaches layers 1 or 2. VERIFIED.

**Single read of any layer: 0x52/0x20.**

```
request  52 20 kk LL | 60 x 00         kk = active usage, LL = layer 0..2
reply    52 20 kk LL ww WW | 58 x 00   u16 LE = WW ww
```

**Decode rules** for each u16 `w`:

| `w` | Meaning |
|---|---|
| 0x0003 | No key has this usage in the active keymap. |
| 0x00FF | The key exists and has no override. |
| other | Override: `flags << 8 \| code`. |

The effective layer 0 for a cell `c` with active usage `k = active[c]` is: low byte of `w` if `w != 0x00FF`, otherwise `k`. The host must know `active` (see [Keymap at boot](#keymap-at-boot)). The board cannot report it.

On a store reset and in QWERTY, the usages present in the active keymap are 0x00, 0x04 to 0x39, 0x64, 0xC9, 0xD8, 0xD9, and 0xE0 to 0xE6. The usages 0x65 and 0xE7 read 0x0003 because the markers replace them. INFERRED from the model.

A store-level read cannot tell the Windows keymap from Dvorak, because Dvorak is a permutation of the same usages. A read cannot tell the Windows mode from the Caps/Ctrl mode either. Both have the same set of present usages. INFERRED.

## Gate

cmd 0x41 sets the gate that cmd 0x50, 0x51, and 0x53 test. It has no gate itself.

| Item | Value |
|---|---|
| Gate byte | SRAM 0x200006FA. The only store to it is cmd 0x41 at 0x7CBE. VERIFIED. |
| Timer | u16 at SRAM 0x200006F8 |
| At boot | 0. The scatter table zero-fills the region. **The gate is closed at boot.** VERIFIED. No key combination opens it. |
| Test | `[0x200006FA] & 0x81 != 0` |

Request `41 ss tt TT`. Reply `41 ss tt TT` with a zero payload.

| Request | Effect |
|---|---|
| `ss = 0xFF` | **Query only.** Reply byte 1 is the gate byte. Bytes 2..3 are the timer. Nothing changes. |
| `ss` equal to the current gate | Reloads the timer only. |
| `ss` with bit 0 set | Enters **config mode** (sub_721C). |
| `ss` with bit 0 clear, old bit 0 set | Leaves config mode: **reloads the current profile from flash** (sub_4470) and rebuilds the keymap. Unsaved RAM edits are lost. |
| `ss` with bit 1 set | Host LED control. Also suppresses LED refresh. INFERRED. |
| `ss` with bit 1 clear | Sets 0x2000050C = 1. Looks harmless (GUESS: an LED refresh flag). |
| `ss` with bit 6 set | The firmware sends no reply. Never set. |

Gate bits: 0x01 config mode, 0x02 host LED control (INFERRED), 0x40 silent mode, 0x80 passes the test without config mode. VERIFIED unless noted. The exact value 0x04 opens the raw cmd 0x55 protocol. Never send it.

**Timer.** The main loop calls sub_847C. If the timer is not 0, it counts down, and at 0 it builds `41 00 00 00` itself and runs the handler, so the gate closes (and, if bit 0 was set, the flash reload runs). A timer of 0 never expires. VERIFIED (0x847C to 0x84A0). The tick period is a GUESS.

**What the tool sends.**

| Row | Frame | Why |
|---|---|---|
| `gateQuery` | `41 FF 00 00` | Read the state. |
| `gateOpen` | `41 80 00 00` | Bit 7 alone. Old bit 0 and new bit 0 are clear, so neither config mode nor the flash reload runs. |
| `gateClose` | `41 00 00 00` | After `gateOpen`, old bit 0 was clear, so no reload runs and the RAM overrides stay. |

If the gate was opened with `41 01 ..` (config mode, probably what the vendor tool does, GUESS), the close reloads the profile and undoes every unsaved key write. That is a free undo for tests, and a trap if the aim is a change that lasts.

## Key write

The tool writes one entry with cmd 0x51/0x20.

```
request  51 20 UU LL vv VV | 58 x 00     UU = active usage, LL = layer 0..2
                                          value = VV vv (u16 LE) = flags << 8 | code
reply    51 20 UU LL vv VV | 58 x 00     read-back of the same entry
refused  FF AA 00 00 51 20 UU LL | 56 x 00
```

VERIFIED (0x7F34 to 0x7F4A, reply through 0x7FE4).

- **RAM only.** The write is never saved by itself. No 0x51/0x20 or 0x51/0x21 path calls the save routines. A power cycle restores the last saved profile. VERIFIED for the bodies. See [Key combinations that save to flash](#key-combinations-that-save-to-flash) for what saves it by accident.
- **Reply is the read-back, or the error marker.** The marker comes back when the gate is closed, when the usage is not in the active keymap (accessor returns 0x01FF), or when a bound fails (index above 0x2FF, value above 0x3FF, value 0x0003).
- **Fn and Pn cannot be written.** See [Override store](#override-store). Usages 0xD8..0xDF have no effect (0x51BC).
- **Use flags 0.** `00 E0` is Left Ctrl. Flags 1 are function codes. Flags 2 and 3 are dead keys.
- **Undo.** Restore one entry with `51 20 UU LL FF 00`. Or reload the saved profile with `50 00 00 00` (gate open), or leave config mode, or power-cycle.
- **Bulk write.** 0x51/0x21 writes 16 entries on layer 0 per frame. The tool does not use it.

Board captures of this sequence (gate query, open, write, read-back, restore, close) are in `fixtures/u11-macos.json`. "RAM only" is VERIFIED in the code. A battery-pull test with a pending override is INFERRED, not captured.

## Profile switch (0x51/0x00)

cmd 0x51/0x00 does **not** set an OS key mode. It requests a profile switch.

```
request  51 00 00 00 bb | 59 x 00      bb = profile 0..4 (bb < 5)
reply    51 00 00 00 pp | ..           pp = the OLD current profile (0x52/0x00 read-back)
```

- The handler stores `bb` at SRAM 0x2000000F. The boot value of that byte is 0xFF (none). VERIFIED (0x7EF2 to 0x7EFA, ROM 0xB777).
- The switch is **deferred.** The main loop (0xA686 to 0xA6B4) runs it when `[0x2000000F] != 0xFF` and sub_5390() returns 1. sub_5390 returns 1 when no key from a ROM list is held (INFERRED: all keys released). So while any such key is down, the request waits. The reply shows the old profile because the switch has not run yet. A later `52 00 00 00` returns the new index.
- The same byte is written by function codes 0x110..0x113 (profiles 0..3). The host can reach profile 4. The keys cannot. VERIFIED.
- **It reloads from flash.** The switch calls sub_4470(bb), which reads the profile block from flash into SRAM. That **drops every unsaved RAM edit**, including 0x51/0x20 writes. Re-selecting the current profile writes nothing but still reloads and drops edits. VERIFIED.
- **When it writes flash** (VERIFIED, sub_8FA4 at 0x8FC0 to 0x8FC6 and sub_4470 at 0x448C to 0x4496):

| Case | Flash writes |
|---|---|
| bb equals the stored profile index, block valid | none |
| bb differs, target block valid | one sector (global block, new index) |
| Target block invalid (never used or corrupt) | two sectors (global block, then defaults saved into that profile) |

The tool's registry still names this row `cfgSetOsMode`. The name is wrong. The row is a profile request, and the tool should not call it until its effects are reviewed.

## Key combinations that save to flash

The firmware has an on-board combo matcher (sub_54B0). It runs from the main loop (0xA6E8) when gate bit 0 is clear. It compares the held keys with the 8-byte entries of the table at ROM 0xAA46 (`{u16 hold, u8 kind, u8 n, keys[4]}`). A combo fires when exactly `n` keys are held and each is in the set, in any order, and the hold counter (u16 at 0x20000556) is above `hold`. After a fire, the counter is set to 0xFFFF, so a combo fires once per hold. VERIFIED (0x5238 to 0x52F8, 0x54BC to 0x54C8, 0x5558 to 0x555E).

Every entry has hold = 0x1770 (6000). With the manual's "3 seconds" this means one tick is 0.5 ms. GUESS. So **all combos need the same hold of about 3 s.** A short press does nothing. INFERRED.

| Combo | Keys (default cells) | Handler | Effect | Saves flash |
|---|---|---|---|---|
| Pn + R | Pn (54) + cell 18 | 0x5524 | Sets reset request 0x2000050E = 1 | **yes**, after release |
| L_Alt + R_Alt | cells 76 and 78 | 0x551E | Sets reset request 0x2000050E = 2 | **yes**, after release |
| Fn + L_Shift | usages 0xD8 + 0xE1 | 0x553A | Request to move Fn (0x20000075 = 2) | yes, once the new cell is accepted |
| Pn + L_Shift | usages 0xD9 + 0xE1 | 0x553E | Request to move Pn (0x20000075 = 3) | yes, same |
| L_GUI + R_Alt + Space (either Space cell) | | 0x54F6 | Toggles bit 4 of 0x2000077F, then saves the profile | **yes**, at once |
| Pn + L_Alt + `5` | | 0x5556 | Sets 0x20000510 = 1 (meaning not traced) | no |
| Pn + L_Alt | | 0x5544 | Sets an LED cue bit (GUESS: Bluetooth pairing) | no |
| Fn + R_Alt at boot | usages 0xD8 + 0xE6 | sub_5624 (0xA538) | Toggles bit 1 of 0x2000077F, then saves the profile | **yes**, at boot |

All VERIFIED for the handlers and the saves unless noted. The three function rows differ in scope:

- **Pn + R** runs sub_44A4 and then `sub_4668(current profile)`. It resets the **whole current profile**: all three layers of the override store, the factory layer-2 pairs, the Fn and Pn cells, Win lock, the OS key mode (to 0x10), the layout (to 0), and the RGB defaults. It writes one sector. VERIFIED (0xA664 to 0xA67A).
- **L_Alt + R_Alt** runs sub_44E8: a **factory reset of all 5 profiles and the global block**. It writes six sectors. VERIFIED.
- **Fn / Pn + L_Shift** works as follows. On hold, sub_A8EC arms a "move" state. It returns at once when the current profile is 0, so **the move does nothing on profile 0**. On a profile from 1 to 4, the next key press is taken as the new Fn or Pn cell. The press is refused if its usage is Esc, L_Shift, or L_Ctrl (ROM 0xAA1A: `29 E1 E0`). On accept, the cell is stored to 0x20000E50 or 0x20000E51 and the profile is saved (0xA91E). VERIFIED.

The two resets run only after all keys are released. INFERRED.

**Manual mismatch.** The printed manual says Pn + R resets "the current layer" and L_Alt + R_Alt resets "all layers". The code does more. Pn + R resets the whole current profile. L_Alt + R_Alt resets every profile. There is no per-layer reset path. VERIFIED.

**Other saving actions.** Many function codes save the profile when pressed: 0x13D/E/F (OS key mode), 0x160 (Win lock), 0x168 (layout cycle), some LED codes (0x180..0x183, 0x190, 0x191, 0x1A0..0x1A2), and on-board key recording. There is no timer-driven autosave. All 15 call sites of sub_4668 are in action handlers or reset paths. VERIFIED.

**A save also saves the RAM override store.** The store (0x20000D24..0x20000E4F) lies inside the saved profile block 0x20000750..0x2000102B. So when any of the actions above saves the current profile, it also writes **any unsaved key override made over USB** to flash. INFERRED from the verified extent. This was not tested on a board. A tool that wants its writes to stay temporary must warn users not to press a saving key or combo while an override is in RAM.

## Link switch

The USB/Bluetooth switch is a key function, not a command. The factory layer-2 pairs put function code 0x135 on usage 0x2B (Tab) and 0x136 on usage 0x31 (backslash). VERIFIED (ROM 0xB2D6 + 22). The manual calls them "Pn + Tab" (USB) and "Pn + \" (Bluetooth). Handler 0x58B6 (code 0x135) sets `0x20000560 = 1`. Handler 0x58C6 (code 0x136) sets it to 2, only if `[0x200000D0] > 1`.

SRAM 0x20000560 is the active output link: 1 = USB, 2 = Bluetooth. INFERRED from the report sender (it sends the real report only when bit 0 is set, 0x9DC0 to 0x9DD8) and from the Bluetooth slot codes 0x131..0x134, which also set 2. The report path reads the byte directly, so there is no deferred consumer. Switching links **saves nothing**: the handlers have no call to a save routine, and neither byte lies in a flash block. VERIFIED. After a power cycle the link starts from the boot default (USB, set by sub_5618 at 0xA528) and the cable state (sub_7418). INFERRED. `[0x200000D0] > 1` is a GUESS for "Bluetooth module present".

## Watchdog and flash-save failures

**A watchdog is on at every boot.** SystemInit (sub_3430, called from the reset handler at 0x32C0) writes the Holtek HT32 watchdog block at 0x40068000. Reset on underflow is enabled. The stores are VERIFIED (0x343C, 0x3440, 0x3444). The field decode comes from the HT32 register map, so it is INFERRED. The timeout is about 2 s if the watchdog clock is the 32 kHz oscillator. GUESS, because the clock source was not traced.

**Feeding.** The only feed is sub_3614. It is called from three places: once per main-loop pass (0xA5C0), in the wait loop before the main loop (0xA566), and in a sleep loop (0x7508). VERIFIED. No feed is inside the flash code (sub_8F24, sub_8FF8, erase, program, SPI helpers). The RDSR busy-wait (sub_888C) is bounded, but sub_8F24 itself repeats erase and program with no retry limit. VERIFIED.

**Result.** A failing flash write cannot hang the board for good. The main loop stops feeding, and the watchdog resets the MCU after about 2 s. The save never completes and the unsaved RAM state is lost. INFERRED.

If the chip is dead but reads pass the header check, the board works until the first saving action, then resets. If the saved blocks are invalid at boot, boot hits the retry before the main loop and resets in a loop, so the board is unusable. No internal flash is written on these paths. INFERRED.

**Risk statement for a firmware-flash unit.** The SPI flash retry is not a brick risk. The worst case is a watchdog boot loop, and the bootloader still runs first on every reset. INFERRED. The real risks are elsewhere:

1. The app enters the bootloader by a software reset (magic value in 0x20003FFC, then the reset request at 0x76F8 to 0x7708, VERIFIED). If the watchdog survives that reset, a bootloader that does not feed it would be reset mid-flash. GUESS that it does not survive, because the vendor update to V1.01.13 worked.
2. Any replacement app image must feed the watchdog in its main loop, or leave it disabled. This image enables it unconditionally in SystemInit (VERIFIED). A replacement image decides for itself.
3. A partial internal-flash write is the brick risk. Only the bootloader (not in this image) decides whether the board can recover. OPEN.

## Open questions

1. Which physical keycap is "Fn" and which is "Pn"? Layer 1 is selected by marker 0xD8 (default cell 60), and layer 2 by 0xD9 (default cell 54). The factory function table (OS key mode, profiles, link switch) is on layer 2. The tool and the printed manual use these names for keys; matching them to the layers needs a check on a board.
2. Is the physical space bar on cell 72 (usage 0x2C) or on cell 79 (usage 0xC9)? Both type Space. A read cannot tell.
3. What do bit 1 (boot combo Fn + R_Alt) and bit 4 (L_GUI + R_Alt + Space) of SRAM 0x2000077F do? Both combos save. The consumers were not traced.
4. What do SRAM 0x20000510 (Pn + L_Alt + `5`) and 0x200000D0 mean?
5. What is the watchdog clock, so what is the exact timeout? Does the watchdog survive the software reset into the bootloader?
6. What is the tick period of the combo hold counter (0x20000556)? The "3 s" figure assumes 0.5 ms.
7. Does a save by a function key or combo really write an unsaved RAM override to flash? The extent says yes. No board test exists.
8. Sub-commands 0x51/0x2B, 0x51/0x2C, 0x52/0x2B, 0x52/0x2C, and cmd 0x40 sub 0x21 were not traced.

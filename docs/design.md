# Design

tab60kit is a static WebHID page over a TypeScript core. This page explains the shape of the code and where each safety rule lives. For the wire format, see [protocol.md](protocol.md). For the units of work and their status, see [units.md](units.md).

## The problem

Five facts shape the design.

1. A firmware flash is the one operation that can brick the board. Today the only recovery is the official updater on a Windows PC.
2. The USB link can drop. A flash can lose its link halfway.
3. The stock protocol cannot read flash back. The only checks are a 32-bit word sum (and a CRC-32 that only pok3rtool sends) over ranges at or above 0x3000, the 180-byte version page, and the 52-byte BL info block. Nothing over USB can check the bootloader.
4. The keymap commands (cmd 0x40 and up) write SRAM only. Their formats come from a static read of the firmware ([app-firmware.md](app-firmware.md)). The vendor updater never sends them.
5. A browser grant for this board lasts one USB connection, because the board has no serial number. Every mode switch and every dropped link costs a chooser pick ([webhid.md](webhid.md) C1, C3).

## Gates

Two rules hold everywhere in the code.

**G1, per command.** No command reaches the board unless its row in `COMMANDS` (`core/protocol.ts`) allows it. Each row carries an evidence source and a maturity:

| Maturity | Meaning | Who may send it |
|---|---|---|
| unreviewed | Nobody has reviewed the row | Nobody |
| reviewed | The maintainer reviewed the row in a commit | A lab page whose clearance names it |
| confirmed | A recorded session on a real board sent it and passed its checks. The row names the capture in `fixtures/` | The shipped page |

A row moves up only in a reviewed commit. An erase or write row may move above "unreviewed" only with `vendor-updater` evidence: the tool writes flash only with commands the vendor updater itself sends. `probes/policy.test.ts` checks this.

**G2, vendor bytes.** The vendor updater is read as bytes and never executed. Its bytes never leave the machine, and the repository holds none of them ([updater-package.md](updater-package.md)).

## Platform

The page runs in Chrome or Edge with no install and no signing. A native app would avoid the chooser pick per mode switch and the manual reconnect after a drop. It would also need signing, notarization, installers, and a second front end. Picks fall on flashing and deep checks, which are rare. Keymap editing, the common job, suits a page.

The bundle is static, with no server. The page carries a content security policy: `connect-src 'none'` means no code in the page can send anything off the machine, and `script-src 'self'` means only the bundle's own scripts run in the origin that holds the WebHID grant.

A node-hid shell can reuse the core through `DevicePort`. It is planned only if WebHID cannot do the job (unit U15 in [units.md](units.md)).

## Core data structures

Each structure owns one rule.

1. **`FlashWindow` and `Span`** (`flashmap.ts`). The window is the only writable flash, [0x3000, 0x1FE00). `windowFor` builds it only when the board's BL info matches `EXPECTED_LAYOUT` field by field. Offsets exist only as spans built from a window. No function takes a raw address.
2. **`ChipState` and `Observed`** (`chip.ts`). What the board reports, split by mode. Only update mode has an image checksum. `Observed` pairs a session with a chip of the same mode.
3. **`FlashableImage`** (`firmware.ts`). A handle that only `admit` builds, and only for a `CATALOG` entry matched by SHA-256 of the image and the version block. The handle carries no bytes. UI code can show and pass an image, and cannot read, save, or upload its bytes. A `"foreign"` provenance exists for open firmware, and `admit` refuses it.
4. **`COMMANDS` and `Clearance`** (`protocol.ts`). The registry and G1, as above. `SHIPPED` sends confirmed rows only. A lab clearance names exactly the commands one hardware session needs, and only `labClearance` builds one.
5. **`auditEgress`** (`protocol.ts`). `transmit` encodes a request and hands the exact 64 bytes to the audit. The audit decodes them the way the board will, with no help from the encoder. It refuses an unknown (cmd, sub), a frame that is not the command asked for, a command the clearance does not clear, a command the current mode lacks, any range or write cursor outside the window, and any erase off a page boundary. It is the only code that makes an `OutReport`, the one type `Link.send` accepts.
6. **`decideInApp`, `decideInIap`, `judgeLink`, `STEPS`** (`flash.ts`). The flash policy: three pure functions and one table.
7. **`JobState`** (`job.ts`). Every screen renders this one union. A chooser pick is the `awaiting-device` state.
8. **`KeymapDoc`** (`keymap.ts`). The keymap you want, kept as overrides on the ROM defaults. The page stores it, because the board forgets RAM edits at power off.

## How a flash runs

Firmware flashing is not in this release (unit U7). The flash job exists and is tested against the fake board.

A job observes the board, asks the policy for a step, does the step, and observes again. It keeps no cursor of its own, so the board is the record of progress.

| Observation | Policy says | Then |
|---|---|---|
| normal mode, unknown version page | `enter-iap` | Reset. Pick "USB-HID IAP" in the chooser |
| update mode, unknown page, unrecognized image | `erase-and-write-image` | The link gate probes READ MODE every 500 ms until the link has answered for 15 s with no timeout or loss. Then ERASE the version page, ERASE the app region, and write 659 chunks of 52 bytes |
| update mode, erased page, image SUM matches the catalog | `write-version-block` | Write the block in four chunks. The 0x5AA5 magic is in the last chunk. Read the page back |
| update mode, catalog page over the catalog image | `exit-to-app` | Reset into normal mode |
| normal mode, catalog page, verified this job | `done` | |

If the link drops anywhere, the job reconnects and observes again, and the observation decides where to resume. A half-written image fails its checksum, so the policy writes it again. The version page is erased first, so a reset during the erase or the write leaves the board in update mode ([protocol.md](protocol.md) "Boot rule"). A half-written version block lacks its magic, so the board stays in update mode. Each new link passes the link gate before its first write.

The link gate is hard in this version: no override. A later version may offer one for a link that keeps failing the gate.

`makeOfficial(image, { rewrite: true })` writes the image even when the board already holds it.

`testing/reconcile-model.ts` runs this loop with the real policy over a toy board, with up to four drops at every combination of the first 40 drop points, from nine starting states. `bun run reconcile` fails if any run ends in a problem.

## Where each rule lives

Rules that use types are proven by `probes/run.sh`, which injects each defect and requires the predicted compiler error. Rules the compiler cannot see are proven by `probes/boundaries.ts` and its mutations.

| Rule | Mechanism | Proof |
|---|---|---|
| The bootloader is never addressed | Spans exist only from a validated window. The audit checks every range and write cursor with `inWindow` | probe `no-raw-offsets`; egress cases in `probes/policy.test.ts`; property tests in `testing/egress-property.test.ts` |
| Every byte on the wire passed the audit | `Link.send` takes only an `OutReport` | probes `send-takes-audited-frame`, `internals-not-public`; lint rule `one-egress` |
| Only catalog images are written | `FlashableImage` brand, `admit`, catalog hashes | probe `flashable-only-from-admit`; `testing/updater.test.ts`; `bun run real-exe` |
| UI code never reads vendor bytes | The handle has no bytes; CSP `connect-src 'none'` | probes `ui-cannot-read-image-bytes`, `internals-not-public`; `testing/csp.test.ts` |
| Non-vendor images stay blocked | `"foreign"` refused; `met: false` literal type | probe `prerequisite-cannot-be-met` |
| The version block goes only over a proven image | `decideInIap` table | `probes/policy.test.ts`, the reconcile model, the drop sweep |
| No reset boots a half-erased image | The version page is erased by its own command first | the reconcile model; the drop sweep |
| Flash commands run only in update mode | Methods exist only on `IapSession`; the audit's mode check | probes `app-session-cannot-erase`, `observed-pairs-mode`, `iap-step-needs-iap-chip` |
| G1, per command | Maturity per row, checked in `clears` | probes `confirmed-needs-capture`, `lab-clearance-needs-constructor`; `probes/policy.test.ts` |
| No flash write on an unsteady link | `judgeLink` before the first flash step on each link | link-gate cases in `probes/policy.test.ts`; `testing/flash-job.test.ts` |
| The fake board cannot share a codec bug with the core | It reaches `core/` only through `port.ts` and `units.ts`, and implements the protocol from the docs | lint rule `fake-board-independence` |
| One writer on the board's single command buffer | One job per kit; `port.exclusive` takes a Web Lock across tabs | `testing/flash-job.test.ts` |
| Vendor bytes are never redistributed | The catalog holds hashes; transcripts store write payloads as hashes; CI uses a synthetic package | `testing/maav102.ts` |
| Every screen handles every state | Exhaustive `switch` in `screenFor` | the `run.sh` mutation check |

Boundaries validate, and the inside trusts types. The boundaries are the exe (`parseMaav102`), the board (`connect` checks the mode byte and BL info), incoming reports, outgoing frames (`auditEgress`), and imported keymap files (`parseKeymapDoc`).

## The caller's view

UI code imports from `@tab60kit/core` and gets a `Kit` from `startWebHid` (`web/webhid-port.ts`). `Kit` has `state`, `subscribe`, `check`, `makeOfficial`, `applyKeymap`, `capabilities`, and `cancel`. The UI never sees an opcode, an address, a port, or a link. `probes/usage.ts` and `probes/usage-sweep.ts` compile these call sites, so the documented usage and the types cannot drift apart.

## Left out on purpose

- Resume from an offset after a drop. The whole image is written again, which takes about 15 s.
- Any flash read or bootloader check. The stock protocol has neither.
- The vendor's "same or older" version gate. Flashing the same image again is allowed.
- The control-transfer path into the command dispatcher. WebHID cannot send it.
- Synthesized version blocks.
- A CLI or Electron shell in version 1.

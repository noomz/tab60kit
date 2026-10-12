# tab60kit

tab60kit is an open tool for the Vortex TAB 60 keyboard. It is a static web page that reaches the board over WebHID in Chrome or Edge, built on a TypeScript core. This tree holds plan units U0 (the scaffold), U1 (the bootloader round trip and the read-only deep check, behind a lab page), U3 (the extractor for the vendor updater package, and image admission), and U4 (property tests over the flash window and the egress audit). The flash and keymap paths still throw `notImplemented`, and later plan units write their bodies.

The design and the units live in [`docs/`](docs/), in `design.md` and `units.md`.

## Run the checks

You need Bun 1.3.13 and Node.js, which runs `tsc`.

```sh
bun install --frozen-lockfile
bun run check
```

`bun run check` runs the same steps as CI (`.github/workflows/ci.yml`), in this order:

1. `bun run typecheck` runs `tsc` on `tsconfig.json`. It runs again on `tsconfig.browser.json`, which checks the code that ships to the page without Node or Bun types.
2. `bun test` runs the unit tests. They cover the policy checks in `probes/policy.test.ts`, the package-exports test, and the protocol, chip, port, fake-board, transcript, and U1 tests under `testing/`. The U1 tests include the recovery cases, one run per `?fake` mode, and a reduced U1 sweep. The CSP test builds every page into a temp dir. `testing/egress-property.test.ts` holds plan U4's property tests. It sends 10,000 random BL info payloads through `connect` and 100,000 random frames and contexts through the egress audit, from fixed seeds. Every frame the audit passes must stay inside the window, by expectations the test writes for itself. `testing/updater.test.ts` holds plan U3's tests. They run the extractor and `admit` on a synthetic package that `testing/maav102.ts` builds, because the repo holds no vendor bytes, and on twelve mutated copies that the extractor must refuse.
3. `bun run probes` runs `probes/run.sh`. Each type probe must fail to compile with the error it predicts, and the control and usage files must compile. The boundaries lint must pass on the tree and fail on each mutated copy. The property test must fail on a copy whose `inWindow` accepts one page past the end. The script ends with `failures: 0` when every check passes.
4. `bun run reconcile` runs the flash-loop model in `testing/reconcile-model.ts`. It throws if the synthesized loop has a problem run.

## Check the extractor on the vendor's exe

The vendor's updater is never committed, so one check runs outside CI. Run it before every release:

```sh
TAB60_EXE=<Tab60firmwareV1.01.13.exe> TAB60_DECODER=<decode_updater.py> bun run real-exe
```

`TAB60_DECODER` is the Python extractor from the research notes, the oracle for this port, and it needs `python3`. The script fails when either variable is unset. It compares the TypeScript output with the oracle's byte for byte, checks the catalog's hashes and checksums, runs the twelve mutations on the real exe, and requires `admit` to admit V1.01.13 and to refuse it with one byte flipped.

## Build the page

```sh
bun run build
```

The build writes `dist/index.html` and `dist/main.js`, and the lab page `dist-lab/u1.html` and `dist-lab/u1.js`. Chrome does not load module scripts from `file://`, so serve a directory over HTTP, for example with `python3 -m http.server --directory dist 8000`. Then open `http://127.0.0.1:8000` in Chrome or Edge. WebHID needs a secure context, and `127.0.0.1` is one.

## The U1 lab page

Plan unit U1 sends the first frames to the board: seven registry rows, nine wire commands, all reads and resets. The run on the user's board on 2026-10-12 moved the seven rows to "confirmed", citing its capture in `fixtures/u1-macos.json`, so a shipped build may send them too. The core's egress audit checks every frame. Behind it, the page's link wrap refuses any frame that is not byte for byte one of the nine (`lab/u1-frames.ts`) before it reaches the board. The transcript keeps the attempt as an `out` entry followed by a `send-failed` entry, and the verdict's frames gate fails on it. The page is not shipped and lives outside both package entries.

```sh
bun run build
python3 -m http.server --bind 127.0.0.1 --directory dist-lab 8000
```

Build from a clean tree. The page prints the commit it was built from, and the verdict refuses a transcript from a build marked `-dirty`.

Open `http://127.0.0.1:8000/u1.html`. Before you click Connect, tick the three boxes at the top of the page: the cable is in, Karabiner's LED manipulation is off, and a second keyboard is at hand. Connect stays disabled until all three are ticked, in every mode, `?fake` included. Tick them before any click that sends a frame, Try again and Restart included. The boxes lock when the first frame goes out, so what they say holds for the whole run. A page that sent a frame before all three were ticked keeps Connect disabled until you reload it. Deep check is enabled only while the page is connected, all three boxes were ticked when they locked, and no RESET to IAP (11 00) has gone out since the page loaded. So each page load sends RESET to IAP at most once. To run another Deep check, reload the page. Try again and Restart stay enabled without the boxes and after an 11 00, because they bring the board home. The transcript records each box change as a `precondition` entry, and each box in its `environment` as `yes` or `no`.

Keep the tab visible while a run is going. Connect picks "USB-HID Keyboard", observes, and probes READ MODE thirty times. Deep check restarts into update mode, picks "USB-HID IAP", observes (version page and SUM), probes again, and comes back to normal mode.

The Deep check takes about 15 s in update mode. Chrome's click activation lasts 5 s, so the last pick, which confirms the board is back in normal mode, usually waits for a click. The Pick button then names the device it waits for, and the line next to it says what to choose. After the run, type in the typing field. That records that the TAB 60 types, which plan check 8 needs.

From RESET to IAP until a normal-mode link opens, the board may be in update mode, where it cannot type, and closing the tab asks first. While an update-mode link is open, Cancel reads "Stop and send the board home", because a Cancel then sends RESET to app. At any other time it reads "Stop" and only stops the run.

When a run ends while the board may be in update mode, the page enters the away state. It shows the recovery text with Try again, which repeats the update-mode checks and then sends the board home, and Restart into normal mode, which sends RESET to app and then asks you to confirm the keyboard. Connect is there too, for a board that already types again. The recovery text also shows while a run waits on a parked pick and the board may be in update mode.

A page that loads while the browser still grants USB-HID IAP starts in the away state, because an earlier page left the board in update mode. It sends no frame until you click.

Download transcript saves the capture. `bun tools/u1-verdict.ts <transcript.json> --types` writes `fixtures/u1-macos.json` with plan U1's nine checks, the frames gate, and the environment. It exits 0 only when every frame sent is one of the nine golden frames and all nine checks pass. `--no-types` records that the board did not type afterwards. The verdict writes nothing and exits 2 for a file it cannot read. It does the same for a transcript from a fake board, from a build that is not a clean commit, or with a precondition box that was not ticked when the first frame went out or changed after it.

`http://127.0.0.1:8000/u1.html?fake` runs the same page over the fake board and the fake WebHID, with no hardware. Every `?fake` page shows check 6 as FAIL, because the fake's version page is synthetic and does not hash to the catalog's version block. `?fake=slow` also fails check 9, by design. Each mode other than `?fake` sends the page down one failure path:

| URL | What the fake does | The way back |
|---|---|---|
| `?fake` | Answers every command | none needed |
| `?fake=parked` | The update-mode chooser misses its row, so that pick waits for a click | Pick |
| `?fake=deaf` | The bootloader ignores every frame | Try again or Restart into normal mode |
| `?fake=cancelled` | Every chooser from the Deep check click on closes with no device. The first closed chooser only parks the pick. Click Pick, and the second chooser also closes with no device, which leaves the page in the away state | Try again or Restart into normal mode |
| `?fake=refused` | BL info in update mode reports fw_pages 0xE8 instead of 0xE7, so the update-mode attach refuses | Restart into normal mode |
| `?fake=sum-refused` | SUM answers FF AA once, and the page sends the board home | Connect |
| `?fake=drop` | The link drops on the fifth update-mode probe, and the board comes back in update mode | Try again |
| `?fake=slow` | The fifth update-mode probe answers after 700 ms. Check 9 records it and fails on the 1.2 s gap between answers, as plan U1's rule says | none needed |
| `?fake=reloaded` | The board starts in update mode, and the browser still grants USB-HID IAP, as after a reload past the warning. The page starts in the away state | Try again or Restart into normal mode |

The drop mode counts frames from page load, so click Connect once before the Deep check. A fake run's download name ends in `-fake-<mode>`.

`bun run sweep` runs the full U1 sweep in `testing/u1-sweep.ts` over the fake board and the fake WebHID. Each scenario is one page session: Connect, Deep check, and a recovery click where the session needs one. The sweep loses the link at every packet, with and without an MCU reset, cancels after every transcript entry, and cancels at every point inside Restart and Try again. A scenario fails on a frame off the golden list, a second RESET to IAP, a board violation, a run that a Cancel cannot end, a board left in update mode without the away state, a leaked link, a Restart that leaves the board in update mode, or the wrong frames after a Cancel. A Cancel that lands while an update-mode link is open, before that link's RESET to app, must be followed by exactly that one RESET to app. Any other Cancel must be followed by no frame. The script exits 1 on any failure. It runs 153 scenarios in about 10 s on an Apple M4 Max. `bun test` runs a reduced set of 26 scenarios from `testing/u1-sweep.test.ts`.

## Package entries

`package.json` exports two entries, and the resolver refuses any other path into `core/`:

- `@tab60kit/core` (`core/index.ts`) is for UI code.
- `@tab60kit/core/port` (`core/port.ts`) is for a shell, today `web/webhid-port.ts`.

Code in `web/` reaches the core only through these two names, and `probes/boundaries.ts` enforces it. Code in `lab/`, `testing/`, `tools/`, and `probes/` is maintainer code and imports core files by relative path.

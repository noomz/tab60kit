# tab60kit

tab60kit is an open tool for the Vortex TAB 60 keyboard. It is a static web page that reaches the board over WebHID in Chrome or Edge, built on a TypeScript core. This tree holds plan units U0 (the scaffold) and U1 (the bootloader round trip and the read-only deep check, behind a lab page). The flash and keymap paths still throw `notImplemented`, and later plan units write their bodies.

The design and the units live in [`docs/`](docs/), in `design.md` and `units.md`.

## Run the checks

You need Bun 1.3.13 and Node.js, which runs `tsc`.

```sh
bun install --frozen-lockfile
bun run check
```

`bun run check` runs the same steps as CI (`.github/workflows/ci.yml`), in this order:

1. `bun run typecheck` runs `tsc` on `tsconfig.json`. It runs again on `tsconfig.browser.json`, which checks the code that ships to the page without Node or Bun types.
2. `bun test` runs the unit tests: the policy checks in `probes/policy.test.ts`, the package-exports test, the protocol, chip, port, fake-board, transcript, and U1 tests under `testing/`, and the CSP test, which builds every page into a temp dir.
3. `bun run probes` runs `probes/run.sh`. Each type probe must fail to compile with the error it predicts, and the control and usage files must compile. The boundaries lint must pass on the tree and fail on each mutated copy. The script ends with `failures: 0` when every check passes.
4. `bun run reconcile` runs the flash-loop model in `testing/reconcile-model.ts`. It throws if the synthesized loop has a problem run.

## Build the page

```sh
bun run build
```

The build writes `dist/index.html` and `dist/main.js`, and the lab page `dist-lab/u1.html` and `dist-lab/u1.js`. Chrome does not load module scripts from `file://`, so serve a directory over HTTP, for example with `python3 -m http.server --directory dist 8000`. Then open `http://127.0.0.1:8000` in Chrome or Edge. WebHID needs a secure context, and `127.0.0.1` is one.

## The U1 lab page

Plan unit U1 sends the first frames to the board: seven reviewed registry rows, nine wire commands, all reads and resets. The page is not shipped and lives outside both package entries.

```sh
bun run build
python3 -m http.server --bind 127.0.0.1 --directory dist-lab 8000
```

Open `http://127.0.0.1:8000/u1.html`. Connect picks "USB-HID Keyboard", observes, and probes READ MODE thirty times. Deep check restarts into update mode, picks "USB-HID IAP", observes (version page and SUM), probes again, and comes back to normal mode. Download transcript saves the capture. `bun tools/u1-verdict.ts <transcript.json> --types` writes `fixtures/u1-macos.json` with plan U1's nine checks; `--no-types` records that the board did not type afterwards.

`http://127.0.0.1:8000/u1.html?fake` runs the same page over the fake board and the fake WebHID, with no hardware. `?fake=parked` makes the open chooser miss the bootloader row, `?fake=cancel` closes every chooser, and `?fake=deaf` makes the bootloader ignore frames until Try again.

## Package entries

`package.json` exports two entries, and the resolver refuses any other path into `core/`:

- `@tab60kit/core` (`core/index.ts`) is for UI code.
- `@tab60kit/core/port` (`core/port.ts`) is for a shell, today `web/webhid-port.ts`.

Code in `web/` reaches the core only through these two names, and `probes/boundaries.ts` enforces it. Code in `lab/`, `testing/`, `tools/`, and `probes/` is maintainer code and imports core files by relative path.

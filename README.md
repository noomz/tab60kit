# tab60kit

tab60kit is an open tool for the Vortex TAB 60 keyboard. It is a static web page. It talks to the keyboard over WebHID in Chrome or Edge. You build it and run it on your own computer. Nothing is installed, and nothing leaves your computer.

**tab60kit is not affiliated with, endorsed by, or supported by Vortex or Vortexgear.** "Vortex" and "TAB 60" are their names. They are used here only to say which keyboard this tool is for. Do not ask Vortex for help with this tool.

> **Status: early. Use at your own risk.** The checks, the keymap editor, and the firmware write are tested on one board, on macOS. Linux and Windows hosts are not tested yet.

## What works today

Each feature below was tested on a real TAB 60 that runs the official firmware V1.01.13. "Confirmed" means a recorded session on the board passed every check. The recording is in `fixtures/`.

| Feature | State | Tested |
|---|---|---|
| Connect, and read the firmware mode and bootloader info | Confirmed | 2026-10-12, macOS, Chrome |
| Deep check: restart into the bootloader, read the version page and the flash checksum, restart back. Reads only, nothing is written | Confirmed | 2026-10-12 and 2026-10-18, macOS, Chrome |
| Read the per-key override store (three layers) | Confirmed | 2026-10-19, macOS, Chrome |
| Keymap editor: change keys on three layers, apply them to the board in RAM, keep the keymap in the browser | Confirmed | 2026-10-24, macOS, Chrome |
| Install official firmware: write the official V1.01.13 firmware, taken from your copy of the official updater, then check it | Confirmed | 2026-10-28, macOS, Chrome |
| Linux | Expected to work with a udev rule. Not tested | not yet |
| Windows | Not tested | not yet |

What "confirmed" means: the tool keeps a list of every command it may send. The shipped page may send a command only after a recorded session on a real board confirms it. The code checks every outgoing byte against that list before the byte leaves. See [docs/design.md](docs/design.md) "Gates".

## Safety

Read this before you connect your keyboard.

**Firmware flashing can brick the keyboard.** Install official firmware erases and rewrites the firmware. It erases the version page first and writes it last, so an interrupted write leaves the keyboard in update mode, where it does not type, and you can run Install official firmware again. Keep the USB cable still and the tab in front until the page reports. The firmware write is tested only on macOS. The official Vortex updater for Windows can usually recover it. If the bootloader itself cannot recover, the board needs an SWD programmer.

**Key changes are RAM only, and are lost at power off.** The keymap editor writes keys to the keyboard's RAM. It does not save them to the keyboard's flash. Unplug USB with the batteries out, and the keyboard returns to its saved keymap. The page keeps your keymap in the browser, so one click on Apply puts it back.

**Some keys and key combinations save to flash.** These are part of the stock firmware, not tab60kit. Each combination below fires after you hold it for about 3 seconds:

| Hold | What the firmware does |
|---|---|
| Pn + R | Resets the whole current profile (all layers, not one layer) and saves it |
| Left Alt + Right Alt | Factory reset of all profiles, and saves them |
| Left GUI + Right Alt + Space | Toggles a profile setting and saves the current profile |
| Fn + Left Shift, or Pn + Left Shift | Moves the Fn or Pn key (profiles 1 to 4) and saves the profile |
| Fn + Right Alt, held while the keyboard powers on | Toggles a profile setting and saves the current profile |

Some single key presses also save the current profile: the OS key mode keys (Pn + Q, W, or E), Win lock, the layout key, and some lighting keys. See [docs/app-firmware.md](docs/app-firmware.md) "Key combinations that save to flash".

From reading the firmware, we believe that a save of the current profile also saves any keys that tab60kit wrote to RAM. We have not tested this on a board. If you do not want your changes saved on the keyboard, do not press these keys while your changes are applied. Switching to another profile reloads it from flash and drops the keys written in RAM.

**One program at a time.** Close the Vortex updater and any other keyboard tool before you connect. Two programs that send commands at once can mix their packets.

## Browser support

| Browser | Works |
|---|---|
| Chrome or Edge on macOS | Yes (tested) |
| Chrome or Edge on Linux | Needs a udev rule. The page shows the exact rule. Not tested |
| Chrome or Edge on Windows | Not tested |
| Firefox, Safari | No. They do not support WebHID |

WebHID needs a secure context. `http://127.0.0.1` works. `file://` does not.

## Build and run

You need [Bun](https://bun.sh) 1.3.13 and Node.js.

```sh
bun install --frozen-lockfile
bun run build
python3 -m http.server --bind 127.0.0.1 --directory dist 8000
```

Open `http://127.0.0.1:8000` in Chrome or Edge. Click Connect and choose "USB-HID Keyboard". After a check reads the board, the Board screen shows the keymap editor. Choose the OS key mode your keyboard runs in (Pn + Q Windows, Pn + W Mac, Pn + E Caps/Ctrl swap), change keys, and click Apply. To write the official firmware, drop your copy of `Tab60firmwareV1.01.13.exe` on the file picker on the Board screen, then click Install official firmware V1.01.13. Read [Safety](#safety) first.

To run the test suite that CI runs:

```sh
bun run check
```

`check` takes a few minutes, because of the drop sweep. The developer notes, the lab pages, and the hardware checks are in [docs/development.md](docs/development.md).

## Firmware files

The repository holds no Vortex firmware and no Vortex software. To check or write firmware, you give the page your own copy of the official updater. The page reads the firmware out of it in the browser. It never runs the updater and never uploads it. The page accepts only firmware whose SHA-256 matches its catalog (today, V1.01.13).

## How we know the protocol

The protocol comes from three sources: public prior art ([pok3rtool](https://github.com/pok3r-custom/pok3rtool) and [pok3r_re_firmware](https://github.com/pok3r-custom/pok3r_re_firmware)), the official updater and firmware, and recorded sessions on a real board.

The official updater and the V1.01.13 firmware it carries were read as bytes. They were never run, and no Vortex bytes are in this repository or redistributed. They were read only to learn the commands and data formats needed to talk to the keyboard. Every address in the code and the docs cites V1.01.13, so anyone with the same files can check it.

Every command in `core/protocol.ts` names where it is known from and how far it is confirmed.

| Document | What it covers |
|---|---|
| [docs/protocol.md](docs/protocol.md) | Packet format, both modes, flash map, version page, flash sequence |
| [docs/app-firmware.md](docs/app-firmware.md) | App commands, key override store, config gate, keys that save to flash |
| [docs/updater-package.md](docs/updater-package.md) | How the firmware is stored in the official updater, and how it is extracted |
| [docs/webhid.md](docs/webhid.md) | Browser and platform facts, and the Linux udev rule |
| [docs/design.md](docs/design.md) | How the code is shaped, and where each safety rule lives |
| [docs/ui.md](docs/ui.md) | The page's colors, fonts, and screen states |
| [docs/units.md](docs/units.md) | The units of work (U0 to U15), their checks, and their status |
| [docs/development.md](docs/development.md) | Build, tests, lab pages, and hardware checks |

## Report a problem

For anything that could brick a keyboard or damage saved settings, follow [SECURITY.md](SECURITY.md). Do not open a public issue for those. For other bugs, open an issue.

## License

MIT. See [LICENSE](LICENSE).

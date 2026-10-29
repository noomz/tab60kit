# UI

The shipped page draws every screen from one `PageView` (`web/view.ts`). `web/app.ts` turns it into DOM with class names, and `web/app.css` styles those classes. No element carries an inline style attribute. The CSP (`default-src 'self'`) allows the stylesheet and the fonts because the build copies both next to `index.html`.

## Tokens

The tokens are custom properties on `:root` in `web/app.css`.

| Token | Value | Use |
|---|---|---|
| `--ink`, `--ink-2`, `--ink-3` | `#14181B`, `#424B50`, `#5A6368` | Text: titles, body, labels and notes |
| `--ground` | `#EEF1F2` | Page background |
| `--panel` | `#FFFFFF` | Panels, buttons, chips |
| `--line`, `--line-2` | `#D5DBDE`, `#E4E8EA` | Panel borders, row dividers |
| `--well`, `--code-bg` | `#F8FAFA`, `#F5F7F7` | File drop zone, udev rule |
| `--cobalt`, `--cobalt-dk`, `--cobalt-tint`, `--cobalt-line` | `#2448B8`, `#1B378F`, `#E9EEFB`, `#C6D2F3` | Actions and confirmed results |
| `--orange`, `--orange-dk`, `--orange-tint`, `--orange-line` | `#A64B0A`, `#8A3D07`, `#FBEEE4`, `#EDC9AF` | Attention and failure |
| `--muted`, `--muted-line` | `#DCE1E3`, `#9AA5AB` | Disabled controls, not checked |
| `--sans`, `--mono` | IBM Plex Sans, IBM Plex Mono | Body text; addresses, the brand, and code |

Every text color on its background measures at least 4.5:1.

## Rules

- **Color has a meaning.** Cobalt marks actions and confirmed matches. Orange marks attention and failure. Grey marks "not checked" and "locked". The page uses no red or green. `Tone` in `web/view.ts` carries the meaning: `confirmed`, `attention`, `muted`, or `plain`.
- **Dashed cobalt means live on the keyboard, not saved on it.** The header chip after Apply, the Apply bar, and each key with an override use it.
- **One main button per screen.** `PageView.primary` names it: a parked Pick first, then Install official firmware, then the first action. Stop and Skip are never the main button.
- **A parked pick is the largest control on the page,** and it takes focus.
- **Plain words first.** A flash-map row says what it means for the user and why a grey row is normal. The exact technical reason sits in a Details disclosure under the row. A legend under the map says what each dot color means.
- **Offer an install only when it would do something.** A board that update mode verified to run the dropped version gets "Nothing to install" and no button. A board whose version page alone names it keeps the install as a secondary button. Two short lines say what the install does; the rest sits behind "About the install".
- **The chip says where the board is now.** A finished or stopped job records `at`, the mode of the session it ended with. A deep check or install keeps its update-mode reading for the flash map, but the chip shows `at`. A job that ended with no session, as after a skipped confirm pick, shows "mode unknown, click Check again".
- **"Check again", not "Connect", once a board was read.** It runs the same quick check. It is never the main button.
- **Keys show what they send on the chosen layer.** Read keymap reads the board's override store with the same reads Apply starts with, and writes nothing. A key then shows, in order: this page's change (dashed cobalt, "→ X"), an override the board holds (solid cobalt, "was X"), the factory Pn function (grey, named when docs/app-firmware.md names its code), or the cap. Nobody has traced the factory Fn functions, so the Fn layer says so and shows only overrides.
- **Layers are named by the key that holds them.** The layer select names the cap in the cell where the firmware puts each layer marker (Fn for layer 1, Pn for layer 2).

## Fonts

The build copies IBM Plex Sans (400, 500, 600) and IBM Plex Mono (400, 600), Latin subset, from the `@fontsource` packages into `dist/fonts/`, with each family's SIL Open Font License 1.1 text. The page loads no font from another origin.

## Screens

| Screen | Panel tone | Header chip |
|---|---|---|
| Browser gate | attention | Not connected |
| Connect, with a board outline | plain | Not connected |
| Pick the keyboard | plain, with the hold-still banner unless the pick is the first Connect | Pick in the chooser, or Waiting for your pick |
| Your board | plain | Where the board was last seen: normal mode or update mode |
| Working, with a progress bar for a counted step | plain | Same; USB link dropped while the kit reconnects |
| Result | confirmed after a flash, plain after a check or Apply | Same; after Apply, also the dashed keymap chip |
| Stopped | attention, except a plain Stop | Same |
| Linux permission | attention | Not connected |

The Board, result, and Stopped screens show the flash map in a second column, and the keymap editor below both. At phone width the columns stack, and the editor's keyboard scrolls sideways inside its frame.

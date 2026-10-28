# Security and safety

tab60kit sends commands to a keyboard. A bug here can leave a keyboard that does not type, erase saved settings, or, once flashing ships, brick a board. We treat those bugs as security issues.

## How to report

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Fill in the form. Only the maintainer can see it.

Do not open a public issue for a brick risk or for anything below. Do not post a way to damage someone else's keyboard in public before a fix ships.

We do not take reports by email.

## What counts

Report it privately if any of these is true:

- The page sent a command that is not in the command list in `core/protocol.ts`, or one the list marks as not confirmed.
- The shipped page sent an erase or a write to flash. It must not do this in this release.
- The keyboard stopped typing, stayed in update mode ("USB-HID IAP"), or did not come back after the page said it was done.
- Saved settings changed when the page said the write was RAM only, and you pressed none of the keys that save (README, "Safety").
- The page accepted a firmware file that is not in its catalog, or a file with a changed byte.
- The page sent your firmware file, your updater, or your keymap anywhere off your computer.
- A crafted file (updater, keymap file, or transcript) makes the page do any of the above.

Normal bugs go to public issues: a wrong label, a layout problem, a key that maps to the wrong name, a test that fails.

## What to include

The more of this you include, the faster we can tell what happened and how to get your board back.

**What you ran**

- The commit or version of tab60kit. The page shows it.
- Browser and version, and the operating system.
- Which page: the main page or a lab page, and the URL.

**What the keyboard is doing now**

- Does it type over USB? Over Bluetooth?
- What the browser's device chooser lists: "USB-HID Keyboard" (normal mode) or "USB-HID IAP" (update mode), or nothing.
- What a power cycle does: unplug USB, take the batteries out for 10 seconds, plug USB back in.
- Firmware version, if the Deep check still runs.

**The record**

- The transcript. Click **Download transcript** on the page and attach the JSON file. It holds every frame sent and received. It also holds your browser's user-agent string; remove it if you prefer.
- The exact steps, and the last thing the page showed.
- Whether any other program had the keyboard open: the Vortex updater, Karabiner, or another keyboard tool.

Do not attach the Vortex updater or a firmware image. We have the same files, matched by SHA-256.

## Getting a board back

Try these in order. Stop at the first one that works.

1. On the tab60kit page, click **Restart into normal mode**, or **Try again** if the page shows it.
2. Power cycle: unplug USB, take the batteries out for 10 seconds, plug USB back in.
3. On Windows, run the official Vortex updater for your firmware version. It can write the firmware again from update mode.
4. If nothing enumerates and the updater cannot see the board, it needs an SWD programmer. Tell us in your report before you try this.

Keys written in RAM come back to their saved values after step 2. That is expected and is not a bug.

## Response

This is a one-person project with no service-level promise. We aim to reply to a private report within 7 days. When a report is confirmed, we fix it, then publish an advisory that credits you unless you ask us not to.

## Scope

In scope: this repository's code, the page it builds, and its lab pages.

Out of scope: the stock Vortex firmware and the Vortex updater. We can document a firmware behavior we find, but we cannot fix it. tab60kit is not affiliated with Vortex or Vortexgear.

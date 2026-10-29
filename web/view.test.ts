import { expect, test } from "bun:test";
import { type Admission, CATALOG, type ChipReport, type ChipState, type FlashableImage, type UpdaterReading } from "@tab60kit/core";
import { type Installed, admittedImage } from "./screens";
import { loadedText, statusChips, viewFor } from "./view";

test("a parked pick says the page waits for the user and shows a Pick button that names the row; an open chooser only says which row to pick", () => {
	const prompt = { name: "device-prompt", reason: "enter-update-mode", pickRow: "USB-HID IAP", skippable: false } as const;
	const parked = viewFor(prompt, { modes: ["iap"], reason: "enter-update-mode" });
	expect(parked.actions).toEqual(["pick", "cancel"]);
	expect(parked.pickLabel).toBe("Pick USB-HID IAP");
	expect(parked.holdStill).toBe(true);
	expect(parked.lines[0]).toBe("Waiting for you: click Pick USB-HID IAP, then choose USB-HID IAP.");
	const open = viewFor(prompt, null);
	expect(open.actions).toEqual(["cancel"]);
	expect(open.lines[0]).toBe("In the chooser, pick USB-HID IAP.");
});

test("the optional confirm pick offers Skip instead of Stop", () => {
	const confirm = { name: "device-prompt", reason: "confirm-normal-mode", pickRow: "USB-HID Keyboard", skippable: true } as const;
	expect(viewFor(confirm, { modes: ["app"], reason: "confirm-normal-mode" }).actions).toEqual(["pick", "skip"]);
	expect(viewFor(confirm, null).actions).toEqual(["skip"]);
});

test("progress holds still, with its banner and unload guard, only when the board cannot type", () => {
	const restarting = viewFor({ name: "progress", activity: { kind: "restarting", into: "iap" }, holdStill: true, report: null }, null);
	expect(restarting.lines).toEqual(["Restarting the board into update mode."]);
	expect(restarting.holdStill).toBe(true);
	expect(restarting.actions).toEqual(["cancel"]);
	const reading = viewFor({ name: "progress", activity: { kind: "reading" }, holdStill: false, report: null }, null);
	expect(reading.lines).toEqual(["Reading the board."]);
	expect(reading.holdStill).toBe(false);
	const gate = viewFor({ name: "progress", activity: { kind: "holding-link", quietMs: 6_400, needMs: 15_000 }, holdStill: true, report: null }, null);
	expect(gate.lines).toEqual(["Checking that the USB link is steady before the first write: 6 of 15 s. Keep the cable still."]);
	expect(gate.holdStill).toBe(true);
});

const report = { regions: [], boot: "normal-mode" } as unknown as ChipReport;
/** Only `admit` builds a real handle; the view reads nothing but its entry. */
const image = { entry: CATALOG[0] } as unknown as FlashableImage;
const unread = { reading: null, blockedBy: [], installed: null };
const G1_ERASE = "Erase pages: reviewed, needs a capture on this board (gate G1)";
const board = (reading: UpdaterReading | null, blockedBy: readonly string[] = [], installed: Installed = null) =>
	viewFor({ name: "board", report, flash: { reading, blockedBy, installed }, keymapLockedBy: [], openFirmware: [] }, null);

test("the Board screen offers the install only for an admitted image G1 lets this kit flash, and says the link check comes first", () => {
	expect(board(null).actions).toEqual(["recheck", "deep-check"]);
	expect(board(null).lines[0]).toStartWith("To install official firmware, drop Tab60firmwareV1.01.13.exe");
	expect(board({ kind: "refused", refusal: { code: "not-pe", detail: "x" } }).lines).toEqual(["That file is not a TAB 60 updater this page can read (not-pe)."]);
	const read = (admission: Admission): UpdaterReading => ({ kind: "read", exe: { sha256: image.entry.source.exeSha256, bytes: 0 }, title: "t", version: "v", images: [{ slot: 0, layoutName: "US Layout", plainSha256: image.entry.image.sha256, bytes: 34_268, admission }] });
	const admitted = read({ kind: "admitted", image });
	expect(admittedImage(admitted)).toBe(image);
	expect(board(admitted).actions).toEqual(["recheck", "deep-check", "install"]);
	expect(board(admitted)).toMatchObject({
		installLabel: "Install official firmware V1.01.13",
		primary: "install",
		lines: ["Slot 1, US Layout: official V1.01.13.", "Install official firmware V1.01.13 replaces the firmware on the keyboard.", "It takes about 20 seconds, and the keyboard can't type during it."],
	});
	expect(board(admitted).details?.lines).toContain("Keys set with Apply are lost when the keyboard restarts. Click Apply again afterwards.");
	expect(board(admitted).details?.lines).toContain("If the keyboard already runs V1.01.13, the install checks it and writes nothing.");
	expect(board(admitted).details?.lines.join(" ")).toContain("It first checks the USB link for 15 seconds and writes nothing until the link holds");
	expect(board(admitted, [G1_ERASE])).toMatchObject({
		actions: ["recheck", "deep-check"],
		lines: ["Slot 1, US Layout: official V1.01.13.", `This build cannot install firmware yet: ${G1_ERASE}.`],
	});
	const refused = read({ kind: "refused", refusal: { code: "no-version-block" } });
	expect(admittedImage(refused)).toBeNull();
	expect(board(refused)).toMatchObject({ actions: ["recheck", "deep-check"], lines: ["Slot 1, US Layout: not installable (no-version-block)."] });
});

test("a stop names what to do next, and a cancel during the restart says where the board may be", () => {
	const cancelled = viewFor({ name: "stopped", reason: { kind: "cancelled", during: { kind: "restarting", into: "iap" } }, report: null, flash: unread }, null);
	expect(cancelled.lines).toEqual(["Stopped. The board may be in update mode: click Connect to see where it is."]);
	expect(cancelled.actions).toEqual(["connect", "deep-check"]);
	const busy = viewFor({ name: "stopped", reason: { kind: "busy" }, report: null, flash: unread }, null);
	expect(busy.lines[0]).toContain("Another tab or program");
});

test("a browser without WebHID gets the gate and no buttons", () => {
	expect(viewFor({ name: "browser-gate", why: "no-webhid" }, null)).toMatchObject({ title: "Use Chrome or Edge", actions: [] });
});

test("a Stop during Apply says the writes may be partial and offers Apply again; a closed-gate refusal says to pull the batteries", () => {
	const partial = viewFor({ name: "stopped", reason: { kind: "cancelled", during: { kind: "applying-keymap", done: 2, total: 5 } }, report: null, flash: unread }, null);
	expect(partial.lines[0]).toStartWith("Stopped during Apply: some keys may hold the new keymap and others not");
	expect(partial.lines[0]).toContain("Click Apply again");
	const held = viewFor({ name: "stopped", reason: { kind: "keymap", problem: { kind: "gate", when: "before", gate: 1 } }, report: null, flash: unread }, null);
	expect(held.lines[0]).toContain("unplug USB with the batteries out");
});

test("after a job, the result and Stopped screens keep the dropped exe's lines and the install", () => {
	const reading: UpdaterReading = { kind: "read", exe: { sha256: image.entry.source.exeSha256, bytes: 0 }, title: "t", version: "v", images: [{ slot: 0, layoutName: "US Layout", plainSha256: image.entry.image.sha256, bytes: 34_268, admission: { kind: "admitted", image } }] };
	const stopped = viewFor({ name: "stopped", reason: { kind: "busy" }, report: null, flash: { reading, blockedBy: [], installed: null } }, null);
	expect(stopped.actions).toEqual(["connect", "deep-check", "install"]);
	expect(stopped.lines[1]).toBe("Slot 1, US Layout: official V1.01.13.");
	const gated = viewFor({ name: "stopped", reason: { kind: "gate", blocked: G1_ERASE }, report: null, flash: { reading, blockedBy: [G1_ERASE], installed: null } }, null);
	expect(gated.actions).toEqual(["connect", "deep-check"]);
	expect(viewFor({ name: "result", result: { kind: "checked", depth: "quick" }, report: null, flash: { reading, blockedBy: [], installed: null } }, null).actions).toContain("install");
	expect(viewFor({ name: "result", result: { kind: "checked", depth: "quick" }, report: null, flash: unread }, null)).toMatchObject({ lines: [], actions: ["connect", "deep-check"] });
});

test("the main button is the parked pick, then the install, then the first action; Stop, Skip, and Check again are never main", () => {
	expect(viewFor({ name: "device-prompt", reason: "enter-update-mode", pickRow: "USB-HID IAP", skippable: false }, { modes: ["iap"], reason: "enter-update-mode" }).primary).toBe("pick");
	expect(viewFor({ name: "device-prompt", reason: "confirm-normal-mode", pickRow: "USB-HID Keyboard", skippable: true }, null).primary).toBeNull();
	expect(viewFor({ name: "progress", activity: { kind: "erasing" }, holdStill: true, report: null }, null).primary).toBeNull();
	expect(board(null).primary).toBeNull();
	const reading: UpdaterReading = { kind: "read", exe: { sha256: image.entry.source.exeSha256, bytes: 0 }, title: "t", version: "v", images: [{ slot: 0, layoutName: "US Layout", plainSha256: image.entry.image.sha256, bytes: 34_268, admission: { kind: "admitted", image } }] };
	expect(board(reading).primary).toBe("install");
});

test("a counted activity carries a progress bar; the others do not", () => {
	const progress = (activity: Parameters<typeof viewFor>[0] & { name: "progress" }) => viewFor(activity, null).progress;
	expect(progress({ name: "progress", activity: { kind: "writing-image", chunk: 412, chunks: 663 }, holdStill: true, report: null })).toEqual({ done: 412, total: 663 });
	expect(progress({ name: "progress", activity: { kind: "applying-keymap", done: 2, total: 5 }, holdStill: false, report: null })).toEqual({ done: 2, total: 5 });
	expect(progress({ name: "progress", activity: { kind: "holding-link", quietMs: 16_000, needMs: 15_000 }, holdStill: true, report: null })).toEqual({ done: 15_000, total: 15_000 });
	expect(progress({ name: "progress", activity: { kind: "erasing" }, holdStill: true, report: null })).toBeNull();
});

test("tone: a flash ends confirmed, a check does not, a failure asks for attention, and a plain Stop stays plain", () => {
	const result = (r: Parameters<typeof viewFor>[0] & { name: "result" }) => viewFor(r, null).tone;
	expect(result({ name: "result", result: { kind: "official", entry: CATALOG[0]!, confirmedInNormalMode: true }, report: null, flash: unread })).toBe("confirmed");
	expect(result({ name: "result", result: { kind: "checked", depth: "deep" }, report: null, flash: unread })).toBe("plain");
	expect(result({ name: "result", result: { kind: "keymap-applied", writes: 3 }, report: null, flash: unread })).toBe("plain");
	const stop = (reason: Parameters<typeof viewFor>[0] & { name: "stopped" }) => viewFor(reason, null).tone;
	expect(stop({ name: "stopped", reason: { kind: "cancelled", during: null }, report: null, flash: unread })).toBe("plain");
	expect(stop({ name: "stopped", reason: { kind: "cancelled", during: { kind: "restarting", into: "iap" } }, report: null, flash: unread })).toBe("attention");
	expect(stop({ name: "stopped", reason: { kind: "too-many-link-losses", losses: 3 }, report: null, flash: unread })).toBe("attention");
	expect(viewFor({ name: "browser-gate", why: "no-webhid" }, null).tone).toBe("attention");
});

test("flash map rows and the boot line carry the tone of what they found", () => {
	const official = { kind: "official", entry: CATALOG[0]!, by: "sum" } as const;
	const mapped = viewFor({ name: "board", report: { regions: [{ region: "app", from: 0x3200, to: 0x1fdff, finding: official }, { region: "version-page", from: 0x3000, to: 0x31ff, finding: { kind: "erased" } }, { region: "bootloader", from: 0, to: 0x2fff, finding: { kind: "not-checkable-over-usb", why: "x", fingerprint: null } }], boot: "stays-in-update-mode" } as unknown as ChipReport, flash: unread, keymapLockedBy: [], openFirmware: [] }, null);
	expect(mapped.flashMap?.map((row) => row.tone)).toEqual(["confirmed", "attention", "muted"]);
	expect(mapped.flashMap?.[2]).toMatchObject({ finding: "Can't be read over USB, which is normal. This tool never writes the bootloader.", detail: "USB can read only a 52-byte info block about the bootloader, not its code." });
	expect(mapped.flashMap?.[0]?.detail).toBeNull();
	expect(mapped.boot?.tone).toBe("attention");
});

test("the header chip says where the board was last seen, and the dashed live chip shows only after Apply", () => {
	const app = { mode: "app" } as unknown as ChipState;
	const iap = { mode: "iap" } as unknown as ChipState;
	expect(statusChips({ kind: "idle", board: null }, null)).toEqual([{ kind: "idle", label: "Not connected" }]);
	expect(statusChips({ kind: "idle", board: app }, null)).toEqual([{ kind: "normal", label: "TAB 60 · normal mode" }]);
	expect(statusChips({ kind: "working", job: "deep-check", activity: { kind: "reading" }, board: iap }, null)).toEqual([{ kind: "update", label: "TAB 60 · update mode" }]);
	expect(statusChips({ kind: "working", job: "make-official", activity: { kind: "link-lost", losses: 1 }, board: iap }, null)).toEqual([{ kind: "lost", label: "USB link dropped" }]);
	const want = { modes: ["iap"], reason: "enter-update-mode" } as const;
	expect(statusChips({ kind: "awaiting-device", job: "deep-check", want, board: app }, want)).toEqual([{ kind: "wait", label: "Waiting for your pick" }]);
	expect(statusChips({ kind: "finished", job: "apply-keymap", result: { kind: "keymap-applied", writes: 2 }, board: app, at: "app" }, null).map((chip) => chip.kind)).toEqual(["live", "normal"]);
	expect(statusChips({ kind: "finished", job: "quick-check", result: { kind: "checked", depth: "quick" }, board: app, at: "app" }, null).map((chip) => chip.kind)).toEqual(["normal"]);
});

test("a board read that finds no key with a layer marker says so in plain words", () => {
	const lost = viewFor({ name: "stopped", reason: { kind: "keymap", problem: { kind: "mode-disagrees", mode: "windows", missing: [0xd8], unexpected: [] } }, report: null, flash: unread }, null);
	expect(lost.lines[0]).toStartWith("No key on the board works as Fn now, so its layer cannot be reached. The board's keys do not match");
});

const admittedReading = (): UpdaterReading => ({ kind: "read", exe: { sha256: image.entry.source.exeSha256, bytes: 0 }, title: "t", version: "v", images: [{ slot: 0, layoutName: "US Layout", plainSha256: image.entry.image.sha256, bytes: 34_268, admission: { kind: "admitted", image } }] });

test("a board verified to run the dropped version gets no install; one whose version page alone says so keeps it as a secondary button", () => {
	const verified = board(admittedReading(), [], "verified");
	expect(verified).toMatchObject({ actions: ["recheck", "deep-check"], installLabel: null, details: null, primary: null });
	expect(verified.lines[0]).toBe("Your keyboard already runs official V1.01.13. Nothing to install.");
	const reported = board(admittedReading(), [], "reported");
	expect(reported).toMatchObject({ actions: ["recheck", "deep-check", "install"], primary: null });
	expect(reported.lines[0]).toBe("Your keyboard reports official V1.01.13, but its firmware is not verified yet. Deep check verifies it.");
});

test("the drop zone names the loaded file and its version, or why it holds none", () => {
	expect(loadedText("Tab60firmwareV1.01.13.exe", admittedReading())).toBe("Loaded: Tab60firmwareV1.01.13.exe (V1.01.13)");
	expect(loadedText("x.exe", { kind: "refused", refusal: { code: "not-pe", detail: "x" } })).toBe("Loaded: x.exe (not a TAB 60 updater)");
});

test("after a job the chip says the mode of the session the job ended with, not the reading it kept; no session means not confirmed", () => {
	const iap = { mode: "iap" } as unknown as ChipState;
	const done = (at: "app" | "iap" | null) => statusChips({ kind: "finished", job: "deep-check", result: { kind: "checked", depth: "deep" }, board: iap, at }, null);
	expect(done("app")).toEqual([{ kind: "normal", label: "TAB 60 · normal mode" }]);
	expect(done("iap")).toEqual([{ kind: "update", label: "TAB 60 · update mode" }]);
	expect(done(null)).toEqual([{ kind: "idle", label: "TAB 60 · mode not confirmed, click Check again" }]);
	expect(statusChips({ kind: "working", job: "deep-check", activity: { kind: "reading" }, board: iap }, null)).toEqual([{ kind: "update", label: "TAB 60 · update mode" }]);
});

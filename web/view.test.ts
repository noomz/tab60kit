import { expect, test } from "bun:test";
import { type Admission, CATALOG, type ChipReport, type FlashableImage, type UpdaterReading } from "@tab60kit/core";
import { admittedImage, viewFor } from "./view";

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
const unread = { reading: null, blockedBy: [] };
const G1_ERASE = "Erase pages: reviewed, needs a capture on this board (gate G1)";
const board = (reading: UpdaterReading | null, blockedBy: readonly string[] = []) => viewFor({ name: "board", report, flash: { reading, blockedBy }, keymapLockedBy: [], openFirmware: [] }, null);

test("the Board screen offers Make official only for an admitted image G1 lets this kit flash, and says the link check comes first", () => {
	expect(board(null).actions).toEqual(["connect", "deep-check"]);
	expect(board(null).lines[0]).toStartWith("To flash official firmware, drop Tab60firmwareV1.01.13.exe");
	expect(board({ kind: "refused", refusal: { code: "not-pe", detail: "x" } }).lines).toEqual(["That file is not a TAB 60 updater this page can read (not-pe)."]);
	const read = (admission: Admission): UpdaterReading => ({ kind: "read", exe: { sha256: image.entry.source.exeSha256, bytes: 0 }, title: "t", version: "v", images: [{ slot: 0, layoutName: "US Layout", plainSha256: image.entry.image.sha256, bytes: 34_268, admission }] });
	const admitted = read({ kind: "admitted", image });
	expect(admittedImage(admitted)).toBe(image);
	expect(board(admitted).actions).toEqual(["connect", "deep-check", "make-official"]);
	expect(board(admitted).lines[0]).toBe("Slot 1, US Layout: official V1.01.13, ready to flash.");
	expect(board(admitted).lines[1]).toStartWith("Make official first checks the USB link for 15 seconds and writes nothing until it holds.");
	expect(board(admitted).lines[1]).toContain("The keyboard cannot type from then until the page says the flash is done.");
	expect(board(admitted, [G1_ERASE])).toMatchObject({
		actions: ["connect", "deep-check"],
		lines: ["Slot 1, US Layout: official V1.01.13, ready to flash.", `This build cannot flash yet: ${G1_ERASE}.`],
	});
	const refused = read({ kind: "refused", refusal: { code: "no-version-block" } });
	expect(admittedImage(refused)).toBeNull();
	expect(board(refused)).toMatchObject({ actions: ["connect", "deep-check"], lines: ["Slot 1, US Layout: not flashable (no-version-block)."] });
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

test("after a job, the result and Stopped screens keep the dropped exe's lines and Make official", () => {
	const reading: UpdaterReading = { kind: "read", exe: { sha256: image.entry.source.exeSha256, bytes: 0 }, title: "t", version: "v", images: [{ slot: 0, layoutName: "US Layout", plainSha256: image.entry.image.sha256, bytes: 34_268, admission: { kind: "admitted", image } }] };
	const stopped = viewFor({ name: "stopped", reason: { kind: "busy" }, report: null, flash: { reading, blockedBy: [] } }, null);
	expect(stopped.actions).toEqual(["connect", "deep-check", "make-official"]);
	expect(stopped.lines[1]).toBe("Slot 1, US Layout: official V1.01.13, ready to flash.");
	const gated = viewFor({ name: "stopped", reason: { kind: "gate", blocked: G1_ERASE }, report: null, flash: { reading, blockedBy: [G1_ERASE] } }, null);
	expect(gated.actions).toEqual(["connect", "deep-check"]);
	expect(viewFor({ name: "result", result: { kind: "checked", depth: "quick" }, report: null, flash: { reading, blockedBy: [] } }, null).actions).toContain("make-official");
	expect(viewFor({ name: "result", result: { kind: "checked", depth: "quick" }, report: null, flash: unread }, null)).toMatchObject({ lines: [], actions: ["connect", "deep-check"] });
});

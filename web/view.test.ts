import { expect, test } from "bun:test";
import type { Admission, ChipReport, UpdaterReading } from "@tab60kit/core";
import { syntheticFlashable } from "../testing/synthetic-image";
import { admittedImage, viewFor } from "./view";

test("a parked pick shows a Pick button that names the row; an open chooser only says which row to pick", () => {
	const prompt = { name: "device-prompt", reason: "enter-update-mode", pickRow: "USB-HID IAP", skippable: false } as const;
	const parked = viewFor(prompt, { modes: ["iap"], reason: "enter-update-mode" });
	expect(parked.actions).toEqual(["pick", "cancel"]);
	expect(parked.pickLabel).toBe("Pick USB-HID IAP");
	expect(parked.holdStill).toBe(true);
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
const board = (reading: UpdaterReading | null) => viewFor({ name: "board", report, reading, keymapLockedBy: [], openFirmware: [] }, null);

test("the Board screen offers Make official only for an admitted image, and says the link check comes first", async () => {
	expect(board(null).actions).toEqual(["connect", "deep-check"]);
	expect(board(null).lines[0]).toStartWith("To flash official firmware, drop Tab60firmwareV1.01.13.exe");
	expect(board({ kind: "refused", refusal: { code: "not-pe", detail: "x" } }).lines).toEqual(["That file is not a TAB 60 updater this page can read (not-pe)."]);
	const image = await syntheticFlashable();
	const read = (admission: Admission): UpdaterReading => ({ kind: "read", exe: { sha256: image.entry.source.exeSha256, bytes: 0 }, title: "t", version: "v", images: [{ slot: 0, layoutName: "US Layout", plainSha256: image.entry.image.sha256, bytes: 34_268, admission }] });
	const admitted = read({ kind: "admitted", image });
	expect(admittedImage(admitted)).toBe(image);
	expect(board(admitted).actions).toEqual(["connect", "deep-check", "make-official"]);
	expect(board(admitted).lines[0]).toBe("Slot 1, US Layout: official V9.99.99, ready to flash.");
	expect(board(admitted).lines[1]).toStartWith("Make official first checks the USB link for 15 seconds and writes nothing until it holds.");
	const refused = read({ kind: "refused", refusal: { code: "no-version-block" } });
	expect(admittedImage(refused)).toBeNull();
	expect(board(refused)).toMatchObject({ actions: ["connect", "deep-check"], lines: ["Slot 1, US Layout: not flashable (no-version-block)."] });
});

test("a stop names what to do next, and a cancel during the restart says where the board may be", () => {
	const cancelled = viewFor({ name: "stopped", reason: { kind: "cancelled", during: { kind: "restarting", into: "iap" } }, report: null, reading: null }, null);
	expect(cancelled.lines).toEqual(["Stopped. The board may be in update mode: click Connect to see where it is."]);
	expect(cancelled.actions).toEqual(["connect", "deep-check"]);
	const busy = viewFor({ name: "stopped", reason: { kind: "busy" }, report: null, reading: null }, null);
	expect(busy.lines[0]).toContain("Another tab or program");
});

test("a browser without WebHID gets the gate and no buttons", () => {
	expect(viewFor({ name: "browser-gate", why: "no-webhid" }, null)).toMatchObject({ title: "Use Chrome or Edge", actions: [] });
});

test("a Stop during Apply says the writes may be partial and offers Apply again; a closed-gate refusal says to pull the batteries", () => {
	const partial = viewFor({ name: "stopped", reason: { kind: "cancelled", during: { kind: "applying-keymap", done: 2, total: 5 } }, report: null, reading: null }, null);
	expect(partial.lines[0]).toStartWith("Stopped during Apply: some keys may hold the new keymap and others not");
	expect(partial.lines[0]).toContain("Click Apply again");
	const held = viewFor({ name: "stopped", reason: { kind: "keymap", problem: { kind: "gate", when: "before", gate: 1 } }, report: null, reading: null }, null);
	expect(held.lines[0]).toContain("unplug USB with the batteries out");
});

test("after a job, the result and Stopped screens keep the dropped exe's lines and Make official", async () => {
	const image = await syntheticFlashable();
	const reading: UpdaterReading = { kind: "read", exe: { sha256: image.entry.source.exeSha256, bytes: 0 }, title: "t", version: "v", images: [{ slot: 0, layoutName: "US Layout", plainSha256: image.entry.image.sha256, bytes: 34_268, admission: { kind: "admitted", image } }] };
	const stopped = viewFor({ name: "stopped", reason: { kind: "gate", blocked: "Erase pages: reviewed, needs a capture on this board (gate G1)" }, report: null, reading }, null);
	expect(stopped.actions).toEqual(["connect", "deep-check", "make-official"]);
	expect(stopped.lines[0]).toBe("This build cannot do that yet: Erase pages: reviewed, needs a capture on this board (gate G1).");
	expect(viewFor({ name: "result", result: { kind: "checked", depth: "quick" }, report: null, reading }, null).actions).toContain("make-official");
	expect(viewFor({ name: "result", result: { kind: "checked", depth: "quick" }, report: null, reading: null }, null)).toMatchObject({ lines: [], actions: ["connect", "deep-check"] });
});

import { expect, test } from "bun:test";
import { viewFor } from "./view";

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

test("progress warns against unplugging only when the board cannot type", () => {
	const restarting = viewFor({ name: "progress", activity: { kind: "restarting", into: "iap" }, holdStill: true, report: null }, null);
	expect(restarting.lines).toEqual(["Restarting the board into update mode.", "Do not unplug the keyboard."]);
	expect(restarting.actions).toEqual(["cancel"]);
	const reading = viewFor({ name: "progress", activity: { kind: "reading" }, holdStill: false, report: null }, null);
	expect(reading.lines).toEqual(["Reading the board."]);
	expect(reading.holdStill).toBe(false);
});

test("a stop names what to do next, and a cancel during the restart says where the board may be", () => {
	const cancelled = viewFor({ name: "stopped", reason: { kind: "cancelled", during: { kind: "restarting", into: "iap" } }, report: null }, null);
	expect(cancelled.lines).toEqual(["Stopped. The board may be in update mode: click Connect to see where it is."]);
	expect(cancelled.actions).toEqual(["connect", "deep-check"]);
	const busy = viewFor({ name: "stopped", reason: { kind: "busy" }, report: null }, null);
	expect(busy.lines[0]).toContain("Another tab or program");
});

test("a browser without WebHID gets the gate and no buttons", () => {
	expect(viewFor({ name: "browser-gate", why: "no-webhid" }, null)).toMatchObject({ title: "Use Chrome or Edge", actions: [] });
});

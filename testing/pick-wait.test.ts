import { expect, test } from "bun:test";
import type { DeviceWant } from "../core/port";
import { showParkedPick } from "../lab/pick-wait";
import { pickHint } from "../lab/u1-state";
import type { Chooser } from "../web/webhid-port";

function fakeChooser() {
	let needsClick: DeviceWant | null = null;
	const listeners: (() => void)[] = [];
	let picks = 0;
	const chooser: Chooser = {
		get needsClick() {
			return needsClick;
		},
		pick: () => {
			picks += 1;
			needsClick = null;
			for (const listener of listeners) listener();
		},
		subscribe: (listener) => {
			listeners.push(listener);
			return () => undefined;
		},
	};
	const park = (want: DeviceWant) => {
		needsClick = want;
		for (const listener of listeners) listener();
	};
	return { chooser, park, picks: () => picks };
}

function page() {
	let click = () => {};
	let focused = 0;
	const pick = {
		hidden: true,
		style: { fontWeight: "", fontSize: "" },
		focus: () => {
			focused += 1;
		},
		addEventListener: (_: "click", listener: () => void) => {
			click = listener;
		},
	};
	return { pick, summary: { textContent: "Running..." as string | null }, click: () => click(), focused: () => focused };
}

test("a parked pick replaces Running... with what to click and shows a large, focused Pick; the pick restores Running...", () => {
	const { chooser, park, picks } = fakeChooser();
	const ui = page();
	showParkedPick(chooser, ui.pick, ui.summary);
	expect(ui.pick.style).toEqual({ fontWeight: "bold", fontSize: "1.25em" });

	park({ modes: ["iap"], reason: "enter-update-mode" });
	expect(ui.pick.hidden).toBe(false);
	expect(ui.summary.textContent).toBe("Waiting for you: click Pick the TAB 60, then choose USB-HID IAP.");
	expect(ui.focused()).toBe(1);

	ui.click();
	expect(picks()).toBe(1);
	expect(ui.pick.hidden).toBe(true);
	expect(ui.summary.textContent).toBe("Running...");

	park({ modes: ["app", "iap"], reason: "after-link-loss" });
	expect(ui.summary.textContent).toBe("Waiting for you: click Pick the TAB 60, then choose USB-HID Keyboard or USB-HID IAP.");
});

test("a run that writes its own summary while a pick is parked keeps it after the pick", () => {
	const { chooser, park } = fakeChooser();
	const ui = page();
	showParkedPick(chooser, ui.pick, ui.summary);
	park({ modes: ["app"], reason: "confirm-normal-mode" });
	ui.summary.textContent = "FAIL: the pick was cancelled";
	ui.click();
	expect(ui.summary.textContent).toBe("FAIL: the pick was cancelled");
});

test("the U1 page's hint next to Pick says the run waits for the user", () => {
	expect(pickHint(null)).toBeNull();
	expect(pickHint({ modes: ["iap"], reason: "enter-update-mode" })).toBe("Waiting for you: click Pick and choose USB-HID IAP.");
});

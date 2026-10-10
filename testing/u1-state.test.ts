import { expect, test } from "bun:test";
import { atLoad, awayFromHome } from "../lab/u1-state";
import { TARGET } from "./fake-run";
import { type FakeOptions, FakeTab60 } from "./fake-tab60";
import { FakeHid } from "./fake-webhid";
import type { TranscriptEntry } from "./transcript";

const at = () => 7;

function hidAtLoad(starting: FakeOptions["starting"], granted: boolean): FakeHid {
	const hid = new FakeHid(new FakeTab60({ starting, target: TARGET }), { rowAppearsInOpenChooser: [] });
	if (granted) hid.grant();
	return hid;
}

test("a page that loads with the bootloader granted starts away, and with the keyboard granted or nothing starts idle", async () => {
	expect(await atLoad(hidAtLoad("update-mode-official-image", true), at)).toEqual({
		entries: [{ t: 7, kind: "granted", productId: 0x1304 }],
		phase: { kind: "away", holding: null },
	});
	expect(await atLoad(hidAtLoad("official-image", true), at)).toEqual({ entries: [{ t: 7, kind: "granted", productId: 0x0304 }], phase: { kind: "idle" } });
	expect(await atLoad(hidAtLoad("update-mode-official-image", false), at)).toEqual({ entries: [], phase: { kind: "idle" } });
});

test("a grant for another vendor's device or an unknown product records nothing", async () => {
	const others = { getDevices: async () => [{ vendorId: 0x1234, productId: 0x1304 }, { vendorId: 0x04d9, productId: 0x9999 }] };
	expect(await atLoad(others, at)).toEqual({ entries: [], phase: { kind: "idle" } });
});

test("a bootloader granted at load counts as away until a normal-mode link opens", () => {
	const granted: TranscriptEntry = { t: 0, kind: "granted", productId: 0x1304 };
	const opened: TranscriptEntry = { t: 1, kind: "opened", reason: "connect", productId: 0x0304, productName: "USB-HID Keyboard", collections: [] };
	expect([awayFromHome([granted]), awayFromHome([granted, opened])]).toEqual([true, false]);
});

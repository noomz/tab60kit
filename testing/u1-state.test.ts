import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeviceWant, Link } from "../core/port";
import { u1Wrap } from "../lab/u1-frames";
import { type U1Context, u1Clearance, u1Connect, u1DeepCheck, u1Run } from "../lab/u1-job";
import {
	PRECONDITIONS,
	type Phase,
	type PreconditionKey,
	atLoad,
	awayFromHome,
	cancelLabel,
	deepCheckEnabled,
	preconditionChange,
	preconditionEnvironment,
	preconditionsLocked,
	showsRecovery,
	unmetPreconditions,
	updateModeLinkOpen,
} from "../lab/u1-state";
import { startWebHidLab } from "../web/webhid-port";
import { TARGET, recordFakeRun } from "./fake-run";
import { type FakeOptions, FakeTab60 } from "./fake-tab60";
import { FakeHid, FakeLocks } from "./fake-webhid";
import { type TranscriptEntry, parseTranscript } from "./transcript";

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

const HOME_LABEL = "Stop and send the board home";
const keyboard = { productName: "USB-HID Keyboard", collections: [] };

const keyboardClosesLate = (link: Link): Link => ({
	mode: link.mode,
	lost: link.lost,
	send: (frame) => link.send(frame),
	next: (timeoutMs) => link.next(timeoutMs),
	discardPending: () => link.discardPending(),
	close: async () => {
		await link.close();
		if (link.mode === "app") await new Promise((resolve) => setTimeout(resolve, 30));
	},
});

for (const [order, closesLate, inner] of [
	["before", false, {}],
	["after", true, { inner: keyboardClosesLate }],
] as const) {
	test(`Cancel offers to send the board home from the update-mode open until that link closes after RESET to app, when the keyboard link closes ${order} the bootloader opens`, async () => {
		const { entries } = (await recordFakeRun({ series: { probes: 3, everyMs: 1 }, ...inner })).transcript;
		const bootloader = entries.findIndex((entry) => entry.kind === "opened" && entry.productId === 0x1304);
		const keyboardClosed = entries.findIndex((entry) => entry.kind === "closed");
		expect(entries[keyboardClosed]).toMatchObject({ kind: "closed", mode: "app" });
		expect(keyboardClosed > bootloader).toBe(closesLate);
		const sendsHome = entries.map((_, i) => cancelLabel(entries.slice(0, i + 1)) === HOME_LABEL);
		const first = sendsHome.indexOf(true);
		const last = sendsHome.lastIndexOf(true);
		expect(first).toBe(bootloader);
		expect(entries[last]).toMatchObject({ kind: "out", hex: expect.stringMatching(/^1101/) });
		expect(entries[last + 1]).toMatchObject({ kind: "closed", mode: "iap" });
		expect(sendsHome.filter(Boolean)).toHaveLength(last - first + 1);
		const resetToIap = entries.findIndex((entry) => entry.kind === "out" && entry.hex.startsWith("1100"));
		expect(cancelLabel(entries.slice(0, resetToIap + 1))).toBe("Stop");
	});
}

test("an update-mode link counts as open until its own close or loss, or another open, and an untagged close ends it", () => {
	const bootloader: TranscriptEntry = { t: 0, kind: "opened", reason: "enter-update-mode", productId: 0x1304, ...keyboard };
	const app: TranscriptEntry = { t: 1, kind: "opened", reason: "confirm-normal-mode", productId: 0x0304, ...keyboard };
	expect([
		updateModeLinkOpen([bootloader]),
		updateModeLinkOpen([bootloader, { t: 1, kind: "closed", mode: "iap" }]),
		updateModeLinkOpen([bootloader, { t: 1, kind: "lost", mode: "iap" }]),
		updateModeLinkOpen([bootloader, { t: 1, kind: "closed", mode: "app" }]),
		updateModeLinkOpen([bootloader, { t: 1, kind: "lost", mode: "app" }]),
		updateModeLinkOpen([bootloader, { t: 1, kind: "closed" }]),
		updateModeLinkOpen([bootloader, app]),
	]).toEqual([true, false, false, true, true, false, false]);
});

test("the recovery text shows while a Deep check waits on a parked confirm pick", async () => {
	const board = new FakeTab60({ starting: "official-image", target: TARGET, reenumerateAfterMs: 50 });
	const hid = new FakeHid(board, { rowAppearsInOpenChooser: ["iap"], isActive: () => true });
	const entries: TranscriptEntry[] = [];
	const { port, chooser } = startWebHidLab(hid, new FakeLocks(), { wrap: u1Wrap((entry) => entries.push(entry)), onEvent: (event) => entries.push({ t: 0, ...event }) });
	const running: Phase = { kind: "running", what: "deep-check" };
	const seen: string[] = [];
	const user = setInterval(() => {
		const want = chooser.needsClick;
		if (want === null || !want.modes.includes(hid.device.mode)) return;
		seen.push(`${want.reason}: ${showsRecovery(running, want, entries)}`);
		chooser.pick();
	}, 1);
	try {
		const ctx: U1Context = { port, clearance: u1Clearance(), signal: new AbortController().signal, log: () => undefined, series: { probes: 2, everyMs: 1 } };
		const connected = await u1Connect(ctx);
		if (connected.kind !== "connected") throw new Error("normal mode refused");
		const end = await u1DeepCheck(connected.session, ctx);
		if (end.kind !== "done" || end.back === null || "refusal" in end.back) throw new Error("the round trip did not come home");
		await end.back.close();
	} finally {
		clearInterval(user);
	}
	expect(seen).toEqual(["confirm-normal-mode: true"]);
});

test("the recovery text shows for an away page, and for a run only while a pick is parked and the board may be away", () => {
	const resetToIap: TranscriptEntry = { t: 0, kind: "out", hex: "1100".padEnd(128, "0") };
	const home: TranscriptEntry = { t: 1, kind: "opened", reason: "confirm-normal-mode", productId: 0x0304, ...keyboard };
	const want: DeviceWant = { modes: ["app"], reason: "confirm-normal-mode" };
	const running: Phase = { kind: "running", what: "deep-check" };
	expect([
		showsRecovery({ kind: "away", holding: null }, null, []),
		showsRecovery(running, want, [resetToIap]),
		showsRecovery(running, null, [resetToIap]),
		showsRecovery(running, want, [resetToIap, home]),
	]).toEqual([true, true, false, false]);
});

test("the precondition boxes lock when the first frame goes out: tick all three, Connect, and an untick changes nothing", async () => {
	const entries: TranscriptEntry[] = [];
	const tick = (key: PreconditionKey, met: boolean) => {
		const change = preconditionChange(entries, key, met, entries.length);
		if (change !== null) entries.push(change);
		return change;
	};
	for (const { key } of PRECONDITIONS) tick(key, true);
	expect(tick("cableIn", false)).toMatchObject({ kind: "precondition", key: "cableIn", met: false });
	tick("cableIn", true);
	const hid = new FakeHid(new FakeTab60({ starting: "official-image", target: TARGET }), { rowAppearsInOpenChooser: ["app"], isActive: () => true });
	const { port } = startWebHidLab(hid, new FakeLocks(), { wrap: u1Wrap((entry) => entries.push(entry)), onEvent: (event) => entries.push({ t: 0, ...event }) });
	const ctx: U1Context = { port, clearance: u1Clearance(), signal: new AbortController().signal, log: () => undefined, series: { probes: 2, everyMs: 1 } };
	const connected = await u1Run("connect", { kind: "idle" }, ctx);
	if (connected.kind !== "connected") throw new Error("normal mode refused");
	expect(preconditionsLocked(entries)).toBe(true);
	expect(tick("karabinerLedOff", false)).toBeNull();
	await connected.app.close();
	expect(entries.filter((entry) => entry.kind === "precondition")).toHaveLength(5);
	const environment = preconditionEnvironment(entries);
	expect(environment).toEqual({ cableIn: "yes", karabinerLedOff: "yes", secondKeyboardAtHand: "yes" });
	expect(unmetPreconditions({ environment, entries })).toEqual([]);
});

test("Deep check is enabled only on a connected page whose three boxes were ticked when they locked, and only until an 11 00 goes out", () => {
	const box = (key: PreconditionKey, met: boolean): TranscriptEntry => ({ t: 0, kind: "precondition", key, met });
	const out = (prefix: string): TranscriptEntry => ({ t: 1, kind: "out", hex: prefix.padEnd(128, "0") });
	const three = PRECONDITIONS.map(({ key }) => box(key, true));
	const frames: Readonly<Record<string, readonly TranscriptEntry[]>> = { "no frame": [], "READ MODE": [out("1202")], "READ MODE then 11 00": [out("1202"), out("1100")] };
	const boxes: Readonly<Record<string, (sent: readonly TranscriptEntry[]) => readonly TranscriptEntry[]>> = {
		"no box ticked": (sent) => sent,
		"two boxes ticked": (sent) => [box("cableIn", true), box("karabinerLedOff", true), ...sent],
		"three boxes ticked, one unticked": (sent) => [...three, box("cableIn", false), ...sent],
		"three boxes ticked": (sent) => [...three, ...sent],
		"three boxes ticked after the first frame": (sent) => [...sent, ...three],
	};
	const phases: readonly Phase["kind"][] = ["idle", "running", "connected", "refused", "away", "failed"];
	const enabled: string[] = [];
	for (const phase of phases) {
		for (const [boxLabel, withBoxes] of Object.entries(boxes)) {
			for (const [frameLabel, sent] of Object.entries(frames)) if (deepCheckEnabled(phase, withBoxes(sent))) enabled.push(`${phase}, ${boxLabel}, ${frameLabel}`);
		}
	}
	expect(enabled).toEqual(["connected, three boxes ticked, READ MODE"]);
});

test("on run 3's transcript Deep check is enabled once Connect is done and disabled from the 11 00 on, so a second click cannot send another", () => {
	const { entries } = parseTranscript(JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "tab60kit-u1-2026-10-12T09-07-15-464Z.json"), "utf8")));
	const resetToIap = entries.findIndex((entry) => entry.kind === "out" && entry.hex.startsWith("1100"));
	expect([deepCheckEnabled("connected", entries.slice(0, resetToIap)), deepCheckEnabled("connected", entries)]).toEqual([true, false]);
});

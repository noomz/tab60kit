import { expect, test } from "bun:test";
import { FakeTab60, type Socket, bytesSummingTo, syntheticVersionBlock } from "./fake-tab60";
import { BL_INFO_HEX } from "./fixtures";
import { fromHex, toHex } from "./scripted";

const target = { imageBytes: 34_268, wireSum32: 0xf3d3dbd2 };
const frame = (hex: string) => fromHex(hex.padEnd(128, "0"));

function tap(board: FakeTab60) {
	const reports: string[] = [];
	let detached = 0;
	const socket: Socket = { report: (bytes) => reports.push(toHex(bytes)), detached: () => detached++ };
	const plug = board.plug(socket);
	const ask = async (hex: string) => {
		const before = reports.length;
		plug.send(frame(hex));
		await new Promise((resolve) => setTimeout(resolve, 5));
		return reports.slice(before);
	};
	return { ask, reports, detached: () => detached };
}

test("normal mode answers the reads docs/app-firmware.md lists and echoes bytes 2..3", async () => {
	const board = new FakeTab60({ starting: "official-image", target });
	const { ask } = tap(board);
	expect(await ask("1202beef")).toEqual(["1202beef01".padEnd(128, "0")]);
	expect(await ask("12000000")).toEqual(["12000000" + BL_INFO_HEX]);
	let page = "";
	for (const part of [0, 1, 2]) page += (await ask(`122${part}0000`))[0]?.slice(8) ?? "";
	expect(page).toBe(toHex(syntheticVersionBlock()));
	expect((await ask("12270000"))[0]?.slice(0, 4)).toBe("1227");
	expect(board.violations).toEqual([]);
});

test("normal mode refuses update-mode commands with FF AA and records the violation", async () => {
	const board = new FakeTab60({ starting: "official-image", target });
	const { ask } = tap(board);
	expect(await ask("1d010000" + "00020000dc850000")).toEqual(["ffaa00001d01".padEnd(128, "0")]);
	expect(await ask("12010000")).toEqual(["ffaa00001201".padEnd(128, "0")]);
	expect(board.violations).toEqual([
		{ kind: "wrong-mode", cmd: 0x1d, sub: 0x01, mode: "app" },
		{ kind: "wrong-mode", cmd: 0x12, sub: 0x01, mode: "app" },
	]);
});

test("RESET to IAP detaches the plug, flips the mode, and resolves a waiting open", async () => {
	const board = new FakeTab60({ starting: "official-image", target });
	const modes: string[] = [];
	board.onEnumerate((mode) => modes.push(mode));
	const waiting = board.whenIn(["iap"], new AbortController().signal).then(() => "arrived");
	const { ask, detached } = tap(board);
	expect(await ask("11000000")).toEqual([]);
	expect(detached()).toBe(1);
	expect(board.mode).toBe("iap");
	expect(modes).toEqual(["iap"]);
	expect(await waiting).toBe("arrived");
});

test("update mode answers FW INFO, the version page parts 0..2 only, and SUM over the stored image", async () => {
	const board = new FakeTab60({ starting: "update-mode-erased", target });
	const { ask } = tap(board);
	expect(await ask("12020000")).toEqual(["1202000000".padEnd(128, "0")]);
	expect(await ask("12010000")).toEqual(["1201000004000200".padEnd(128, "0")]);
	expect((await ask("12220000"))[0]?.slice(0, 4)).toBe("1222");
	expect((await ask("12230000"))[0]?.slice(0, 4)).toBe("ffaa");
	expect(await ask("1d010000" + "00020000dc850000")).toEqual(["1d010000" + "d2dbd3f3".padEnd(120, "0")]);
	expect((await ask("1d010000" + "00ce0100" + "02000000"))[0]?.slice(0, 4)).toBe("ffaa");
	expect(board.violations).toEqual([
		{ kind: "wrong-mode", cmd: 0x12, sub: 0x23, mode: "iap" },
		{ kind: "outside-window", cmd: 0x1d, offset: 0x1ce00, length: 2 },
	]);
});

test("RESET to app boots the app only over a page with its magic", async () => {
	const erased = new FakeTab60({ starting: "update-mode-erased", target });
	await tap(erased).ask("11010000");
	expect(erased.mode).toBe("iap");
	const partial = new FakeTab60({ starting: "update-mode-partial-version-block", target });
	await tap(partial).ask("11010000");
	expect(partial.mode).toBe("iap");
	const whole = new FakeTab60({ starting: "official-image", target });
	await tap(whole).ask("11000000");
	await tap(whole).ask("11010000");
	expect(whole.mode).toBe("app");
});

test("refuseOnce answers FF AA once, and a deaf bootloader answers nothing", async () => {
	const board = new FakeTab60({ starting: "update-mode-erased", target, refuseOnce: { cmd: 0x12, sub: 0x01 } });
	const { ask } = tap(board);
	expect((await ask("12010000"))[0]?.slice(0, 4)).toBe("ffaa");
	expect((await ask("12010000"))[0]?.slice(0, 4)).toBe("1201");
	board.ignoreInIap = true;
	expect(await ask("12020000")).toEqual([]);
});

test("slowOnce answers one matching command late, after answering its skip count on time", async () => {
	const board = new FakeTab60({ starting: "update-mode-erased", target, slowOnce: { cmd: 0x12, sub: 0x02, mode: "iap", ms: 30, skip: 1 } });
	const { ask, reports } = tap(board);
	expect(await ask("12020000")).toHaveLength(1);
	expect(await ask("12020000")).toEqual([]);
	await new Promise((resolve) => setTimeout(resolve, 40));
	expect(reports.at(-1)?.slice(0, 10)).toBe("1202000000");
	expect(await ask("12020000")).toHaveLength(1);
});

test("a lost link re-enumerates in the same mode, or where the IAP boots when the MCU also resets", async () => {
	for (const [resetOnLoss, after] of [[false, "iap"], [true, "app"]] as const) {
		const board = new FakeTab60({ starting: "official-image", target, loseLinkAtPacket: 1, resetOnLoss });
		const modes: string[] = [];
		board.onEnumerate((mode) => modes.push(mode));
		await tap(board).ask("11000000");
		const { ask, detached } = tap(board);
		expect(await ask("12020000")).toEqual([]);
		expect(detached()).toBe(1);
		expect(modes).toEqual(["iap", after]);
	}
});

test("the synthetic image sums to the target and the untrusted one does not", () => {
	const view = (bytes: Uint8Array) => new DataView(bytes.buffer);
	let sum = 0;
	const official = bytesSummingTo(target.imageBytes, target.wireSum32);
	for (let at = 0; at < official.length; at += 4) sum = (sum + view(official).getUint32(at, true)) >>> 0;
	expect(sum).toBe(target.wireSum32);
	expect(() => bytesSummingTo(6, 1)).toThrow(RangeError);
});

const u32 = (n: number) => toHex(Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24));
const erase = (offset: number, length: number) => `1d000000${u32(offset)}${u32(length)}`;
const setAddress = (offset: number) => `1e010000${u32(offset)}`;
const write = (payload: Uint8Array) => `1f${payload.length.toString(16).padStart(2, "0")}0000${toHex(payload)}`;
const WINDOW = 0xe7 * 0x200;

test("one ERASE over the whole window changes app pages under a valid page, in the default descending order", async () => {
	const board = new FakeTab60({ starting: "update-mode-official-image", target });
	expect(await tap(board).ask(erase(0, WINDOW))).toEqual(["1d000000".padEnd(128, "0")]);
	expect(board.violations[0]).toEqual({ kind: "app-changed-under-valid-page", page: 0xe6 });
	expect(board.violations).toHaveLength(0xe6);
	const ascending = new FakeTab60({ starting: "update-mode-official-image", target, eraseOrder: "ascending" });
	await tap(ascending).ask(erase(0, WINDOW));
	expect(ascending.violations).toEqual([]);
});

test("the version page erased by its own command first leaves no violation, and both erases leave 0xFF", async () => {
	const board = new FakeTab60({ starting: "update-mode-official-image", target });
	const { ask } = tap(board);
	await ask(erase(0, 0x200));
	await ask(erase(0x200, WINDOW - 0x200));
	expect(board.violations).toEqual([]);
	expect(await board.bootTarget()).toEqual({ mode: "iap", versionPageSha256: "erased" });
	expect(await ask(`1d010000${u32(0x200)}${u32(8)}`)).toEqual([`1d010000${u32(0xfffffffe)}`.padEnd(128, "0")]);
});

test("WRITE lands at the address, acks with the next one, and clears bits only", async () => {
	const board = new FakeTab60({ starting: "update-mode-erased", target });
	const { ask } = tap(board);
	expect((await ask(write(Uint8Array.of(1))))[0]?.slice(0, 4)).toBe("ffaa");
	expect(await ask(setAddress(0x10))).toEqual(["1e010000".padEnd(128, "0")]);
	expect(await ask(write(Uint8Array.of(0x0f, 0xf0)))).toEqual([`1e020000${u32(0x12)}`.padEnd(128, "0")]);
	await ask(setAddress(0x10));
	await ask(write(Uint8Array.of(0xff, 0x0f)));
	let page = "";
	for (const part of [0, 1, 2]) page += (await ask(`122${part}0000`))[0]?.slice(8) ?? "";
	expect(page.slice(0x20, 0x24)).toBe("0f00");
	expect((await ask(setAddress(WINDOW)))[0]?.slice(0, 4)).toBe("ffaa");
	expect(board.violations).toEqual([{ kind: "outside-window", cmd: 0x1e, offset: WINDOW, length: 1 }]);
});

test("get write address answers the cursor in bytes 4..7, all ones before any set, and moves nothing", async () => {
	const board = new FakeTab60({ starting: "update-mode-erased", target });
	const { ask } = tap(board);
	const get = `1e000000${u32(0xffffffff)}`;
	expect(await ask(get)).toEqual([`1e000000${u32(0xffffffff)}`.padEnd(128, "0")]);
	await ask(setAddress(0x200));
	expect(await ask(get)).toEqual([`1e000000${u32(0x200)}`.padEnd(128, "0")]);
	expect(await ask(write(Uint8Array.of(0)))).toEqual([`1e020000${u32(0x201)}`.padEnd(128, "0")]);
	expect(board.violations).toEqual([]);
});

test("cursorFault misreports the chosen get write address answers by one word, and only those", async () => {
	const board = new FakeTab60({ starting: "update-mode-erased", target, cursorFault: { at: 1, times: 2 } });
	const { ask } = tap(board);
	await ask(setAddress(0x200));
	const got = [];
	for (let i = 0; i < 4; i++) got.push((await ask(`1e000000${u32(0xffffffff)}`))[0]?.slice(8, 16));
	expect(got).toEqual([u32(0x200), u32(0x204), u32(0x204), u32(0x200)]);
});

test("writeFault: no-reply writes nothing, mute writes and stays silent, wrong-next writes and acks one word too far", async () => {
	for (const [kind, reply, cursorAfter] of [
		["no-reply", [], 0x200],
		["mute", [], 0x201],
		["wrong-next", [`1e020000${u32(0x205)}`.padEnd(128, "0")], 0x201],
	] as const) {
		const board = new FakeTab60({ starting: "update-mode-erased", target, writeFault: { at: 1, times: 1, kind } });
		const { ask } = tap(board);
		await ask(setAddress(0x1ff));
		expect(await ask(write(Uint8Array.of(0)))).toEqual([`1e020000${u32(0x200)}`.padEnd(128, "0")]);
		expect(await ask(write(Uint8Array.of(0)))).toEqual([...reply]);
		expect((await ask(`1e000000${u32(0xffffffff)}`))[0]?.slice(8, 16)).toBe(u32(cursorAfter));
	}
});

test("offsetErase refuses an ERASE that starts past 0, by marker or by silence, and erases nothing; offset 0 still erases", async () => {
	const marker = new FakeTab60({ starting: "update-mode-official-image", target, offsetErase: "error-marker" });
	const asked = tap(marker);
	expect(await asked.ask(erase(0x200, WINDOW - 0x200))).toEqual([`ffaa00001d000000`.padEnd(128, "0")]);
	expect(await marker.bootTarget()).not.toEqual({ mode: "iap", versionPageSha256: "erased" });
	expect(await asked.ask(erase(0, 0x200))).toEqual(["1d000000".padEnd(128, "0")]);
	expect(await asked.ask(erase(0, WINDOW))).toEqual(["1d000000".padEnd(128, "0")]);
	expect(await asked.ask(`1d010000${u32(0x200)}${u32(8)}`)).toEqual([`1d010000${u32(0xfffffffe)}`.padEnd(128, "0")]);
	expect(marker.violations).toEqual([]);
	const silent = new FakeTab60({ starting: "update-mode-official-image", target, offsetErase: "silent" });
	expect(await tap(silent).ask(erase(0x200, WINDOW - 0x200))).toEqual([]);
	expect((await silent.bootTarget()).mode).toBe("app");
});

test("a version block written over an image that does not sum to the target is a violation once its magic lands", async () => {
	const block = syntheticVersionBlock();
	for (const [starting, want] of [
		["update-mode-erased", []],
		["update-mode-partial-version-block", [{ kind: "version-block-before-verified-image" }]],
	] as const) {
		const board = new FakeTab60({ starting, target });
		const { ask } = tap(board);
		if (starting === "update-mode-partial-version-block") {
			await ask(erase(0, 0x200));
			await ask(erase(0x200, WINDOW - 0x200));
		}
		await ask(setAddress(0));
		for (let at = 0; at < block.length; at += 52) await ask(write(block.subarray(at, at + 52)));
		expect(board.violations).toEqual(want);
	}
});

test("writing an app page while the version page is valid is a violation", async () => {
	const board = new FakeTab60({ starting: "update-mode-official-image", target });
	const { ask } = tap(board);
	await ask(setAddress(0x200));
	await ask(write(Uint8Array.of(0)));
	expect(board.violations).toEqual([{ kind: "app-changed-under-valid-page", page: 1 }]);
});

test("bootTarget hashes the 180-byte version block and names the IAP's next choice", async () => {
	const board = new FakeTab60({ starting: "official-image", target });
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(syntheticVersionBlock())));
	expect(await board.bootTarget()).toEqual({ mode: "app", versionPageSha256: toHex(digest) as never });
});

test("the virtual clock: sleeps cost no wall time, a late answer advances to it, and a slower one times out", async () => {
	const board = new FakeTab60({ starting: "update-mode-erased", target, clock: "virtual", slowOnce: { cmd: 0x12, sub: 0x02, mode: "iap", ms: 300, skip: 1 } });
	const port = board.port();
	await port.clock.sleep(15_000, new AbortController().signal);
	expect(port.clock.now()).toBe(15_000);
	const link = await port.open({ modes: ["iap"], reason: "connect" }, new AbortController().signal);
	const ask = async (timeoutMs: number) => {
		await link.send(frame("12020000") as never);
		return link.next(timeoutMs);
	};
	expect(toHex(await ask(1_000)).slice(0, 4)).toBe("1202");
	expect(toHex(await ask(1_000)).slice(0, 4)).toBe("1202");
	// Each command costs 1 ms of virtual time, then the late answer adds its 300 ms.
	expect(port.clock.now()).toBe(15_302);
	board.ignoreInIap = true;
	await expect(ask(1_000)).rejects.toThrow("no input report within 1000 ms");
	expect(port.clock.now()).toBe(16_303);
	expect(board.received.map((r) => r.t)).toEqual([15_000, 15_001, 15_302]);
	expect(board.received.every((r) => r.mode === "iap")).toBe(true);
});

test("loseLinkAfterPacket executes the command and loses the link before the reply", async () => {
	const board = new FakeTab60({ starting: "update-mode-official-image", target, loseLinkAfterPacket: 0 });
	const { ask, detached } = tap(board);
	expect(await ask(erase(0, 0x200))).toEqual([]);
	expect(detached()).toBe(1);
	expect(await board.bootTarget()).toEqual({ mode: "iap", versionPageSha256: "erased" });
});

test("refuseAlways refuses every matching command and leaves flash alone", async () => {
	const board = new FakeTab60({ starting: "update-mode-official-image", target, refuseAlways: { cmd: 0x1d, sub: 0x00 } });
	const { ask } = tap(board);
	for (let i = 0; i < 3; i++) expect((await ask(erase(0, 0x200)))[0]?.slice(0, 4)).toBe("ffaa");
	expect((await board.bootTarget()).mode).toBe("app");
});

test("update-mode-damaged-image holds a valid page over an image that misses the target sum", async () => {
	const board = new FakeTab60({ starting: "update-mode-damaged-image", target });
	const { ask } = tap(board);
	expect(board.mode).toBe("iap");
	expect((await board.bootTarget()).mode).toBe("app");
	expect(await ask(`1d010000${u32(0x200)}${u32(target.imageBytes)}`)).not.toEqual([`1d010000${u32(target.wireSum32)}`.padEnd(128, "0")]);
});

const word = (w: number) => (w & 0xff).toString(16).padStart(2, "0") + (w >>> 8).toString(16).padStart(2, "0");
const F = word(0x00ff);
const A = word(0x0003);

test("a store as the reset leaves it answers 0x52/0x21 on layer 0 with 0x00FF for usages in the active keymap and 0x0003 for the rest", async () => {
	const board = new FakeTab60({ starting: "official-image", target });
	const { ask } = tap(board);
	expect(await ask("52210000")).toEqual([`52210000${F}${A}${A}${A}${F.repeat(12)}`.padEnd(128, "0")]);
	expect(await ask("52210d00")).toEqual([`52210d00${A.repeat(8)}${F}${F}${A.repeat(6)}`.padEnd(128, "0")]);
	expect(await ask("52211300")).toEqual([`52211300${F.repeat(10)}${A.repeat(6)}`.padEnd(128, "0")]);
	expect(board.violations).toEqual([]);
});

test("0x52/0x20 reads one entry of layers 0 to 2, layer 2 holds the factory pairs, and the Fn and Pn markers replace the ROM usages 0xE7 and 0x65", async () => {
	const board = new FakeTab60({ starting: "official-image", target });
	const { ask } = tap(board);
	const entry = async (arg: string) => (await ask(`5220${arg}`))[0]?.slice(0, 12);
	const read: (string | undefined)[] = [];
	for (const arg of ["0402", "d800", "d902", "e700", "6501", "e800"]) read.push(await entry(arg));
	expect(read).toEqual([
		`52200402${word(0x0192)}`,
		`5220d800${F}`,
		`5220d902${F}`,
		`5220e700${A}`,
		`52206501${A}`,
		`5220e800${A}`,
	]);
});

test("in OS key mode 0x20 Alt and GUI swap, 0xE6 gives way to the Fn marker, and layer 2 reads the factory entry of the swapped cell", async () => {
	const board = new FakeTab60({ starting: "official-image", target, osKeyMode: 0x20 });
	const { ask } = tap(board);
	const entry = async (arg: string) => (await ask(`5220${arg}`))[0]?.slice(8, 12);
	const read: (string | undefined)[] = [];
	for (const arg of ["e600", "e700", "e202", "e302", "2902"]) read.push(await entry(arg));
	expect(read).toEqual([A, F, word(0x0160), word(0x0130), word(0x0170)]);
});

test("an argument past the read's bound gets the error marker with the request's bytes 0..3", async () => {
	const board = new FakeTab60({ starting: "official-image", target });
	const { ask } = tap(board);
	expect(await ask("52214000")).toEqual(["ffaa000052214000".padEnd(128, "0")]);
	expect(await ask("52200003")).toEqual(["ffaa000052200003".padEnd(128, "0")]);
	expect(await ask("52213f00")).toEqual([`52213f00${A.repeat(16)}`.padEnd(128, "0")]);
});

test("a seeded override reads as flags << 8 | usage on its layer only", async () => {
	const board = new FakeTab60({ starting: "official-image", target, overrides: [{ layer: 1, cell: 5, usage: 0x29, flags: 2 }] });
	const { ask } = tap(board);
	expect((await ask("52200401"))[0]?.slice(0, 12)).toBe(`52200401${word(0x0229)}`);
	expect((await ask("52200400"))[0]?.slice(0, 12)).toBe(`52200400${F}`);
	expect((await ask("52210000"))[0]?.slice(8, 28)).toBe(`${F}${A}${A}${A}${F}`);
});

const capsLockToCtrl = "51203900e000";
const capsLockDefault = "51203900ff00";

test("the gate boots closed: a query reads 41 00 00 00 and every 0x51 frame gets the error marker without writing", async () => {
	const board = new FakeTab60({ starting: "official-image", target });
	const { ask } = tap(board);
	expect(await ask("41ff0000")).toEqual(["41000000".padEnd(128, "0")]);
	expect(await ask(capsLockToCtrl)).toEqual(["ffaa000051203900".padEnd(128, "0")]);
	expect(await ask("51210000")).toEqual(["ffaa000051210000".padEnd(128, "0")]);
	expect(await ask("52203900")).toEqual(["52203900ff00".padEnd(128, "0")]);
	expect(board.baseLayerPress(4)).toBe(0x39);
	expect(board.violations).toEqual([]);
});

test("41 80 opens the gate with an echo, the query reports 0x80, and 41 00 closes it again", async () => {
	const board = new FakeTab60({ starting: "official-image", target });
	const { ask } = tap(board);
	expect(await ask("41800000")).toEqual(["41800000".padEnd(128, "0")]);
	expect(await ask("41ff0000")).toEqual(["41800000".padEnd(128, "0")]);
	expect(await ask("41000000")).toEqual(["41000000".padEnd(128, "0")]);
	expect(await ask("41ff0000")).toEqual(["41000000".padEnd(128, "0")]);
	expect(board.violations).toEqual([]);
});

test("under an open gate 0x51/0x20 writes the RAM store, replies with the read-back, and a close keeps the write", async () => {
	const board = new FakeTab60({ starting: "official-image", target });
	const { ask } = tap(board);
	await ask("41800000");
	expect(await ask(capsLockToCtrl)).toEqual(["51203900e000".padEnd(128, "0")]);
	expect(await ask("52203900")).toEqual(["52203900e000".padEnd(128, "0")]);
	expect(board.baseLayerPress(4)).toBe(0xe0);
	await ask("41000000");
	expect(await ask("52203900")).toEqual(["52203900e000".padEnd(128, "0")]);
	await ask("41800000");
	expect(await ask(capsLockDefault)).toEqual(["51203900ff00".padEnd(128, "0")]);
	expect(await ask("52203900")).toEqual(["52203900ff00".padEnd(128, "0")]);
	expect(board.baseLayerPress(4)).toBe(0x39);
	expect(board.violations).toEqual([]);
});

test("a key write the board's bounds refuse, or for a usage no key holds, gets the error marker and changes nothing", async () => {
	const board = new FakeTab60({ starting: "official-image", target });
	const { ask } = tap(board);
	await ask("41800000");
	expect(await ask("51200300e000")).toEqual(["ffaa000051200300".padEnd(128, "0")]);
	expect(await ask("51203903e000")).toEqual(["ffaa000051203903".padEnd(128, "0")]);
	expect(await ask("512039000300")).toEqual(["ffaa000051203900".padEnd(128, "0")]);
	expect(await ask("52203900")).toEqual(["52203900ff00".padEnd(128, "0")]);
	expect(board.violations).toEqual([]);
});

test("a power cycle drops the unsaved write, closes the gate, and boot reads the saved store back", async () => {
	const board = new FakeTab60({ starting: "official-image", target, overrides: [{ layer: 1, cell: 5, usage: 0x29, flags: 0 }] });
	const before = tap(board);
	await before.ask("41800000");
	await before.ask(capsLockToCtrl);
	await before.ask("51200401e100");
	expect(await before.ask("52200401")).toEqual(["52200401e100".padEnd(128, "0")]);
	expect(board.baseLayerPress(4)).toBe(0xe0);
	board.powerCycle();
	expect(before.detached()).toBe(1);
	await board.whenIn(["app"], new AbortController().signal);
	const after = tap(board);
	expect(await after.ask("41ff0000")).toEqual(["41000000".padEnd(128, "0")]);
	expect(await after.ask("52203900")).toEqual(["52203900ff00".padEnd(128, "0")]);
	expect(await after.ask("52200401")).toEqual(["522004012900".padEnd(128, "0")]);
	expect(board.baseLayerPress(4)).toBe(0x39);
	expect(await after.ask(capsLockToCtrl)).toEqual(["ffaa000051203900".padEnd(128, "0")]);
});

test("leaving config mode (gate bit 0) reloads the saved store, and the frames the U11 ruling forbids are recorded", async () => {
	const board = new FakeTab60({ starting: "official-image", target });
	const { ask } = tap(board);
	expect(await ask("41010000")).toEqual(["41010000".padEnd(128, "0")]);
	await ask(capsLockToCtrl);
	expect(await ask("52203900")).toEqual(["52203900e000".padEnd(128, "0")]);
	await ask("41000000");
	expect(await ask("52203900")).toEqual(["52203900ff00".padEnd(128, "0")]);
	expect(await ask("41c00000")).toEqual([]);
	expect(await ask("51203900e001")).toEqual([]);
	expect(board.baseLayerPress(4)).toBeNull();
	expect(board.violations).toEqual([
		{ kind: "unsafe-config", cmd: 0x41, sub: 0x01, value: 0x01 },
		{ kind: "unsafe-config", cmd: 0x41, sub: 0xc0, value: 0xc0 },
		{ kind: "unsafe-config", cmd: 0x51, sub: 0x20, value: 0x01e0 },
	]);
});

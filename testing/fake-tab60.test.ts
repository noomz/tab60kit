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

test("normal mode answers the reads R4 lists and echoes bytes 2..3", async () => {
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
	expect(port.clock.now()).toBe(15_300);
	board.ignoreInIap = true;
	await expect(ask(1_000)).rejects.toThrow("no input report within 1000 ms");
	expect(port.clock.now()).toBe(16_300);
	expect(board.received.map((r) => r.t)).toEqual([15_000, 15_000, 15_300]);
	expect(board.received.every((r) => r.mode === "iap")).toBe(true);
});

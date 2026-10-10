import { expect, test } from "bun:test";
import { FakeTab60, type Socket, blInfoBlock, bytesSummingTo, versionBlock } from "./fake-tab60";
import { BL_INFO_HEX } from "./fixtures";
import { fromHex, toHex } from "./scripted";

const target = { imageBytes: 34_268, wireSum32: 0xf3d3dbd2 };
const frame = (hex: string) => fromHex(hex.padEnd(128, "0"));

/** Plugs into the board and collects what comes back, one microtask later. */
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
	expect(toHex(blInfoBlock())).toBe(BL_INFO_HEX.slice(0, 104));
	let page = "";
	for (const part of [0, 1, 2]) page += (await ask(`122${part}0000`))[0]?.slice(8) ?? "";
	expect(page).toBe(toHex(versionBlock()));
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
	const board = new FakeTab60({ starting: "update-mode-erased", target, fwInfo: 0x200 });
	const { ask } = tap(board);
	expect(await ask("12020000")).toEqual(["1202000000".padEnd(128, "0")]);
	expect(await ask("12010000")).toEqual(["1201000000020000".padEnd(128, "0")]);
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

test("the synthetic image sums to the target and the untrusted one does not", () => {
	const view = (bytes: Uint8Array) => new DataView(bytes.buffer);
	let sum = 0;
	const official = bytesSummingTo(target.imageBytes, target.wireSum32);
	for (let at = 0; at < official.length; at += 4) sum = (sum + view(official).getUint32(at, true)) >>> 0;
	expect(sum).toBe(target.wireSum32);
	expect(() => bytesSummingTo(6, 1)).toThrow(RangeError);
});

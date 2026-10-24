// Plan U12: the apply job on the fake board, through a shipped kit. The fake models the gate, the RAM override
// store, the saved store a power cycle reloads, and the error marker, as the U11 board run confirmed them.
import { expect, test } from "bun:test";
import { createKit } from "../core/kit";
import { type KeyId, type KeymapDoc, type Layer, type OsKeyMode, type Usage, keyId, usage } from "../core/keymap";
import type { DevicePort, Link } from "../core/port";
import { DeviceRefused, SHIPPED, connect } from "../core/protocol";
import { FakeTab60, type FakeOptions } from "./fake-tab60";
import { TARGET } from "./fake-run";

const live = new AbortController().signal;

function fake(options: Partial<FakeOptions> = {}): FakeTab60 {
	return new FakeTab60({ starting: "official-image", target: TARGET, clock: "virtual", reenumerateAfterMs: 0, ...options });
}

const base: Layer = 0;
const docOf = (keys: readonly (readonly [number, number])[], layer: Layer = base): KeymapDoc => ({
	overrides: new Map([[layer, new Map<KeyId, Usage>(keys.map(([key, to]) => [keyId(key), usage(to)]))]]),
	osMode: null,
});
/** Esc to grave, Z to Y, slash to Up, backslash to Backspace, right Ctrl to Right: the same usages in every OS key mode. */
const FIVE = [
	[0, 0x35],
	[7, 0x1c],
	[46, 0x52],
	[51, 0x2a],
	[63, 0x4f],
] as const;
const ROM_USAGE: Readonly<Record<number, number>> = { 0: 0x29, 7: 0x1d, 46: 0x38, 51: 0x31, 63: 0xe4 };
const presses = (board: FakeTab60) => FIVE.map(([cell]) => board.baseLayerPress(cell));
const pairs = (board: FakeTab60, from = 0) => board.received.slice(from).map(({ cmd, sub }) => ((cmd << 8) | sub).toString(16).padStart(4, "0"));
const count = (list: readonly string[], pair: string) => list.filter((p) => p === pair).length;
/** 59 remappable caps on layers 1 and 2. */
const LAYER_READS = 118;

async function apply(board: FakeTab60, doc: KeymapDoc, mode: OsKeyMode = "windows", port: DevicePort = board.port()) {
	const kit = createKit(port, SHIPPED);
	const from = board.received.length;
	const end = await kit.applyKeymap(doc, mode);
	return { end, sent: pairs(board, from) };
}

test("a five-key document applies in RAM: gate query and open, the reads, five writes and five read-backs, then close and a query", async () => {
	const board = fake();
	const { end, sent } = await apply(board, docOf(FIVE));
	expect(end).toMatchObject({ kind: "finished", result: { kind: "keymap-applied", writes: 5 } });
	expect(presses(board)).toEqual(FIVE.map(([, to]) => to));
	expect(sent).toEqual([
		"1202",
		"1200",
		"41ff",
		...Array<string>(16).fill("5221"),
		...Array<string>(LAYER_READS).fill("5220"),
		"4180",
		...Array<string>(5).fill("5120"),
		...Array<string>(5).fill("5220"),
		"4100",
		"41ff",
	]);
	expect(board.violations).toEqual([]);
});

test("a board that already holds the document gets no write and no gate change", async () => {
	const board = fake();
	await apply(board, docOf(FIVE));
	const { end, sent } = await apply(board, docOf(FIVE));
	expect(end).toMatchObject({ kind: "finished", result: { kind: "keymap-applied", writes: 0 } });
	expect(sent.filter((pair) => pair.startsWith("41") || pair.startsWith("51"))).toEqual(["41ff"]);
});

test("a power cycle drops the five overrides, and one Apply of the same document restores them", async () => {
	const board = fake();
	await apply(board, docOf(FIVE));
	board.powerCycle();
	expect(presses(board)).toEqual(FIVE.map(([cell]) => ROM_USAGE[cell]!));
	const { end } = await apply(board, docOf(FIVE));
	expect(end).toMatchObject({ kind: "finished", result: { kind: "keymap-applied", writes: 5 } });
	expect(presses(board)).toEqual(FIVE.map(([, to]) => to));
});

test("a key removed from the document gets 0x00FF, and the factory layer 2 function codes stay", async () => {
	const board = fake();
	await apply(board, docOf(FIVE));
	const { end, sent } = await apply(board, docOf(FIVE.slice(1)));
	expect(end).toMatchObject({ kind: "finished", result: { kind: "keymap-applied", writes: 1 } });
	expect(presses(board)).toEqual([0x29, ...FIVE.slice(1).map(([, to]) => to)]);
	expect(count(sent, "5120")).toBe(1);
	const restored = await apply(board, docOf([]));
	expect(restored.end).toMatchObject({ kind: "finished", result: { kind: "keymap-applied", writes: 4 } });
	expect(presses(board)).toEqual(FIVE.map(([cell]) => ROM_USAGE[cell]!));
	const session = await connect({ port: board.port(), clearance: SHIPPED, signal: live }, { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	expect(await session.config.readKey(2, usage(0x14), live)).toEqual({ kind: "override", code: 0x3d, flags: 1 });
	await session.close();
});

test("a plain override from before the page, on any layer, is cleared by an empty document", async () => {
	const board = fake({ overrides: [{ layer: 1, cell: 5, usage: 0x50, flags: 0 }] });
	const { end, sent } = await apply(board, docOf([]));
	expect(end).toMatchObject({ kind: "finished", result: { kind: "keymap-applied", writes: 1 } });
	expect(count(sent, "5120")).toBe(1);
});

test("a board in Mac mode refuses a Windows Apply before any gate or write frame, naming the usages that differ", async () => {
	const board = fake({ osKeyMode: 0x20 });
	const { end, sent } = await apply(board, docOf(FIVE), "windows");
	expect(end).toMatchObject({ kind: "stopped", reason: { kind: "keymap", problem: { kind: "mode-disagrees", mode: "windows", missing: [0xe6], unexpected: [0xe7] } } });
	expect(sent.filter((pair) => pair === "4180" || pair === "5120")).toEqual([]);
	expect((await apply(board, docOf(FIVE), "mac")).end).toMatchObject({ kind: "finished", result: { kind: "keymap-applied", writes: 5 } });
});

test("a refused gate open stops the job with the board's refusal and sends no write", async () => {
	const board = fake({ refuseAlways: { cmd: 0x41, sub: 0x80 } });
	const { end, sent } = await apply(board, docOf(FIVE));
	expect(end).toMatchObject({ kind: "stopped", reason: { kind: "keymap", problem: { kind: "refused" } } });
	expect(sent.slice(-1)).toEqual(["4180"]);
	expect(count(sent, "5120")).toBe(0);
});

test("a refused write stops the job; the next Apply finds the gate at 0x80, writes without opening it, and closes it", async () => {
	const board = fake({ refuseOnce: { cmd: 0x51, sub: 0x20 } });
	const first = await apply(board, docOf(FIVE));
	expect(first.end).toMatchObject({ kind: "stopped", reason: { kind: "keymap", problem: { kind: "refused" } } });
	expect(first.sent.slice(-2)).toEqual(["4180", "5120"]);
	const second = await apply(board, docOf(FIVE));
	expect(second.end).toMatchObject({ kind: "finished", result: { kind: "keymap-applied", writes: 5 } });
	expect(count(second.sent, "4180")).toBe(0);
	expect(second.sent.slice(-2)).toEqual(["4100", "41ff"]);
	expect(presses(board)).toEqual(FIVE.map(([, to]) => to));
});

test("a write to a usage no key has gets the error marker: the channel throws DeviceRefused", async () => {
	const board = fake();
	const session = await connect({ port: board.port(), clearance: SHIPPED, signal: live }, { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	await session.config.openGate(live);
	await expect(session.config.writeKey(0, usage(0xe7), { kind: "override", code: 0x04, flags: 0 }, live)).rejects.toBeInstanceOf(DeviceRefused);
	await session.config.closeGate(live);
	await expect(session.config.writeKey(0, usage(0x04), { kind: "override", code: 0x05, flags: 0 }, live)).rejects.toBeInstanceOf(DeviceRefused);
	await session.close();
});

/** Rewrites bytes 4..5 of the `nth` reply that starts with `head`, as a board that stored something else would answer. */
function corrupting(port: DevicePort, head: readonly [number, number], nth: number): DevicePort {
	let seen = 0;
	const wrap = (link: Link): Link => ({
		...link,
		send: (report) => link.send(report),
		next: async (timeoutMs) => {
			const reply = await link.next(timeoutMs);
			if (reply[0] !== head[0] || reply[1] !== head[1] || seen++ !== nth) return reply;
			const out = Uint8Array.from(reply);
			out[4] = 0x04;
			out[5] = 0x00;
			return out as typeof reply;
		},
		discardPending: () => link.discardPending(),
		close: () => link.close(),
	});
	return { exclusive: (inner) => port.exclusive(inner), clock: port.clock, open: async (want, signal) => wrap(await port.open(want, signal)) };
}

test("a read-back that differs from the write stops the job and still closes the gate", async () => {
	const board = fake();
	const { end, sent } = await apply(board, docOf(FIVE), "windows", corrupting(board.port(), [0x52, 0x20], LAYER_READS + 2));
	expect(end).toMatchObject({ kind: "stopped", reason: { kind: "keymap", problem: { kind: "read-back", layer: 0, key: 46, want: "0x0052", got: "0x0004" } } });
	expect(sent.slice(-2)).toEqual(["4100", "41ff"]);
});

test("a link lost in the middle of the writes reconnects and converges from the reads", async () => {
	const clean = fake();
	await apply(clean, docOf(FIVE));
	const secondWrite = clean.received.findIndex(({ cmd }) => cmd === 0x51) + 1;
	const board = fake({ loseLinkAtPacket: secondWrite });
	const { end, sent } = await apply(board, docOf(FIVE));
	expect(end).toMatchObject({ kind: "finished", result: { kind: "keymap-applied", writes: 4 } });
	expect(count(sent, "4180")).toBe(1);
	expect(presses(board)).toEqual(FIVE.map(([, to]) => to));
	expect(board.violations).toEqual([]);
});

test("a document with an OS mode stops at G1 before any config frame", async () => {
	const board = fake();
	const { end, sent } = await apply(board, { ...docOf(FIVE), osMode: 1 });
	expect(end).toMatchObject({ kind: "stopped", reason: { kind: "gate" } });
	expect(sent).toEqual(["1202", "1200"]);
});

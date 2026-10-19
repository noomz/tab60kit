// Plan U4: property tests over the layout check, the spans, and the egress audit. The expectations are written here
// as literals from R1 ("Flash map", "BL info block", "Packet framing"), with no help from flashmap.ts or the audit, so a
// bug in either cannot cancel out. The generators are seeded, so a failure names a case that repeats, and probes/run.sh
// counts on the same cases to catch an inWindow that accepts one page past the end.
import { expect, test } from "bun:test";
import { appRegion, imageSpan, parseBlInfo, versionPage, versionSpan, windowFor } from "../core/flashmap";
import type { FlashWindow, Span } from "../core/flashmap";
import type { Mode } from "../core/port";
import { COMMANDS, COMMAND_NAMES, type CommandName, type CommandSpec, type EgressContext, type EgressVerdict, auditEgress, connect, labClearance } from "../core/protocol";
import { BL_INFO_HEX } from "./fixtures";
import { ScriptedLink, ScriptedPort, fromHex, report, toHex } from "./scripted";

const REPORT_BYTES = 64;
const PAGE = 0x200;
const IMAGE_OFFSET = 0x200;
/** 0x1FE00 - 0x3000: protocol offsets [0, 0x1CE00) are the version page and the app region. */
const WINDOW_BYTES = 0x1ce00;
const CHUNK = 52;
const IDENTITY_HEX = "00000000d904041340700404ffffffff";
/** BL info bytes 4..20 (the identity) and the fw_offset, fw_pages, and page_size words at 0x20. */
const CHECKED_BYTES = [...Array.from({ length: 16 }, (_, i) => 4 + i), 0x20, 0x21, 0x22, 0x23, 0x24, 0x25];
const VALID_BL_INFO = fromHex(BL_INFO_HEX);
const MODES: readonly Mode[] = ["app", "iap"];
const live = new AbortController().signal;

function hasExpectedLayout(payload: Uint8Array): boolean {
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	return (
		toHex(payload.subarray(4, 20)) === IDENTITY_HEX &&
		view.getUint16(0x20, true) === IMAGE_OFFSET &&
		view.getUint16(0x22, true) === WINDOW_BYTES / PAGE &&
		view.getUint16(0x24, true) === PAGE
	);
}

/**
 * The largest argument bytes 2..3 may carry, from the U10 and U11 static reads: 0x52/0x21 takes a frame index 0..15
 * (the board uses only its low nibble), 0x52/0x20 and 0x51/0x20 take layer << 8 | usage with layers 0..2, and every
 * other row takes none.
 */
function maxArg(cmd: number, sub: number): number {
	if (cmd === 0x52 && sub === 0x21) return 0x0f;
	if ((cmd === 0x52 || cmd === 0x51) && sub === 0x20) return 0x2ff;
	return 0;
}

/** The user's U11 ruling: 0x51/0x20 carries a u16 value in bytes 4..5 with flags 0, so its high byte is 0. */
const KEY_WRITE_VALUE_MAX = 0x00ff;

const inside = (offset: number, length: number) => Number.isInteger(offset) && offset >= 0 && length >= 1 && offset + length <= WINDOW_BYTES;

function namesRow(spec: CommandSpec, cmd: number, sub: number): boolean {
	if (cmd !== spec.cmd) return false;
	if (spec.sub === "length") return sub >= 1 && sub <= CHUNK;
	if (typeof spec.sub === "number") return sub === spec.sub;
	return sub >= spec.sub.first && sub < spec.sub.first + spec.sub.count;
}

interface Case {
	readonly frame: Uint8Array;
	readonly requested: CommandName;
	readonly mode: Mode;
	readonly window: FlashWindow | null;
	readonly cursor: number | null;
	readonly cleared: ReadonlySet<CommandName>;
}

const audit = (c: Case): EgressVerdict => {
	const ctx: EgressContext = { mode: c.mode, window: c.window, cursor: c.cursor, cleared: (command) => c.cleared.has(command) };
	return auditEgress(c.frame, c.requested, ctx);
};

/**
 * What is wrong with a frame the audit passed, or null. Which frames carry a flash offset is read from the command
 * byte (0x1D a range, 0x1E the write address, 0x1F a write at the cursor), not from the registry's `address` field.
 */
function problemWith(c: Case, passed: Extract<EgressVerdict, { ok: true }>): string | null {
	const { frame } = c;
	if (frame.length !== REPORT_BYTES) return `is ${frame.length} bytes`;
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const cmd = view.getUint8(0);
	const sub = view.getUint8(1);
	const spec: CommandSpec = COMMANDS[passed.command];
	if (!namesRow(spec, cmd, sub)) return `does not name the registry row ${passed.command}`;
	if (passed.command !== c.requested) return `is ${passed.command}, and ${c.requested} was requested`;
	if (!c.cleared.has(passed.command)) return `is ${passed.command}, which is not cleared`;
	if (!spec.modes.includes(c.mode)) return `is ${passed.command}, which the ${c.mode} link may not send`;
	const arg = view.getUint16(2, true);
	if (arg > maxArg(cmd, sub)) return `carries 0x${arg.toString(16)} in bytes 2..3`;

	let payloadBytes = 0;
	let cursor = c.cursor;
	if (cmd === 0x1d || cmd === 0x1e || cmd === 0x1f) {
		if (c.window === null) return "addresses flash before a window exists";
		let offset: number;
		let length: number;
		if (cmd === 0x1d) {
			payloadBytes = 8;
			offset = view.getUint32(4, true);
			length = view.getUint32(8, true);
			if (sub === 0x00 && (offset % PAGE !== 0 || length % PAGE !== 0)) return `erases off a page boundary: offset 0x${offset.toString(16)}, length 0x${length.toString(16)}`;
		} else if (cmd === 0x1e) {
			payloadBytes = 4;
			offset = view.getUint32(4, true);
			length = 1;
			cursor = offset;
		} else {
			if (c.cursor === null) return "writes with no write address set";
			payloadBytes = sub;
			offset = c.cursor;
			length = sub;
			cursor = c.cursor + sub;
		}
		if (!inside(offset, length)) return `addresses outside the window: offset 0x${offset.toString(16)}, length 0x${length.toString(16)}`;
	}
	if (cmd === 0x51 && sub === 0x20) {
		payloadBytes = 2;
		const value = view.getUint16(4, true);
		if (value > KEY_WRITE_VALUE_MAX) return `writes value 0x${value.toString(16)}, which has flags set`;
	}
	if (frame.subarray(4 + payloadBytes).some((byte) => byte !== 0)) return "carries a byte past its payload";
	if (!Object.is(passed.cursor, cursor)) return `leaves the cursor at ${passed.cursor}, not ${cursor}`;
	return null;
}

function show(c: Case): string {
	return `${toHex(c.frame)} as ${c.requested}, ${c.mode} link, ${c.window === null ? "no window" : "window"}, cursor ${c.cursor}, cleared ${[...c.cleared].join(",")}`;
}

/** Audits one case. Throws when the audit passed a frame the expectations above refuse. Returns whether it passed. */
function check(c: Case, where: string): EgressVerdict {
	const verdict = audit(c);
	if (verdict.ok) {
		const problem = problemWith(c, verdict);
		if (problem !== null) throw new Error(`${where}: the audit passed a frame that ${problem} (${show(c)})`);
	}
	return verdict;
}

function frameOf(cmd: number, sub: number, fields: readonly number[] = []): Uint8Array {
	const frame = new Uint8Array(REPORT_BYTES);
	const view = new DataView(frame.buffer);
	view.setUint8(0, cmd);
	view.setUint8(1, sub);
	fields.forEach((field, i) => view.setUint32(4 + 4 * i, field, true));
	return frame;
}

/** mulberry32. */
function random(seed: number) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
	};
	const below = (n: number) => Math.floor(next() * n);
	const chance = (p: number) => next() < p;
	const pick = <T>(from: readonly T[]): T => from[below(from.length)]!;
	const step = () => pick([0, 0, 1, -1, PAGE, -PAGE, below(2 * PAGE + 1) - PAGE]);
	/** A u32: near a window boundary or the 32-bit wrap, inside or just past the window, or anywhere. */
	const offset = () => {
		const kind = next();
		if (kind < 0.5) return (pick([0, PAGE, WINDOW_BYTES - PAGE, WINDOW_BYTES, WINDOW_BYTES + PAGE, 0xffff_d000]) + step()) >>> 0;
		if (kind < 0.85) return chance(0.5) ? below(WINDOW_BYTES / PAGE + 2) * PAGE : below(WINDOW_BYTES + 2 * PAGE);
		return below(0x1_0000_0000);
	};
	/** A length for a range at `from`: often one that ends at or around the window end. */
	const length = (from: number) => (chance(0.4) ? (WINDOW_BYTES - from + step()) >>> 0 : offset());
	return { below, chance, pick, offset, length };
}
type Random = ReturnType<typeof random>;

const NAMES_BY_CMD = (cmd: number) => COMMAND_NAMES.filter((name) => COMMANDS[name].cmd === cmd);
const EVERY_COMMAND: ReadonlySet<CommandName> = new Set(COMMAND_NAMES);

/** A range, set-address, or write frame at random offsets, with the cursor a write would land on. */
function addressed(r: Random): Pick<Case, "frame" | "requested" | "cursor"> {
	const cmd = r.pick([0x1d, 0x1d, 0x1d, 0x1e, 0x1f]);
	if (cmd === 0x1d) {
		const requested = r.pick(NAMES_BY_CMD(0x1d));
		const from = r.offset();
		return { frame: frameOf(cmd, COMMANDS[requested].sub as number, [from, r.length(from)]), requested, cursor: null };
	}
	if (cmd === 0x1e) return { frame: frameOf(cmd, 0x01, [r.offset()]), requested: "setWriteAddress", cursor: null };
	const bytes = 1 + r.below(CHUNK);
	const frame = frameOf(cmd, bytes);
	for (let i = 0; i < bytes; i++) frame[4 + i] = r.below(256);
	const cursor = r.chance(0.4) ? WINDOW_BYTES - bytes + r.pick([0, 0, 1, -1, PAGE, -PAGE]) : r.offset();
	return { frame, requested: "write", cursor };
}

const U1_ROWS = ["readMode", "readBlInfo", "readFwInfo", "readVersionPage", "sum", "resetToIap", "resetToApp"] as const;
const clearance = labClearance(U1_ROWS, "U4 property test");
const plain = (span: Span) => ({ offset: Number(span.offset), length: span.length });

test("10,000 random BL infos through connect: only the expected layout attaches, and every span request stays in the window", async () => {
	const r = random(0x0455_0001);
	const count = { attached: 0, refused: 0, sums: 0, oversized: 0, passed: 0 };
	for (let i = 0; i < 10_000; i++) {
		const payload = Uint8Array.from(VALID_BL_INFO);
		if (r.chance(0.7)) {
			for (let pokes = 1 + r.below(3); pokes > 0; pokes--) payload[r.chance(0.6) ? r.pick(CHECKED_BYTES) : r.below(payload.length)] = r.below(256);
		}
		const where = `case ${i}, BL info ${toHex(payload)}`;
		const mode = r.pick(MODES);
		const link = new ScriptedLink(mode, [report(`12020000${mode === "app" ? "01" : "00"}`), report(`12000000${toHex(payload)}`), ...(mode === "iap" ? [report("1201000004000200")] : [])]);
		const session = await connect({ port: new ScriptedPort([link]), clearance, signal: live }, { modes: [mode], reason: "connect" });
		const expected = hasExpectedLayout(payload);
		if (link.sent.some((frame) => frame[0] !== 0x12)) throw new Error(`${where}: attach sent something other than a read`);
		if ("refusal" in session) {
			if (expected) throw new Error(`${where}: refused the expected layout (${session.refusal.code})`);
			count.refused++;
			continue;
		}
		if (!expected) throw new Error(`${where}: attached a board whose checked fields differ`);
		count.attached++;
		const { window } = session;

		if (session.mode === "iap") {
			const imageBytes = r.chance(0.5) ? r.pick([34_268, WINDOW_BYTES - IMAGE_OFFSET, WINDOW_BYTES - IMAGE_OFFSET + 1, WINDOW_BYTES, 1, 0, -1, 1.5]) : r.below(WINDOW_BYTES + PAGE);
			const fits = Number.isInteger(imageBytes) && inside(IMAGE_OFFSET, imageBytes);
			link.replies.push(report("1d010000d2dbd3f3"));
			const before = link.sent.length;
			const thrown = await session.checksum(imageBytes, live).then(
				() => null,
				(error: unknown) => error,
			);
			const sent = link.sent.slice(before).map(toHex);
			if (fits) {
				if (thrown !== null) throw thrown;
				expect(`${where}: ${sent.join(" ")}`).toBe(`${where}: ${toHex(frameOf(0x1d, 0x01, [IMAGE_OFFSET, imageBytes]))}`);
				count.sums++;
			} else {
				if (!(thrown instanceof RangeError) || sent.length > 0) throw new Error(`${where}: checksum(${imageBytes}) sent ${sent.length} frames, threw ${String(thrown)}`);
				count.oversized++;
			}
		}

		const iap = { mode: "iap", window, cleared: EVERY_COMMAND } as const;
		const image = imageSpan(window, r.chance(0.5) ? 34_268 : r.below(WINDOW_BYTES + PAGE));
		const erases = [versionPage(window), appRegion(window)];
		expect(erases.map(plain)).toEqual([
			{ offset: 0, length: PAGE },
			{ offset: PAGE, length: WINDOW_BYTES - PAGE },
		]);
		for (const span of [...erases, versionSpan(window), ...(image === null ? [] : [image])]) {
			const range = [span.offset, span.length];
			const sum = check({ ...iap, frame: frameOf(0x1d, 0x01, range), requested: "sum", cursor: null }, where);
			const crc = check({ ...iap, frame: frameOf(0x1d, 0x02, range), requested: "crc", cursor: null }, where);
			const erase = check({ ...iap, frame: frameOf(0x1d, 0x00, range), requested: "erase", cursor: null }, where);
			const address = check({ ...iap, frame: frameOf(0x1e, 0x01, [span.offset]), requested: "setWriteAddress", cursor: null }, where);
			const last = ((span.length - 1) % CHUNK) + 1;
			const first = check({ ...iap, frame: frameOf(0x1f, Math.min(CHUNK, span.length)), requested: "write", cursor: span.offset }, where);
			const final = check({ ...iap, frame: frameOf(0x1f, last), requested: "write", cursor: span.offset + span.length - last }, where);
			const refused = [sum, crc, address, first, final, ...(erases.includes(span) ? [erase] : [])].filter((verdict) => !verdict.ok);
			if (refused.length > 0) throw new Error(`${where}: the audit refused the tool's own span ${JSON.stringify(plain(span))}: ${JSON.stringify(refused)}`);
			if (final.ok && final.cursor !== span.offset + span.length) throw new Error(`${where}: the last chunk ends at ${final.cursor}`);
			count.passed += [sum, crc, erase, address, first, final].filter((verdict) => verdict.ok).length;
		}
		for (let n = 0; n < 4; n++) {
			if (check({ ...addressed(r), mode: r.chance(0.9) ? "iap" : "app", window, cleared: EVERY_COMMAND }, where).ok) count.passed++;
		}
	}
	console.log(`U4 connect property: ${JSON.stringify(count)}`);
	expect(count.attached + count.refused).toBe(10_000);
	for (const [what, seen] of Object.entries(count)) expect(`${what}: ${seen >= 500}`).toBe(`${what}: true`);
});

test("100,000 random frames and contexts: every frame the audit passes names a registry row, the requested and cleared command, and the link's mode", () => {
	const r = random(0x0455_0002);
	const info = parseBlInfo(VALID_BL_INFO);
	if ("code" in info) throw new Error(info.code);
	const window = windowFor(info);
	if ("code" in window) throw new Error(window.code);
	const passed = new Map<CommandName, number>();
	const refused = new Map<string, number>();
	for (let i = 0; i < 100_000; i++) {
		const name = r.pick(COMMAND_NAMES);
		const spec: CommandSpec = COMMANDS[name];
		let frame: Uint8Array;
		let cursor: number | null = r.chance(0.15) ? null : r.chance(0.05) ? r.pick([-1, 0.5, Number.NaN]) : r.offset();
		let requested: CommandName = name;
		if (spec.address === "none") {
			const sub = typeof spec.sub === "number" ? spec.sub : spec.sub === "length" ? 1 : spec.sub.first + r.below(spec.sub.count);
			frame = frameOf(spec.cmd, sub);
			if (r.chance(0.5)) new DataView(frame.buffer).setUint16(2, r.pick([0, 1, 0x0f, 0x10, 0x3f, 0x00ff, 0x0100, 0x02ff, 0x0300, r.below(0x1_0000)]), true);
			if (spec.value !== null && r.chance(0.7)) new DataView(frame.buffer).setUint16(4, r.pick([0x00e0, 0x00ff, 0x0100, 0x01e0, 0x02e0, 0x03ff, r.below(0x1_0000)]), true);
		} else {
			const made = addressed(r);
			frame = made.frame;
			requested = made.requested;
			cursor = made.cursor ?? cursor;
			if (requested === "write" && r.chance(0.1)) cursor = null;
		}
		if (r.chance(0.08)) frame[1] = r.below(256);
		if (r.chance(0.1)) frame[r.below(frame.length)] = r.below(256);
		if (r.chance(0.03)) frame = frame.map(() => r.below(256));
		if (r.chance(0.01)) frame = frame.subarray(0, r.below(REPORT_BYTES));
		if (r.chance(0.01)) frame = Uint8Array.of(...frame, ...new Uint8Array(1 + r.below(8)));
		if (r.chance(0.1)) requested = r.pick(COMMAND_NAMES);
		const c: Case = {
			frame,
			requested,
			mode: r.chance(0.85) ? r.pick((COMMANDS[requested] as CommandSpec).modes) : r.pick(MODES),
			window: r.chance(0.9) ? window : null,
			cursor,
			cleared: new Set(COMMAND_NAMES.filter(() => r.chance(0.85))),
		};
		const verdict = check(c, `case ${i}`);
		if (verdict.ok) passed.set(verdict.command, (passed.get(verdict.command) ?? 0) + 1);
		else refused.set(verdict.refusal.code, (refused.get(verdict.refusal.code) ?? 0) + 1);
	}
	console.log(`U4 audit property: passed ${JSON.stringify(Object.fromEntries(passed))}, refused ${JSON.stringify(Object.fromEntries(refused))}`);
	expect(COMMAND_NAMES.filter((name) => (passed.get(name) ?? 0) < 100)).toEqual([]);
	expect(
		["bad-length", "unknown-command", "not-requested", "not-cleared", "wrong-mode", "arg-not-allowed", "value-not-allowed", "payload-overrun", "no-window", "outside-window", "unaligned-erase", "no-write-cursor"].filter(
			(code) => (refused.get(code) ?? 0) < 100,
		),
	).toEqual([]);
});

test("every single-byte difference in a checked BL info field is refused", () => {
	const accepted: string[] = [];
	for (const at of CHECKED_BYTES) {
		for (let value = 0; value < 256; value++) {
			if (value === VALID_BL_INFO[at]) continue;
			const payload = Uint8Array.from(VALID_BL_INFO);
			payload[at] = value;
			const info = parseBlInfo(payload);
			if (!("code" in info) && !("code" in windowFor(info))) accepted.push(`byte 0x${at.toString(16)} = 0x${value.toString(16)}`);
		}
	}
	expect(accepted).toEqual([]);
	expect(CHECKED_BYTES).toHaveLength(22);
});

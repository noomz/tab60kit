import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OS_KEY_MODES, type OsKeyMode, presentUsages } from "../core/keymap";
import { NotCleared, SHIPPED } from "../core/protocol";
import { U1_EXPECTED } from "../lab/u1-job";
import { U10_PRECONDITIONS, diffAgainstPrediction, framesOutsideU10, readStore, u10Clearance, u10Preconditions } from "../lab/u10-run";
import { verdictMain } from "../tools/u10-verdict";
import { startWebHidLab } from "../web/webhid-port";
import { FakeTab60, type FakeOptions } from "./fake-tab60";
import { FakeHid, FakeLocks } from "./fake-webhid";
import { type Transcript, type TranscriptEntry, recording } from "./transcript";

const live = new AbortController().signal;

/** What lab/u10.ts does on the page: one Read, recorded through the same WebHID shell. */
async function readOnFake(overrides: FakeOptions["overrides"] = [], clearance = u10Clearance(), mode: OsKeyMode = "windows") {
	const board = new FakeTab60({ starting: "official-image", target: { imageBytes: U1_EXPECTED.imageBytes, wireSum32: U1_EXPECTED.imageSum32 }, overrides, osKeyMode: OS_KEY_MODES[mode].byte });
	const entries: TranscriptEntry[] = [];
	const { port, chooser } = startWebHidLab(new FakeHid(board, { rowAppearsInOpenChooser: ["app"], isActive: () => true }), new FakeLocks(), {
		wrap: (link) => recording(link, (entry) => entries.push(entry)),
		onEvent: (event) => entries.push({ t: 0, ...event }),
	});
	const clicker = setInterval(() => chooser.needsClick !== null && chooser.pick(), 1);
	try {
		const read = await port.exclusive(() => readStore(port, clearance, mode, live)).then(
			(store) => ({ ok: true, store }) as const,
			(error: unknown) => ({ ok: false, error }) as const,
		);
		const sent = entries.flatMap((entry) => (entry.kind === "out" ? [entry.hex] : []));
		return { read, sent, entries, board };
	} finally {
		clearInterval(clicker);
	}
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

test("a board with the factory store reads exactly as predicted in each OS key mode, with only the attach reads and the two 0x52 reads on the wire", async () => {
	for (const mode of Object.keys(OS_KEY_MODES) as OsKeyMode[]) {
		const { read, sent, entries, board } = await readOnFake([], u10Clearance(), mode);
		if (!read.ok) throw read.error;
		const { store } = read;
		const present = presentUsages(mode);
		expect(present).toHaveLength(66);
		expect(store.entries).toHaveLength(256 + 2 * 66);
		expect({ mode, diffs: diffAgainstPrediction(store, mode) }).toEqual({ mode, diffs: [] });
		expect(store.entries.filter(({ entry }) => entry.kind === "override")).toHaveLength(31);
		expect(framesOutsideU10(entries)).toEqual([]);
		expect(sent.map((frame) => frame.slice(0, 8))).toEqual([
			"12020000",
			"12000000",
			...Array.from({ length: 16 }, (_, a) => `5221${hex2(a)}00`),
			...[1, 2].flatMap((layer) => present.map((k) => `5220${hex2(k)}0${layer}`)),
		]);
		expect(sent.every((frame) => /^0*$/.test(frame.slice(8)))).toBe(true);
		expect(board.violations).toEqual([]);
	}
});

test("a Mac board read against the Windows prediction differs at the swapped modifiers", async () => {
	const { read } = await readOnFake([], u10Clearance(), "mac");
	if (!read.ok) throw read.error;
	expect(diffAgainstPrediction(read.store, "windows")).toEqual([
		"layer 0 usage 0xe6: predicted default, read absent",
		"layer 0 usage 0xe7: predicted absent, read default",
		"layer 1 usage 0xe7: predicted absent, read default",
		"layer 2 usage 0xe2: predicted override 0x30 flags 1, read override 0x60 flags 1",
		"layer 2 usage 0xe3: predicted override 0x60 flags 1, read override 0x30 flags 1",
		"layer 2 usage 0xe7: predicted absent, read default",
	]);
});

test("a seeded override on layer 1 is the one difference the page shows", async () => {
	const { read } = await readOnFake([{ layer: 1, cell: 5, usage: 0x29, flags: 2 }]);
	if (!read.ok) throw read.error;
	expect(diffAgainstPrediction(read.store, "windows")).toEqual(["layer 1 usage 0x04: predicted default, read override 0x29 flags 2"]);
});

test("the shipped clearance reads nothing past the attach", async () => {
	const { read, sent } = await readOnFake([], SHIPPED);
	expect(read.ok ? null : read.error).toBeInstanceOf(NotCleared);
	expect(sent.map((frame) => frame.slice(0, 4))).toEqual(["1202", "1200"]);
});

test("the frame check names every sent frame outside the U10 rows", () => {
	const out = (hex: string): TranscriptEntry => ({ t: 0, kind: "out", hex: hex.padEnd(128, "0") });
	expect(framesOutsideU10([out("12020000"), out("52210300"), out("11010000"), { t: 0, kind: "in", hex: "11".padEnd(128, "0") }, out("12200000")])).toEqual([
		"11010000".padEnd(128, "0"),
		"12200000".padEnd(128, "0"),
	]);
});

const ticks = U10_PRECONDITIONS.map(({ key }): TranscriptEntry => ({ t: 0, kind: "precondition", key, met: true }));

/** A saved page transcript as a real board and a clean build would record it, from a Read on the fake board. */
async function savedTranscript(overrides: FakeOptions["overrides"] = [], boxes = ticks): Promise<Transcript> {
	const { read, entries } = await readOnFake(overrides);
	if (!read.ok) throw read.error;
	const all = [...boxes, ...entries];
	return {
		format: "tab60kit-transcript/1",
		recordedAt: "2026-10-19T00:00:00.000Z",
		environment: { fake: "no", tool: "abc1234", ...u10Preconditions.preconditionEnvironment(all) },
		entries: all,
	};
}

async function runVerdict(transcript: Transcript) {
	const dir = mkdtempSync(join(tmpdir(), "u10-verdict-"));
	const file = join(dir, "transcript.json");
	const out = join(dir, "fixtures", "u10-test.json");
	writeFileSync(file, JSON.stringify(transcript));
	const log = spyOn(console, "log").mockImplementation(() => undefined);
	const errors = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		const code = verdictMain([file, "--out", out]);
		const written = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
		const lines = log.mock.calls.map((args) => args.join(" "));
		return { code, written, errors: errors.mock.calls.map((args) => args.join(" ")), fails: lines.filter((line) => line.startsWith("FAIL ")) };
	} finally {
		log.mockRestore();
		errors.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
}

test("the U10 verdict passes a clean read with both preconditions ticked, and writes the capture", async () => {
	const transcript = await savedTranscript();
	const { code, written, fails } = await runVerdict(transcript);
	expect({ code, fails }).toEqual({ code: 0, fails: [] });
	expect(written.format).toBe("tab60kit-u10-verdict/1");
	expect(written.checks).toHaveLength(6);
	expect(written.transcript).toEqual(transcript);
});

test("the U10 verdict refuses a fake board and an unnamed or dirty build with exit 2, and writes nothing", async () => {
	const transcript = await savedTranscript();
	for (const [environment, why] of [
		[{ fake: "override" }, 'environment.fake is "override", and a fake board is not evidence'],
		[{ tool: "abc1234-dirty" }, 'environment.tool is "abc1234-dirty", and only a build from a clean commit is evidence'],
		[{ tool: "unknown" }, 'environment.tool is "unknown", and only a build from a clean commit is evidence'],
	] as const) {
		const { code, written, errors } = await runVerdict({ ...transcript, environment: { ...transcript.environment, ...environment } });
		expect({ code, written, errors }).toEqual({ code: 2, written: null, errors: [`${why}. Wrote nothing.`] });
	}
});

test("the U10 verdict decodes a seeded override from the frames and fails naming its layer and usage", async () => {
	const { code, written, fails } = await runVerdict(await savedTranscript([{ layer: 0, cell: 7, usage: 0x1d, flags: 1 }, { layer: 2, cell: 5, usage: 0x29, flags: 2 }]));
	expect({ code, written }).toEqual({ code: 1, written: null });
	expect(fails).toEqual([
		"FAIL Every layer 0 entry equals the prediction\n     layer 0 usage 0x1d: predicted default, read override 0x1d flags 1",
		"FAIL Every layer 1 and 2 entry equals the prediction\n     layer 2 usage 0x04: predicted override 0x92 flags 1, read override 0x29 flags 2",
	]);
});

test("the U10 verdict fails a stray frame, a reply that does not echo the argument, and a missing layer 2 read", async () => {
	const clean = await savedTranscript();
	const stray = "12010000".padEnd(128, "0");
	const firstReply = clean.entries.findIndex((entry) => entry.kind === "in" && entry.hex.startsWith("52210000"));
	const unechoed = clean.entries.map((entry, i) => (i === firstReply && entry.kind === "in" ? { ...entry, hex: `52210100${entry.hex.slice(8)}` } : entry));
	const lastRead = clean.entries.reduce((last, entry, i) => (entry.kind === "out" ? i : last), -1);
	const cases: readonly [string, Transcript, string[]][] = [
		["a stray frame", { ...clean, entries: [...clean.entries, { t: 0, kind: "out", hex: stray }] }, [`FAIL Every frame sent is one of the four U10 rows\n     frame outside the U10 rows: ${stray}`]],
		[
			"an unechoed reply",
			{ ...clean, entries: unechoed },
			["FAIL Layer 0 is 16 cfgReadKeys frames with arguments 0 to 15, each answered with bytes 0..3 echoed\n     no reply echoes 52210000", "FAIL Every layer 0 entry equals the prediction\n     decoded 240 entries, not 256"],
		],
		[
			"a missing layer 2 read",
			{ ...clean, entries: clean.entries.filter((_, i) => i !== lastRead && i !== lastRead + 1) },
			["FAIL cfgReadKey reads every present usage on layers 1 and 2, each answered with bytes 0..3 echoed\n     layer 2 has no answered read of 0xe6"],
		],
	];
	for (const [why, transcript, expected] of cases) {
		const { code, written, fails } = await runVerdict(transcript);
		expect({ why, code, written, fails }).toEqual({ why, code: 1, written: null, fails: expected });
	}
});

test("the U10 verdict fails a transcript whose preconditions were not all ticked before the first frame", async () => {
	const [battery, free] = ticks;
	const cases: readonly [string, Transcript, string][] = [
		["a box never ticked", await savedTranscript([], [battery!]), "No other app holds the keyboard"],
		["a box ticked after the first frame", await savedTranscript([], [free!]).then((t) => ({ ...t, entries: [...t.entries, battery!], environment: { ...t.environment, batteryPulled: "yes" } })), "The batteries were removed and USB unplugged for 10 s, then the board was reconnected over USB"],
	];
	for (const [why, transcript, label] of cases) {
		const { code, written, fails } = await runVerdict(transcript);
		expect({ why, code, written, fails }).toEqual({ why, code: 1, written: null, fails: [`FAIL The preconditions were ticked before the first frame and held for the run\n     not met: ${label}`] });
	}
});

test("the page's boxes lock at the first frame, and Read waits for both", () => {
	const entries: TranscriptEntry[] = [];
	expect(u10Preconditions.allTicked(entries)).toBe(false);
	entries.push(u10Preconditions.preconditionChange(entries, "batteryPulled", true, 0)!);
	expect(u10Preconditions.allTicked(entries)).toBe(false);
	entries.push(u10Preconditions.preconditionChange(entries, "keyboardFree", true, 1)!);
	expect(u10Preconditions.allTicked(entries)).toBe(true);
	entries.push({ t: 2, kind: "out", hex: "12020000".padEnd(128, "0") });
	expect(u10Preconditions.preconditionChange(entries, "keyboardFree", false, 3)).toBeNull();
	expect(u10Preconditions.preconditionEnvironment(entries)).toEqual({ batteryPulled: "yes", keyboardFree: "yes" });
});

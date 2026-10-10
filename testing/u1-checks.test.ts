import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../core/firmware";
import { type TypingObservation, type U1Expected, evaluateU1, passes } from "../lab/u1-checks";
import { U1_EXPECTED } from "../lab/u1-job";
import { verdictMain } from "../tools/u1-verdict";
import { TARGET, recordFakeRun } from "./fake-run";
import { syntheticVersionBlock } from "./fake-tab60";
import { VENDOR_COLLECTION } from "./fake-webhid";
import type { Transcript, TranscriptEntry } from "./transcript";

const fakeExpected: U1Expected = { ...U1_EXPECTED, versionPageSha256: await sha256(syntheticVersionBlock()), probeSpacingMs: 0 };

const typed = (transcript: Transcript, chars = 4): Transcript => ({
	...transcript,
	entries: [...transcript.entries, { t: (transcript.entries.at(-1)?.t ?? 0) + 1, kind: "typing", chars }],
});
const untyped = (await recordFakeRun()).transcript;
const baseline = typed(untyped);

const verdict = (transcript: Transcript, typing: TypingObservation = "types", expected = fakeExpected) => evaluateU1(transcript, { expected, typing });
const failing = async (transcript: Transcript, typing: TypingObservation = "types", expected = fakeExpected) =>
	(await verdict(transcript, typing, expected)).checks.filter((check) => !check.pass).map((check) => check.id);
const detail = async (transcript: Transcript, id: number, typing: TypingObservation = "types", expected = fakeExpected) =>
	(await verdict(transcript, typing, expected)).checks.find((check) => check.id === id)?.detail;

function rewrite(transcript: Transcript, matches: (entry: TranscriptEntry) => boolean, n: number | "all", change: (entry: TranscriptEntry) => TranscriptEntry): Transcript {
	let seen = 0;
	const entries = transcript.entries.map((entry) => (matches(entry) && (n === "all" || seen++ === n) ? change(entry) : entry));
	if (n !== "all" && seen <= n) throw new Error(`only ${seen} entries matched`);
	return { ...transcript, entries };
}
const reply = (prefix: string) => (entry: TranscriptEntry) => entry.kind === "in" && entry.hex.startsWith(prefix);
const withHex = (at: number, hex: string) => (entry: TranscriptEntry) => (entry.kind === "in" ? { ...entry, hex: entry.hex.slice(0, at) + hex + entry.hex.slice(at + hex.length) } : entry);
const refusedReply = (entry: TranscriptEntry) => (entry.kind === "in" ? { ...entry, hex: `ffaa0000${entry.hex.slice(0, 4)}`.padEnd(128, "0") } : entry);
const appended = (transcript: Transcript, ...more: TranscriptEntry[]): Transcript => ({ ...transcript, entries: [...transcript.entries, ...more] });

test("the default fake run passes every check, with no findings, over the nine commands", async () => {
	const result = await verdict(baseline);
	expect(result.frames).toEqual({ title: "Every frame sent is one of the nine golden frames", pass: true, detail: "all 76 out entries are golden" });
	expect(result.checks.map((check) => `${check.id}:${check.pass}`)).toEqual(["1:true", "2:true", "3:true", "4:true", "5:true", "6:true", "7:true", "8:true", "9:true"]);
	expect(passes(result)).toBe(true);
	expect(result.findings).toEqual([]);
	expect(result.commands).toEqual(["12/02", "12/00", "12/20", "12/21", "12/22", "11/00", "12/01", "1d/01", "11/01"]);
});

test("check 1 fails when the Deep check chooser closed empty and a parked pick was needed", async () => {
	const { transcript } = await recordFakeRun({ hid: { rowAppearsInOpenChooser: [] }, autoPick: true });
	expect(await failing(typed(transcript))).toEqual([1]);
	expect(await detail(typed(transcript), 1)).toMatch(/needed a second click/);
});

test("check 2 fails when the update-mode device has a second collection", async () => {
	const { transcript } = await recordFakeRun({ hid: { collections: [VENDOR_COLLECTION, { ...VENDOR_COLLECTION, usagePage: 1, usage: 6 }] } });
	expect(await failing(typed(transcript))).toEqual([2]);
});

test("check 3 fails when READ MODE answers the other mode's byte", async () => {
	const transcript = rewrite(baseline, reply("12020000" + "00"), 0, withHex(8, "01"));
	expect(await failing(transcript)).toEqual([3]);
});

test("check 3 never reads an FF AA reply as a mode byte", async () => {
	const transcript = rewrite(baseline, reply("12020000" + "00"), "all", refusedReply);
	expect(await failing(transcript)).toEqual([3, 9]);
	expect(await detail(transcript, 3)).toMatch(/update mode answered \{\}/);
});

test("check 4 fails when BL info's identity bytes differ", async () => {
	const transcript = rewrite(baseline, reply("1200"), 0, withHex(8 + 2 * 8, "d9048212"));
	expect(await failing(transcript)).toEqual([4]);
});

test("check 5 passes on the board's own FW INFO answer, 04 00 02 00 and 56 zero bytes", async () => {
	expect((await verdict(baseline)).checks[4]).toEqual({
		id: 5,
		title: "FW INFO in update mode returns 04 00 02 00 and 56 zero bytes on every read",
		pass: true,
		detail: "1 reads answered 04000200 and 56 zero bytes",
	});
});

test("check 5 fails on any other payload, on a second read that differs, and when no FW INFO answered in update mode", async () => {
	const fwInfo = reply("1201");
	const { entries } = baseline;
	const at = entries.findIndex(fwInfo);
	const [out, answer] = [entries[at - 1], entries[at]];
	if (out?.kind !== "out" || answer?.kind !== "in") throw new Error("no FW INFO exchange in the baseline");
	const lastByte01 = `${answer.hex.slice(0, 126)}01`;
	const firstOpen = entries.findIndex((entry) => entry.kind === "opened");
	const none = "no FW INFO answered in update mode";
	const cases: readonly [string, Transcript, string][] = [
		["another payload, 00 02 00 00", rewrite(baseline, fwInfo, 0, withHex(8, "00020000")), `1 reads answered 00020000${"00".repeat(56)}`],
		["a nonzero byte after the first four", rewrite(baseline, fwInfo, 0, withHex(16, "01")), `1 reads answered 0400020001${"00".repeat(55)}`],
		["a nonzero last byte", rewrite(baseline, fwInfo, 0, withHex(126, "01")), `1 reads answered ${lastByte01.slice(8)}`],
		["a second read that differs", { ...baseline, entries: [...entries.slice(0, at + 1), out, { ...answer, hex: lastByte01 }, ...entries.slice(at + 1)] }, `2 reads answered 04000200 and 56 zero bytes, ${lastByte01.slice(8)}`],
		["FF AA", rewrite(baseline, fwInfo, 0, refusedReply), none],
		["no reply", { ...baseline, entries: entries.filter((entry) => !fwInfo(entry)) }, none],
		["an answer on the normal-mode link only", { ...baseline, entries: [...entries.slice(0, firstOpen + 1), out, answer, ...entries.slice(firstOpen + 1, at - 1), ...entries.slice(at + 1)] }, none],
	];
	const results = await Promise.all(cases.map(async ([why, transcript]) => ({ why, failing: await failing(transcript), detail: await detail(transcript, 5) })));
	expect(results).toEqual(cases.map(([why, , shown]) => ({ why, failing: [5], detail: shown })));
});

test("check 6 fails when the version page hashes differently", async () => {
	const { transcript } = await recordFakeRun({ board: { versionBlock: syntheticVersionBlock("V9.99.99") } });
	expect(await failing(typed(transcript))).toEqual([6]);
});

test("check 7 fails when the image sums differently, or SUM answers FF AA", async () => {
	const { transcript } = await recordFakeRun({ board: { target: { ...TARGET, wireSum32: 0x11111111 } } });
	expect(await failing(typed(transcript))).toEqual([7]);
	expect(await failing(rewrite(baseline, reply("1d01"), 0, refusedReply))).toEqual([7]);
});

test("check 8 needs the human's word, a typing entry after the confirm open, and that open from the confirm pick", async () => {
	expect(await failing(baseline, "does-not-type")).toEqual([8]);
	expect(await failing(baseline, "not-observed")).toEqual([8]);
	expect(await detail(baseline, 8, "not-observed")).toMatch(/typing not observed yet/);
	expect(await failing(untyped)).toEqual([8]);
	expect(await detail(untyped, 8)).toMatch(/no typing entry after that open/);
	const connectOpen = rewrite(baseline, (entry) => entry.kind === "opened" && entry.reason === "confirm-normal-mode", 0, (entry) => (entry.kind === "opened" ? { ...entry, reason: "connect" } : entry));
	expect(await failing(connectOpen)).toEqual([8]);
	expect(await detail(connectOpen, 8)).toMatch(/no 0x0304 opened for the confirm after the last RESET to app that left/);
});

test("check 8 accepts a confirm open through a device the grant kept, with no chooser", async () => {
	const granted = { ...baseline, entries: baseline.entries.filter((entry) => !(entry.kind === "pick" && entry.reason === "confirm-normal-mode")) };
	expect(await failing(granted)).toEqual([]);
	expect(await detail(granted, 8)).toMatch(/through a granted device and no chooser/);
});

test("check 8 counts only a RESET to app whose send did not fail, and a return after a failed one is a finding", async () => {
	const at = baseline.entries.findIndex((entry) => entry.kind === "out" && entry.hex.startsWith("1101"));
	const reset = baseline.entries[at];
	if (reset?.kind !== "out") throw new Error("no RESET to app in the baseline");
	const failedReset: Transcript = {
		...baseline,
		entries: [...baseline.entries.slice(0, at + 1), { t: reset.t, kind: "lost" }, { t: reset.t, kind: "send-failed", hex: reset.hex, error: "LinkLost: the device disconnected" }, ...baseline.entries.slice(at + 1)],
	};
	expect(await failing(failedReset)).toEqual([8]);
	expect(await detail(failedReset, 8)).toMatch(/the only RESET to app sends \(1\) failed/);
	expect((await verdict(failedReset)).findings).toContain("1 times 0x0304 opened after a RESET to app whose send failed, so that return does not show the reset worked");
});

test("check 8 fails on a return after a RESET to app whose send failed, even when an earlier reset came back on its own", async () => {
	const opened = (reason: string) => {
		const entry = baseline.entries.find((each) => each.kind === "opened" && each.reason === reason);
		if (entry?.kind !== "opened") throw new Error(`no ${reason} open in the baseline`);
		return entry;
	};
	const t = (baseline.entries.at(-1)?.t ?? 0) + 1;
	const reset = "1101".padEnd(128, "0");
	const failedAgain = appended(
		baseline,
		{ ...opened("enter-update-mode"), t },
		{ t: t + 1, kind: "out", hex: reset },
		{ t: t + 2, kind: "send-failed", hex: reset, error: "LinkLost: the board reset before the write settled" },
		{ t: t + 3, kind: "closed" },
		{ ...opened("confirm-normal-mode"), t: t + 4 },
		{ t: t + 5, kind: "typing", chars: 3 },
	);
	expect(await failing(failedAgain)).toEqual([8]);
	expect(await detail(failedAgain, 8)).toBe(
		"RESET to app sent; the confirm pick (activation) opened 0x0304, but 1 times 0x0304 opened after a RESET to app whose send failed",
	);
});

test("check 8 accepts a parked confirm pick", async () => {
	const parked = rewrite(baseline, (entry) => entry.kind === "pick" && entry.reason === "confirm-normal-mode", 0, (entry) => (entry.kind === "pick" ? { ...entry, path: "parked" } : entry));
	expect(await failing(parked)).toEqual([]);
	expect(await detail(parked, 8)).toMatch(/confirm pick \(parked\)/);
});

test("check 9 fails on a short probe series and on a slow answer", async () => {
	const { transcript: short } = await recordFakeRun({ series: { probes: 29, everyMs: 1 } });
	expect(await failing(typed(short))).toEqual([9]);
	let seen = 0;
	const slow: Transcript = {
		...baseline,
		entries: baseline.entries.map((entry) => (entry.kind === "in" && entry.hex.startsWith("1202") && ++seen === 20 ? { ...entry, t: entry.t + 2_000 } : entry)),
	};
	expect(await failing(slow)).toEqual([9]);
	expect(await detail(slow, 9)).toMatch(/longest gap 2\d\d\d ms/);
});

test("check 9 fails when the probes went out closer together than the page's spacing", async () => {
	expect(await failing(baseline, "types", { ...fakeExpected, probeSpacingMs: 500 })).toEqual([9]);
	expect(await detail(baseline, 9, "types", { ...fakeExpected, probeSpacingMs: 500 })).toMatch(/shortest send gap \d ms/);
});

test("findings name nonzero reply bytes 2..3 and FF AA replies, and the frames gate names a frame off the golden list", async () => {
	const nonzero = rewrite(baseline, reply("1202"), 3, withHex(4, "beef"));
	expect((await verdict(nonzero)).findings).toEqual(["reply bytes 2..3 nonzero in 1 replies: 0xefbe"]);
	const refused = rewrite(baseline, reply("1220"), 0, withHex(0, "ffaa"));
	expect((await verdict(refused)).findings).toEqual(["1 FF AA replies to: 12/20"]);
	const junk = "1202dead".padEnd(128, "0");
	const off = await verdict(appended(baseline, { t: 0, kind: "out", hex: junk }));
	expect(off.findings).toEqual(["1 requests unanswered: 12/02"]);
	expect(off.frames).toMatchObject({ pass: false, detail: `1 sent frames are not golden: ${junk}` });
});

test("findings name failed sends, slow closes, dropped reports, and a hidden tab", async () => {
	const noisy = appended(
		baseline,
		{ t: 0, kind: "send-failed", hex: "1101".padEnd(128, "0"), error: "LinkLost: unplugged" },
		{ t: 0, kind: "close-timeout", productId: 0x1304 },
		{ t: 0, kind: "discarded", hex: "1220".padEnd(128, "0") },
		{ t: 0, kind: "visibility", state: "hidden" },
	);
	expect((await verdict(noisy)).findings).toEqual([
		"1 sends rejected, so the board may or may not have taken them: 1101",
		"1 closes did not settle in time and were counted as closed: 0x1304",
		"1 input reports were dropped unread before a send",
		"the tab was hidden 1 times, and a hidden tab slows timers, so check 9's timing may measure the tab",
	]);
});

test("a transcript that starts with the bootloader granted gets a finding, and one with the keyboard granted gets none", async () => {
	const grantedAtLoad = (productId: number): Transcript => ({ ...baseline, entries: [{ t: 0, kind: "granted", productId }, ...baseline.entries] });
	expect((await verdict(grantedAtLoad(0x1304))).findings).toEqual(["the page loaded with 0x1304 granted, so an earlier page left the board in update mode"]);
	expect((await verdict(grantedAtLoad(0x0304))).findings).toEqual([]);
});

const real = (transcript: Transcript, environment: Partial<Transcript["environment"]> = {}): Transcript => ({
	...transcript,
	environment: { ...transcript.environment, fake: "no", tool: "abc1234", cableIn: "yes", karabinerLedOff: "yes", secondKeyboardAtHand: "yes", ...environment },
});

test("the CLI writes the fixture with its environment for a real-looking transcript, and exits by the verdict", async () => {
	const dir = mkdtempSync(join(tmpdir(), "u1-verdict-"));
	try {
		const file = join(dir, "transcript.json");
		const transcript = real(baseline);
		writeFileSync(file, JSON.stringify(transcript));
		const out = join(dir, "fixtures", "u1-test.json");
		expect(await verdictMain([file, "--types", "--out", out])).toBe(1);
		const fixture = JSON.parse(readFileSync(out, "utf8"));
		expect(fixture.format).toBe("tab60kit-u1-verdict/1");
		expect(fixture.typing).toBe("types");
		expect(fixture.environment).toEqual(transcript.environment);
		expect(fixture.frames.pass).toBe(true);
		expect(fixture.checks.filter((check: { pass: boolean }) => !check.pass).map((check: { id: number }) => check.id)).toEqual([6, 9]);
		expect(fixture.transcript.entries).toHaveLength(baseline.entries.length);
		expect(await verdictMain([file])).toBe(2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function runCli(transcript: Transcript, dir: string, name: string) {
	const file = join(dir, `${name}.json`);
	writeFileSync(file, JSON.stringify(transcript));
	const out = join(dir, `${name}-fixture.json`);
	const log = spyOn(console, "log").mockImplementation(() => undefined);
	try {
		const code = await verdictMain([file, "--types", "--out", out]);
		return { code, lines: log.mock.calls.map((args) => args.join(" ")), out };
	} finally {
		log.mockRestore();
	}
}

test("a frame off the golden list fails the run with all nine checks green, and the CLI prints the gate and exits 1", async () => {
	const lastByteFf = rewrite(baseline, (entry) => entry.kind === "out" && entry.hex.startsWith("1101"), 0, (entry) => (entry.kind === "out" ? { ...entry, hex: `${entry.hex.slice(0, 126)}ff` } : entry));
	const write = `1f0400000000${"ab".repeat(26)}`.padEnd(128, "0");
	const cases: readonly [string, Transcript, string][] = [
		["a RESET to app whose last byte is ff", lastByteFf, `${"1101".padEnd(126, "0")}ff`],
		["an appended 1f 04 frame", appended(baseline, { t: (baseline.entries.at(-1)?.t ?? 0) + 1, kind: "out", hex: write }), write],
	];
	const dir = mkdtempSync(join(tmpdir(), "u1-verdict-"));
	try {
		for (const [why, transcript, off] of cases) {
			const result = await verdict(transcript);
			expect({ why, failing: result.checks.filter((check) => !check.pass).map((check) => check.id), frames: result.frames.pass, passes: passes(result) }).toEqual({ why, failing: [], frames: false, passes: false });
			expect(result.frames.detail).toContain(off);
			const { code, lines, out } = await runCli(real(transcript), dir, why.replaceAll(" ", "-"));
			expect({ why, code, gate: lines.find((line) => line.includes("Every frame sent")) }).toEqual({ why, code: 1, gate: expect.stringMatching(/^FAIL Every frame sent is one of the nine golden frames\n.*not golden/) });
			expect(JSON.parse(readFileSync(out, "utf8")).frames.pass).toBe(false);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the CLI exits 2 with one line naming the file, and writes nothing, for a transcript it cannot read", async () => {
	const dir = mkdtempSync(join(tmpdir(), "u1-verdict-"));
	const errors = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		const cases: readonly [string, string | null][] = [
			["empty-object.json", "{}"],
			["not-json.json", "not json"],
			["missing.json", null],
		];
		for (const [name, contents] of cases) {
			const file = join(dir, name);
			if (contents !== null) writeFileSync(file, contents);
			const out = join(dir, `${name}-fixture.json`);
			errors.mockClear();
			const code = await verdictMain([file, "--types", "--out", out]);
			const lines = errors.mock.calls.map((args) => args.join(" "));
			expect({ name, code, written: existsSync(out), lines: lines.length }).toEqual({ name, code: 2, written: false, lines: 1 });
			expect(lines[0]).toStartWith(`${file}: `);
			expect(lines[0]).not.toContain("\n");
		}
	} finally {
		errors.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the CLI refuses a real-looking transcript whose preconditions did not hold for the whole run, with exit 2 and no file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "u1-verdict-"));
	const errors = spyOn(console, "error").mockImplementation(() => undefined);
	const log = spyOn(console, "log").mockImplementation(() => undefined);
	const box = (key: string, met: boolean): TranscriptEntry => ({ t: 0, kind: "precondition", key, met });
	const ticked = [box("cableIn", true), box("karabinerLedOff", true), box("secondKeyboardAtHand", true)];
	const first = baseline.entries.findIndex((entry) => entry.kind === "out");
	const boxes = (before: readonly TranscriptEntry[], during: readonly TranscriptEntry[] = []): Transcript =>
		real({ ...baseline, entries: [...before, ...baseline.entries.slice(0, first + 1), ...during, ...baseline.entries.slice(first + 1)] });
	try {
		const { cableIn: _cableIn, ...noCable } = real(baseline).environment;
		const cases: readonly [string, Transcript, string][] = [
			["no cableIn key", { ...baseline, environment: noCable }, "The cable is in"],
			["secondKeyboardAtHand no", real(baseline, { secondKeyboardAtHand: "no" }), "A second keyboard is at hand"],
			["a box unticked when the first frame went out", boxes([...ticked, box("cableIn", false)]), "The cable is in"],
			["a box changed after the first frame", boxes(ticked, [box("karabinerLedOff", false), box("karabinerLedOff", true)]), "Karabiner's LED manipulation is off"],
		];
		for (const [why, transcript, unmet] of cases) {
			const file = join(dir, `${why.replaceAll(" ", "-")}.json`);
			writeFileSync(file, JSON.stringify(transcript));
			const out = join(dir, `${why.replaceAll(" ", "-")}-fixture.json`);
			errors.mockClear();
			expect({ why, code: await verdictMain([file, "--types", "--out", out]), written: existsSync(out) }).toEqual({ why, code: 2, written: false });
			expect(errors.mock.calls.map((args) => args.join(" "))).toEqual([`the transcript does not record these preconditions as met for the whole run: ${unmet}. Wrote nothing.`]);
		}
		const held = join(dir, "held.json");
		writeFileSync(held, JSON.stringify(boxes(ticked)));
		expect(await verdictMain([held, "--types", "--out", join(dir, "held-fixture.json")])).toBe(1);
	} finally {
		log.mockRestore();
		errors.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the CLI refuses a fake, dirty, unknown, or unnamed build with exit 2 and writes nothing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "u1-verdict-"));
	try {
		const { tool: _tool, ...noTool } = real(baseline).environment;
		const cases: readonly Transcript[] = [
			real(baseline, { fake: "plain" }),
			real(baseline, { tool: "abc1234-dirty" }),
			real(baseline, { tool: "unknown" }),
			{ ...baseline, environment: { ...noTool, fake: "no" } },
		];
		for (const [i, transcript] of cases.entries()) {
			const file = join(dir, `transcript-${i}.json`);
			writeFileSync(file, JSON.stringify(transcript));
			const out = join(dir, `fixture-${i}.json`);
			expect(await verdictMain([file, "--types", "--out", out])).toBe(2);
			expect(existsSync(out)).toBe(false);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../core/firmware";
import { type TypingObservation, type U1Expected, evaluateU1 } from "../lab/u1-checks";
import { U1_EXPECTED } from "../lab/u1-job";
import { verdictMain } from "../tools/u1-verdict";
import { TARGET, recordFakeRun } from "./fake-run";
import { syntheticVersionBlock } from "./fake-tab60";
import { VENDOR_COLLECTION } from "./fake-webhid";
import type { Transcript, TranscriptEntry } from "./transcript";

const fakeExpected: U1Expected = { ...U1_EXPECTED, versionPageSha256: await sha256(syntheticVersionBlock()), probeSpacingMs: 0 };

/** The page records a typing entry when the field changes after the confirm pick's open. */
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
	expect(result.checks.map((check) => `${check.id}:${check.pass}`)).toEqual(["1:true", "2:true", "3:true", "4:true", "5:true", "6:true", "7:true", "8:true", "9:true"]);
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

test("check 5 fails when FW INFO disagrees with the layout, or answers FF AA", async () => {
	expect(await failing(rewrite(baseline, reply("1201"), 0, withHex(8, "00040000")))).toEqual([5]);
	expect(await failing(rewrite(baseline, reply("1201"), 0, refusedReply))).toEqual([5]);
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
	const noConfirmPick = typed({ ...untyped, entries: untyped.entries.filter((entry) => !(entry.kind === "pick" && entry.reason === "confirm-normal-mode")) });
	expect(await failing(noConfirmPick)).toEqual([8]);
	expect(await detail(noConfirmPick, 8)).toMatch(/did not come from the confirm-normal-mode pick/);
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

test("findings name nonzero reply bytes 2..3, FF AA replies, and frames off the golden list", async () => {
	const nonzero = rewrite(baseline, reply("1202"), 3, withHex(4, "beef"));
	expect((await verdict(nonzero)).findings).toEqual(["reply bytes 2..3 nonzero in 1 replies: 0xefbe"]);
	const refused = rewrite(baseline, reply("1220"), 0, withHex(0, "ffaa"));
	expect((await verdict(refused)).findings).toEqual(["1 FF AA replies to: 12/20"]);
	const junk = "1202dead".padEnd(128, "0");
	const off = appended(baseline, { t: 0, kind: "out", hex: junk });
	expect((await verdict(off)).findings).toEqual(["1 requests unanswered: 12/02", `1 frames are not among the nine golden frames: ${junk}`]);
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

const real = (transcript: Transcript, environment: Partial<Transcript["environment"]> = {}): Transcript => ({
	...transcript,
	environment: { ...transcript.environment, fake: "no", tool: "abc1234", ...environment },
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
		expect(fixture.checks.filter((check: { pass: boolean }) => !check.pass).map((check: { id: number }) => check.id)).toEqual([6, 9]);
		expect(fixture.transcript.entries).toHaveLength(baseline.entries.length);
		expect(await verdictMain([file])).toBe(2);
	} finally {
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

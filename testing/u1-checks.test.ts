import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../core/firmware";
import { type U1Expected, U1_EXPECTED, evaluateU1 } from "../lab/u1-checks";
import { verdictMain } from "../tools/u1-verdict";
import { versionBlock } from "./fake-tab60";
import { VENDOR_COLLECTION } from "./fake-webhid";
import { type Transcript, type TranscriptEntry } from "./transcript";
import { TARGET, recordFakeRun } from "./fake-run";

/** The fake's page is V1.01.13-shaped, not the vendor's bytes, so the fake run is judged against its own hash. */
const fakeExpected: U1Expected = { ...U1_EXPECTED, versionPageSha256: await sha256(versionBlock()) };
const baseline = (await recordFakeRun()).transcript;

const verdict = (transcript: Transcript, boardTypes: boolean | null = true) => evaluateU1(transcript, { expected: fakeExpected, boardTypes });
const failing = async (transcript: Transcript, boardTypes: boolean | null = true) => (await verdict(transcript, boardTypes)).checks.filter((check) => !check.pass).map((check) => check.id);

/** A copy of the transcript with one entry rewritten: the `n`th entry the predicate matches (0-based). */
function rewrite(transcript: Transcript, matches: (entry: TranscriptEntry) => boolean, n: number, change: (entry: TranscriptEntry) => TranscriptEntry): Transcript {
	let seen = 0;
	const entries = transcript.entries.map((entry) => (matches(entry) && seen++ === n ? change(entry) : entry));
	if (seen <= n) throw new Error(`only ${seen} entries matched`);
	return { ...transcript, entries };
}
const reply = (prefix: string) => (entry: TranscriptEntry) => entry.kind === "in" && entry.hex.startsWith(prefix);
const withHex = (at: number, hex: string) => (entry: TranscriptEntry) => entry.kind === "in" ? { ...entry, hex: entry.hex.slice(0, at) + hex + entry.hex.slice(at + hex.length) } : entry;

test("the default fake run passes every check, with no findings, over the nine commands", async () => {
	const result = await verdict(baseline);
	expect(result.checks.map((check) => `${check.id}:${check.pass}`)).toEqual(["1:true", "2:true", "3:true", "4:true", "5:true", "6:true", "7:true", "8:true", "9:true"]);
	expect(result.findings).toEqual([]);
	expect(result.commands).toEqual(["12/02", "12/00", "12/20", "12/21", "12/22", "11/00", "12/01", "1d/01", "11/01"]);
});

test("check 1 fails when the Deep check chooser closed empty and a parked pick was needed", async () => {
	const { transcript } = await recordFakeRun({ hid: { rowAppearsInOpenChooser: false }, autoPick: true });
	expect(await failing(transcript)).toEqual([1]);
	expect((await verdict(transcript)).checks[0]?.detail).toMatch(/needed a second click/);
});

test("check 2 fails when the update-mode device has a second collection", async () => {
	const { transcript } = await recordFakeRun({ hid: { collections: [VENDOR_COLLECTION, { ...VENDOR_COLLECTION, usagePage: 1, usage: 6 }] } });
	expect(await failing(transcript)).toEqual([2]);
});

test("check 3 fails when READ MODE answers the other mode's byte", async () => {
	const transcript = rewrite(baseline, reply("12020000" + "00"), 0, withHex(8, "01"));
	expect(await failing(transcript)).toEqual([3]);
});

test("check 4 fails when BL info's identity bytes differ", async () => {
	const transcript = rewrite(baseline, reply("1200"), 0, withHex(8 + 2 * 8, "d9048212"));
	expect(await failing(transcript)).toEqual([4]);
});

test("check 5 fails when FW INFO disagrees with the layout", async () => {
	const transcript = rewrite(baseline, reply("1201"), 0, withHex(8, "00040000"));
	expect(await failing(transcript)).toEqual([5]);
});

test("check 6 fails when the version page hashes differently", async () => {
	const { transcript } = await recordFakeRun({ board: { versionBlock: versionBlock("V9.99.99") } });
	expect(await failing(transcript)).toEqual([6]);
});

test("check 7 fails when the image sums differently", async () => {
	const { transcript } = await recordFakeRun({ board: { target: { ...TARGET, wireSum32: 0x11111111 } } });
	expect(await failing(transcript)).toEqual([7]);
});

test("check 8 fails without the human observation, and names what is missing", async () => {
	expect(await failing(baseline, false)).toEqual([8]);
	expect(await failing(baseline, null)).toEqual([8]);
	expect((await verdict(baseline, null)).checks[7]?.detail).toMatch(/typing not observed yet/);
});

test("check 9 fails on a short probe series and on a slow answer", async () => {
	const { transcript: short } = await recordFakeRun({ series: { probes: 29, everyMs: 1 } });
	expect(await failing(short)).toEqual([9]);
	let seen = 0;
	const slow: Transcript = {
		...baseline,
		entries: baseline.entries.map((entry) => (entry.kind === "in" && entry.hex.startsWith("1202") && ++seen === 20 ? { ...entry, t: entry.t + 2_000 } : entry)),
	};
	expect(await failing(slow)).toEqual([9]);
	expect((await verdict(slow)).checks[8]?.detail).toMatch(/longest gap 2\d\d\d ms/);
});

test("findings name nonzero reply bytes 2..3, FF AA replies, and frames outside the nine", async () => {
	const nonzero = rewrite(baseline, reply("1202"), 3, withHex(4, "beef"));
	expect((await verdict(nonzero)).findings).toEqual(["reply bytes 2..3 nonzero in 1 replies: 0xefbe"]);
	const refused = rewrite(baseline, reply("1220"), 0, withHex(0, "ffaa"));
	expect((await verdict(refused)).findings).toEqual(["1 FF AA replies to: 12/20"]);
	const outside: Transcript = { ...baseline, entries: [...baseline.entries, { t: 0, kind: "out", hex: "1002".padEnd(128, "0") }] };
	expect((await verdict(outside)).findings).toEqual(["1 requests unanswered: 10/02", "frames outside the nine U1 commands: 10/02"]);
});

test("the CLI writes the fixture with the transcript inside and exits by the verdict", async () => {
	const dir = mkdtempSync(join(tmpdir(), "u1-verdict-"));
	try {
		const file = join(dir, "transcript.json");
		writeFileSync(file, JSON.stringify(baseline));
		const out = join(dir, "fixtures", "u1-test.json");
		expect(await verdictMain([file, "--types", "--out", out])).toBe(1);
		const fixture = JSON.parse(readFileSync(out, "utf8"));
		expect(fixture.format).toBe("tab60kit-u1-verdict/1");
		expect(fixture.boardTypes).toBe(true);
		expect(fixture.checks.filter((check: { pass: boolean }) => !check.pass).map((check: { id: number }) => check.id)).toEqual([6]);
		expect(fixture.transcript.entries).toHaveLength(baseline.entries.length);
		expect(await verdictMain([file])).toBe(2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

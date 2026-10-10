import { expect, test } from "bun:test";
import { type U1Context, u1Clearance, u1Connect, u1DeepCheck, u1TryAgain } from "../lab/u1-job";
import { LinkTimeout } from "../core/port";
import { startWebHidLab } from "../web/webhid-port";
import { TARGET, recordFakeRun } from "./fake-run";
import { FakeTab60 } from "./fake-tab60";
import { FakeHid, FakeLocks } from "./fake-webhid";
import { type Transcript, type TranscriptEntry, recording } from "./transcript";

const pairs = (transcript: Transcript) => transcript.entries.filter((entry) => entry.kind === "out").map((entry) => entry.hex.slice(0, 4));
const probes = Array.from({ length: 30 }, () => "1202");

test("the U1 job sends exactly the expected frame sequence and nothing else", async () => {
	const { transcript, log, board } = await recordFakeRun();
	expect(pairs(transcript)).toEqual([
		...["1202", "1200", "1220", "1221", "1222"],
		...probes,
		"1100",
		...["1202", "1200", "1201", "1220", "1221", "1222", "1d01"],
		...probes,
		"1101",
		...["1202", "1200"],
	]);
	expect(new Set(pairs(transcript))).toEqual(new Set(["1202", "1200", "1201", "1220", "1221", "1222", "1d01", "1100", "1101"]));
	expect(board.violations).toEqual([]);
	expect(board.mode).toBe("app");
	expect(transcript.entries.filter((entry) => entry.kind === "opened").map((entry) => entry.productId)).toEqual([0x0304, 0x1304, 0x0304]);
	expect(log.at(-1)).toBe("end: boot target boots-unchecked-image, back app");
	const sum = transcript.entries.find((entry) => entry.kind === "out" && entry.hex.startsWith("1d01"));
	expect(sum?.kind === "out" ? sum.hex.slice(8, 24) : null).toBe("00020000dc850000");
});

test("every request but the two resets is answered, and the replies echo bytes 2..3 as zero", async () => {
	const { transcript } = await recordFakeRun();
	const entries = transcript.entries;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		if (entry.kind !== "out" || entry.hex.startsWith("11")) continue;
		const next = entries[i + 1];
		expect(next?.kind).toBe("in");
		if (next?.kind === "in") {
			expect(next.hex.slice(0, 4)).toBe(entry.hex.slice(0, 4));
			expect(next.hex.slice(4, 8)).toBe("0000");
		}
	}
});

test("a bootloader that answers nothing times out, and Try again resumes from the granted device", async () => {
	const board = new FakeTab60({ starting: "official-image", target: TARGET });
	const hid = new FakeHid(board, { rowAppearsInOpenChooser: ["app", "iap"], isActive: () => true });
	const entries: TranscriptEntry[] = [];
	const { port } = startWebHidLab(hid, new FakeLocks(), { wrap: (link) => recording(link, (entry) => entries.push(entry)), onEvent: (event) => entries.push({ t: 0, ...event }) });
	const ctx: U1Context = { port, clearance: u1Clearance(), signal: new AbortController().signal, log: () => undefined, series: { probes: 2, everyMs: 1 } };
	const connected = await u1Connect(ctx);
	if (connected.kind !== "connected") throw new Error("refused");
	board.ignoreInIap = true;
	await expect(u1DeepCheck(connected.session, ctx)).rejects.toBeInstanceOf(LinkTimeout);
	expect(entries.filter((entry) => entry.kind === "pick")).toHaveLength(2);
	board.ignoreInIap = false;
	const end = await u1TryAgain(ctx);
	expect(end.kind).toBe("done");
	expect(entries.filter((entry) => entry.kind === "pick")).toHaveLength(3);
	expect(entries.filter((entry) => entry.kind === "opened").map((entry) => entry.productId)).toEqual([0x0304, 0x1304, 0x1304, 0x0304]);
}, 10_000);

import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageBytes } from "../core/firmware";
import type { DevicePort } from "../core/port";
import { type KeylogTrial, PHRASE, perfectTrial } from "../lab/keylog-trial";
import { U7_PRECONDITIONS, U7_STEPS, type UserStep, attestEntry, catalogImage, framesOutsideU7, runU7, u7Clearance, u7Preconditions } from "../lab/u7-run";
import { FrameNotAllowed, U7_CURSORS, U7_ERASES, onlyU7Targets, u7Wrap } from "../lab/u7-frames";
import { TITLES, evaluateU7, expectedFor, verdictMain } from "../tools/u7-verdict";
import { startWebHidLab } from "../web/webhid-port";
import { FakeTab60, type FakeOptions } from "./fake-tab60";
import { FakeHid, FakeLocks } from "./fake-webhid";
import { ScriptedLink, fromHex } from "./scripted";
import { syntheticFlashable } from "./synthetic-image";
import { type Transcript, type TranscriptEntry, parseTranscript, replayPort } from "./transcript";

const image = await syntheticFlashable();
const expected = expectedFor(image);
const target = { imageBytes: image.entry.image.bytes, wireSum32: image.entry.image.wireSum32 };
const live = new AbortController().signal;
const ticks = U7_PRECONDITIONS.map(({ key }): TranscriptEntry => ({ t: 0, kind: "precondition", key, met: true }));

interface User {
	readonly answer?: (step: UserStep) => boolean;
	readonly type?: (trial: number) => KeylogTrial;
}

/** The board the user has today: V1.01.13 (here the synthetic image) in normal mode. */
function fakeBoard(options: Partial<FakeOptions> = {}): FakeTab60 {
	return new FakeTab60({ starting: "official-image", versionBlock: imageBytes(image).versionBlock.bytes, target, clock: "virtual", reenumerateAfterMs: 0, ...options });
}

/** What lab/u7.ts does, on the fake's virtual clock, so the 15 s link gate costs no wall time and shows in the stamps. */
async function runOnFake(user: User = {}, options: Partial<FakeOptions> = {}) {
	const board = fakeBoard(options);
	const entries: TranscriptEntry[] = [...ticks];
	const now = () => board.clock.now();
	const base = board.port();
	const port: DevicePort = { ...base, open: async (want, signal) => u7Wrap((entry) => entries.push(entry), now)(await base.open(want, signal)) };
	let trial = 0;
	const outcomes = await runU7({
		port,
		clearance: u7Clearance(),
		image,
		signal: live,
		attend: async (step) => {
			const attestation = { answer: user.answer?.(step) ?? true, keys: [] };
			entries.push(attestEntry(step, attestation, now()));
			return attestation;
		},
		type: async () => (user.type ?? (() => perfectTrial(now())))(++trial),
		mark: (step, text) => entries.push({ t: now(), kind: "mark", step, text }),
		progress: () => undefined,
		onStep: () => undefined,
	});
	const transcript: Transcript = {
		format: "tab60kit-transcript/1",
		recordedAt: "2026-10-26T00:00:00.000Z",
		environment: { fake: "no", tool: "abc1234", ...u7Preconditions.preconditionEnvironment(entries) },
		entries,
	};
	return { outcomes, transcript, board };
}

const failing = (transcript: Transcript) =>
	evaluateU7(transcript, expected)
		.filter(({ pass }) => !pass)
		.map(({ title, detail }) => `${title} | ${detail}`);
const titlesOf = (fails: readonly string[]) => fails.map((line) => line.split(" | ")[0]);

const clean = await runOnFake();

test("the guided run on the fake board flashes, deep-checks, and records three trials, every step passing", async () => {
	expect(clean.outcomes.map(({ id, pass }) => [id, pass])).toEqual(U7_STEPS.map((step) => [step.id, true]));
	expect(framesOutsideU7(clean.transcript.entries)).toEqual([]);
	expect(clean.board.violations).toEqual([]);
	expect(await clean.board.bootTarget()).toEqual({ mode: "app", versionPageSha256: image.entry.versionBlock.sha256 });
});

test("the U7 verdict passes the clean fake run on all nine checks", () => {
	const checks = evaluateU7(clean.transcript, expected);
	expect(checks.map(({ title, pass }) => [title, pass])).toEqual(Object.values(TITLES).map((title) => [title, true]));
	expect(checks.find(({ title }) => title === TITLES.writes)?.detail).toBe("663 of 663 chunks match and were acked, 0 resent");
	expect(checks.find(({ title }) => title === TITLES.erase)?.detail).toBe("[0x0, 0x200) then [0x200, 0x1ce00), each answered");
	expect(checks.find(({ title }) => title === TITLES.keylog)?.detail).toBe("3 trials, 0 of 162 characters missing");
});

test("D1: a run whose IAP refuses the app-region erase finishes official, and the verdict fails it on the erase check alone, naming the fallback", async () => {
	const { outcomes, transcript, board } = await runOnFake({}, { offsetErase: "error-marker" });
	expect(outcomes.every(({ pass }) => pass)).toBe(true);
	expect(board.violations).toEqual([]);
	const fails = failing(transcript);
	expect(titlesOf(fails)).toEqual([TITLES.erase]);
	expect(fails[0]).toContain("the fallback ran");
	expect(fails[0]).toContain("[0x0, 0x200), [0x200, 0x1ce00), [0x0, 0x1ce00)");
});

test("D4: a set whose read-back differs is sent again, and the verdict reports the mismatch on the cursor check alone", async () => {
	const { outcomes, transcript } = await runOnFake({}, { cursorFault: { at: 0, times: 1 } });
	expect(outcomes.every(({ pass }) => pass)).toBe(true);
	expect(failing(transcript)).toEqual([`${TITLES.cursor} | set 0x200 read back 1e00000004020000`]);
});

test("D5: a lost write ack is resent from its block's start, and the verdict passes with one chunk resent", async () => {
	const { transcript } = await runOnFake({}, { writeFault: { at: 100, times: 1, kind: "mute" } });
	const checks = evaluateU7(transcript, expected);
	expect(checks.filter(({ pass }) => !pass)).toEqual([]);
	expect(checks.find(({ title }) => title === TITLES.writes)?.detail).toBe("663 of 663 chunks match and were acked, 1 resent");
});

test("the verdict fails a write payload that is not the planned chunk, on the write check alone", () => {
	let n = 0;
	const entries = clean.transcript.entries.map((entry) => (entry.kind === "out-write" && n++ === 300 ? { ...entry, payloadSha256: "0".repeat(64) as never } : entry));
	const fails = failing({ ...clean.transcript, entries });
	expect(titlesOf(fails)).toEqual([TITLES.writes]);
	expect(fails[0]).toContain("does not match the chunk planned there");
	expect(fails[0]).toContain("1 of 663 chunks never acked");
});

test("the verdict fails a link gate with a gap over 1 s in its probes, on the gate check alone", () => {
	const { entries } = clean.transcript;
	const firstErase = entries.findIndex((entry) => entry.kind === "out" && entry.hex.startsWith("1d00"));
	const probes = entries.flatMap((entry, i) => (i < firstErase && entry.kind === "out" && entry.hex.startsWith("1202") ? [i] : []));
	// Drop three probes and their replies ten probes before the erase: a 2 s hole, so only the last 5 s count.
	const hole = new Set(probes.slice(-13, -10).flatMap((i) => [i, i + 1]));
	const fails = failing({ ...clean.transcript, entries: entries.filter((_, i) => !hole.has(i)) });
	expect(titlesOf(fails)).toEqual([TITLES.gate]);
	expect(fails[0]).toMatch(/the probes answered for 5\.\d\d s without a gap over 1 s, not 15 s/);
});

test("the verdict fails a deep check whose SUM differs, on the deep check alone", () => {
	const deepAt = clean.transcript.entries.findIndex((entry) => entry.kind === "mark" && entry.step === "deep-check");
	const sumAt = clean.transcript.entries.findIndex((entry, i) => i > deepAt && entry.kind === "out" && entry.hex.startsWith("1d01"));
	const entries = clean.transcript.entries.map((entry, i) => (i === sumAt + 1 && entry.kind === "in" ? { ...entry, hex: `1d010000deadbeef`.padEnd(128, "0") } : entry));
	const fails = failing({ ...clean.transcript, entries });
	expect(titlesOf(fails)).toEqual([TITLES.deep]);
	expect(fails[0]).toContain("SUM read 0xefbeadde");
});

test("the verdict fails the keylog bar on a lost first key, on two missing characters, and on a No to battery and Bluetooth", async () => {
	const firstLost = (trial: number): KeylogTrial => {
		const { events } = perfectTrial();
		return trial === 2 ? { typed: PHRASE.slice(1), events: events.slice(2) } : { typed: PHRASE, events };
	};
	expect(failing((await runOnFake({ type: firstLost })).transcript)).toEqual([`${TITLES.keylog} | keylog-2: the first key did not arrive first`]);
	const twoMissing = (trial: number): KeylogTrial => (trial === 3 ? { ...perfectTrial(), typed: PHRASE.replace("quick", "quik").replace("lazy", "lzy") } : perfectTrial());
	expect(failing((await runOnFake({ type: twoMissing })).transcript)).toEqual([`${TITLES.keylog} | 2 of 162 characters missing, at most 1`]);
	const no = await runOnFake({ answer: (step) => step.id !== "bluetooth" });
	expect(failing(no.transcript)).toEqual([`${TITLES.keylog} | the user did not confirm battery and Bluetooth`]);
});

test("the verdict fails a frame in a trial step and a missing tick, each on its own check", () => {
	const at = clean.transcript.entries.findIndex((entry) => entry.kind === "mark" && entry.step === "keylog-1") + 1;
	const stray = { ...clean.transcript, entries: [...clean.transcript.entries.slice(0, at), { t: 0, kind: "out", hex: "12020000".padEnd(128, "0") } as const, ...clean.transcript.entries.slice(at)] };
	expect(failing(stray)).toEqual([`${TITLES.frames} | frame 12020000 in trial step keylog-1`]);
	const unticked = { ...clean.transcript, environment: { ...clean.transcript.environment, recoveryReady: "no" } };
	expect(failing(unticked)).toEqual([`${TITLES.preconditions} | not met: ${U7_PRECONDITIONS[4].label}`]);
});

function runCli(transcript: Transcript, exe: Uint8Array | null) {
	const dir = mkdtempSync(join(tmpdir(), "u7-verdict-"));
	const file = join(dir, "transcript.json");
	const exeFile = join(dir, "updater.exe");
	writeFileSync(file, JSON.stringify(transcript));
	if (exe !== null) writeFileSync(exeFile, exe);
	const log = spyOn(console, "log").mockImplementation(() => undefined);
	const errors = spyOn(console, "error").mockImplementation(() => undefined);
	return verdictMain([file, ...(exe === null ? [] : ["--exe", exeFile]), "--out", join(dir, "out.json")], {})
		.then((code) => ({ code, errors: errors.mock.calls.map((args) => args.join(" ")) }))
		.finally(() => {
			log.mockRestore();
			errors.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		});
}

test("the U7 CLI refuses with exit 2 a fake board, a missing exe, and an exe without the catalog's V1.01.13", async () => {
	expect((await runCli({ ...clean.transcript, environment: { ...clean.transcript.environment, fake: "plain" } }, new Uint8Array(8))).code).toBe(2);
	const noExe = await runCli(clean.transcript, null);
	expect(noExe).toMatchObject({ code: 2 });
	expect(noExe.errors[0]).toStartWith("no exe: pass --exe or set TAB60_EXE");
	const junk = await runCli(clean.transcript, new Uint8Array(64));
	expect(junk.code).toBe(2);
	expect(junk.errors[0]).toContain("the exe was refused");
});

test(
	"the lab page's path on ?fake: WebHID picks on the real clock, the whole verdict passes, and the transcript replays with no divergence",
	async () => {
		const board = new FakeTab60({ starting: "official-image", versionBlock: imageBytes(image).versionBlock.bytes, target });
		const entries: TranscriptEntry[] = [...ticks];
		const { port, chooser } = startWebHidLab(new FakeHid(board, { rowAppearsInOpenChooser: ["app", "iap"], isActive: () => true }), new FakeLocks(), {
			wrap: u7Wrap((entry) => entries.push(entry)),
			onEvent: (event) => entries.push({ t: performance.now(), ...event }),
		});
		const clicker = setInterval(() => chooser.needsClick !== null && chooser.pick(), 1);
		const user = {
			attend: async (step: UserStep) => {
				const attestation = { answer: true, keys: [] };
				entries.push(attestEntry(step, attestation, performance.now()));
				return attestation;
			},
			type: async () => perfectTrial(performance.now()),
			progress: () => undefined,
			onStep: () => undefined,
		};
		try {
			const outcomes = await port.exclusive(() =>
				runU7({ port, clearance: u7Clearance(), image, signal: live, ...user, mark: (step, text) => entries.push({ t: performance.now(), kind: "mark", step, text }) }),
			);
			expect(outcomes.map(({ id, pass }) => [id, pass])).toEqual(U7_STEPS.map((step) => [step.id, true]));
		} finally {
			clearInterval(clicker);
		}
		const transcript: Transcript = { format: "tab60kit-transcript/1", recordedAt: "2026-10-26T00:00:00.000Z", environment: { fake: "plain", ...u7Preconditions.preconditionEnvironment(entries) }, entries };
		expect(failing(transcript)).toEqual([]);
		const replay = replayPort(transcript);
		const again = await runU7({ port: replay, clearance: u7Clearance(), image, signal: live, ...user, attend: async () => ({ answer: true, keys: [] }), mark: () => undefined });
		expect(replay.divergence).toBeNull();
		expect(again.every(({ pass }) => pass)).toBe(true);
		expect(replay.remaining()).toEqual([]);
	},
	60_000,
);

test("the lab wrap refuses, before the wire, an erase or a write address outside U7's set, and passes every one in it", async () => {
	const inner = new ScriptedLink("iap");
	const link = onlyU7Targets(inner);
	const send = (hex: string) => link.send(fromHex(hex.padEnd(128, "0")) as never);
	expect(U7_ERASES).toHaveLength(3);
	expect(U7_CURSORS).toHaveLength(663);
	for (const hex of [...U7_ERASES, ...U7_CURSORS]) await send(hex);
	await send("1f340000" + "ab".repeat(52));
	await send("12020000");
	expect(inner.sent).toHaveLength(3 + 663 + 2);
	await expect(send("1d000000" + "00040000" + "00020000")).rejects.toBeInstanceOf(FrameNotAllowed);
	await expect(send("1d000000" + "00000000" + "00cc0100")).rejects.toBeInstanceOf(FrameNotAllowed);
	await expect(send("1e010000" + "01020000")).rejects.toBeInstanceOf(FrameNotAllowed);
	await expect(send("1e010000" + "d0000000")).rejects.toBeInstanceOf(FrameNotAllowed);
	await expect(send("1e010000" + "00020000" + "01")).rejects.toBeInstanceOf(FrameNotAllowed);
	expect(inner.sent).toHaveLength(3 + 663 + 2);
});

/** The clean transcript's entries with the edit applied, and the indices it needs. */
function edited(edit: (entries: TranscriptEntry[], at: { readonly erases: readonly number[]; readonly probes: readonly number[] }) => void): Transcript {
	const entries = [...clean.transcript.entries];
	const outs = entries.flatMap((entry, i) => (entry.kind === "out" ? [i] : []));
	const erases = outs.filter((i) => (entries[i] as { hex: string }).hex.startsWith("1d00"));
	const before = outs.filter((i) => i < erases[0]!);
	let run = before.length;
	while (run > 0 && (entries[before[run - 1]!] as { hex: string }).hex.startsWith("1202")) run--;
	edit(entries, { erases, probes: before.slice(run) });
	return { ...clean.transcript, entries };
}
const replyAfter = (entries: readonly TranscriptEntry[], out: number) => entries.findIndex((entry, i) => i > out && entry.kind === "in");

test("M3: a gate of about 14.5 s fails, even though the attach's READ MODE answered under 1 s before the first probe", () => {
	const short = edited((entries, { probes }) => {
		const first = probes[0]!;
		entries.splice(replyAfter(entries, first), 1);
		entries.splice(first, 1);
	});
	const fails = failing(short);
	expect(titlesOf(fails)).toEqual([TITLES.gate]);
	expect(fails[0]).toMatch(/the probes answered for 14\.\d\d s without a gap over 1 s, not 15 s/);
});

test("L2: erases swapped, an erase unanswered, and a WRITE before the erases each fail the erase check", () => {
	const swapped = edited((entries, { erases: [a, b] }) => {
		const first = entries[a!]!;
		entries[a!] = { ...first, hex: (entries[b!] as { hex: string }).hex } as TranscriptEntry;
		entries[b!] = { ...entries[b!]!, hex: (first as { hex: string }).hex } as TranscriptEntry;
	});
	expect(failing(swapped)).toEqual([`${TITLES.erase} | the ERASEs were [0x200, 0x1ce00), [0x0, 0x200), planned [0x0, 0x200), [0x200, 0x1ce00)`]);
	const unanswered = edited((entries, { erases }) => void entries.splice(replyAfter(entries, erases[1]!), 1));
	expect(failing(unanswered)).toEqual([`${TITLES.erase} | ERASE [0x200, 0x1ce00) got no answer before the next frame`]);
	const early = edited((entries, { probes }) => {
		const write = entries.find((entry) => entry.kind === "out-write")!;
		entries.splice(probes[0]!, 0, write);
	});
	const fails = failing(early);
	expect(titlesOf(fails)).toEqual([TITLES.erase, TITLES.writes]);
	expect(fails[0]).toBe(`${TITLES.erase} | an ERASE went out after the first write address or WRITE`);
});

test("L2: a version block written with no SUM of the written image before it fails the write check", () => {
	const unsummed = edited((entries) => {
		const block = entries.findIndex((entry) => entry.kind === "out" && entry.hex.startsWith("1e010000" + "00000000"));
		let sum = block;
		while (!(entries[sum]?.kind === "out" && (entries[sum] as { hex: string }).hex.startsWith("1d01"))) sum--;
		entries.splice(sum, replyAfter(entries, sum) - sum + 1);
	});
	const fails = failing(unsummed);
	expect(titlesOf(fails)).toEqual([TITLES.writes]);
	expect(fails[0]).toContain("the version-block WRITE at 0x0 went out before a SUM read the written image");
});

const U7_CAPTURE = "fixtures/u7-macos.json";
const U7_TRANSCRIPT = "testing/fixtures/tab60kit-u7-2026-10-28T06-59-25-729Z.json";
const repoFile = (path: string) => JSON.parse(readFileSync(join(import.meta.dir, "..", path), "utf8"));
const exe = process.env.TAB60_EXE;

test(`${U7_CAPTURE} holds the 2026-10-28 board run byte for byte, from build bd27069 on a real board, with all nine checks passing`, () => {
	const fixture = repoFile(U7_CAPTURE);
	expect(fixture.format).toBe("tab60kit-u7-verdict/1");
	expect(fixture.transcriptFile).toBe(U7_TRANSCRIPT);
	expect(fixture.transcript).toEqual(repoFile(U7_TRANSCRIPT));
	expect(fixture.environment).toMatchObject({ fake: "no", tool: "bd27069", image: "tab60-v1.01.13-us" });
	expect(fixture.checks.map((c: { title: string; pass: boolean }) => [c.title, c.pass])).toEqual(Object.values(TITLES).map((title) => [title, true]));
});

test.skipIf(exe === undefined)("today's verdict passes the raw board transcript on every check against the real exe (set TAB60_EXE)", async () => {
	const real = await catalogImage(new Uint8Array(readFileSync(exe ?? "")));
	if (typeof real === "string") throw new Error(real);
	const checks = evaluateU7(parseTranscript(repoFile(U7_TRANSCRIPT)), expectedFor(real));
	expect(checks.filter(({ pass }) => !pass)).toEqual([]);
	expect(checks.map(({ detail }) => detail)).toEqual([
		"745 frames, all U7 rows, each in a step that sends it",
		`${U7_STEPS.length} steps in plan order`,
		"30 probes answered over 15.13 s, widest gap 0.51 s, last 0.50 s before the erase",
		"[0x0, 0x200) then [0x200, 0x1ce00), each answered",
		"2 sets, each read back",
		"663 of 663 chunks match and were acked, 0 resent",
		"SUM 0xf3d3dbd2 and version page ca529cf6…d345",
		"3 trials, 0 of 162 characters missing",
		"all ticked before the first frame, none changed",
	]);
});

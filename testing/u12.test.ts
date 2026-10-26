import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usage } from "../core/keymap";
import { U1_EXPECTED } from "../lab/u1-job";
import { type Attestation, RELOAD_INDEX, U12_KEYS, U12_PRECONDITIONS, U12_STEPS, type UserStep, attestEntry, framesOutsideU12, runU12, u12Clearance, u12Preconditions } from "../lab/u12-run";
import { TITLES, evaluateU12, verdictMain } from "../tools/u12-verdict";
import { KEYMAP_KEY, type KeyValueStore } from "../web/keymap-store";
import { targetOf } from "../web/usages";
import { startWebHidLab } from "../web/webhid-port";
import { FakeTab60, type FakeOptions } from "./fake-tab60";
import { FakeHid, FakeLocks } from "./fake-webhid";
import { type Transcript, type TranscriptEntry, parseTranscript } from "./transcript";
import { recording } from "./transcript";

const live = new AbortController().signal;
const codeOf = (u: number | null) => (u === null ? "none" : (targetOf(usage(u))?.code ?? "?"));

interface User {
	readonly answer?: (step: UserStep) => boolean;
	readonly pullsBatteries?: boolean;
	/** What the reload finds in storage: by default what the first half left there. */
	readonly afterReload?: (storage: Map<string, string>) => void;
}

/** What lab/u12.ts does: Start, the reload with the page's storage kept, then Continue on a fresh page over the same board. */
async function runOnFake(user: User = {}, options: Partial<FakeOptions> = {}) {
	const board = new FakeTab60({ starting: "official-image", target: { imageBytes: U1_EXPECTED.imageBytes, wireSum32: U1_EXPECTED.imageSum32 }, ...options });
	const entries: TranscriptEntry[] = [];
	const items = new Map<string, string>();
	const storage = (): KeyValueStore => ({ getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) });
	const attend = async (step: UserStep): Promise<Attestation> => {
		if (step.id === "battery-pull" && (user.pullsBatteries ?? true)) board.powerCycle();
		const key = U12_KEYS.find(({ from }) => step.id.endsWith(`-${from.toString(16).padStart(2, "0")}`));
		const sent = key === undefined ? [] : [codeOf(board.baseLayerPress(key.cell))];
		const attestation = { answer: user.answer?.(step) ?? true, keys: [...sent, ...sent] };
		entries.push(attestEntry(step, attestation, 0));
		return attestation;
	};
	const page = async (from: number) => {
		const { port, chooser } = startWebHidLab(new FakeHid(board, { rowAppearsInOpenChooser: ["app"], isActive: () => true }), new FakeLocks(), {
			wrap: (link) => recording(link, (entry) => entries.push(entry)),
			onEvent: (event) => entries.push({ t: 0, ...event }),
		});
		const clicker = setInterval(() => chooser.needsClick !== null && chooser.pick(), 1);
		try {
			return await port.exclusive(() =>
				runU12({ port, clearance: u12Clearance(), mode: "windows", storage, signal: live, attend, mark: (step, text) => entries.push({ t: 0, kind: "mark", step, text }), onStep: () => undefined }, from),
			);
		} finally {
			clearInterval(clicker);
		}
	};
	const first = await page(0);
	user.afterReload?.(items);
	const second = await page(RELOAD_INDEX);
	return { first, second, entries, board };
}

test("the guided run on the fake board pauses at the reload, passes every step, and leaves the five keys and the gate as the saved store has them", async () => {
	const { first, second, entries, board } = await runOnFake();
	expect(first.paused).toBe(true);
	expect(first.outcomes.map(({ id }) => id)).toEqual(U12_STEPS.slice(0, RELOAD_INDEX).map((step) => step.id));
	expect(second.paused).toBe(false);
	expect([...first.outcomes, ...second.outcomes].map(({ id, pass }) => [id, pass])).toEqual(U12_STEPS.map((step) => [step.id, true]));
	expect(framesOutsideU12(entries)).toEqual([]);
	expect(U12_KEYS.map(({ cell }) => board.baseLayerPress(cell))).toEqual(U12_KEYS.map(({ from }) => from));
	expect(entries.flatMap((entry) => (entry.kind === "attest" && entry.keys.length > 0 ? [entry.keys[0]] : []))).toEqual([
		...["Backquote", "KeyY", "ArrowUp", "Backspace", "ArrowRight"],
		...["Backquote", "KeyY", "ArrowUp", "Backspace", "ArrowRight"],
	]);
	expect(board.violations).toEqual([]);
});

test("without a real battery pull the keys still hold their overrides, so the read fails and the run stops there", async () => {
	const { second } = await runOnFake({ pullsBatteries: false });
	expect(second.outcomes.map(({ id, pass, detail }) => [id, pass, detail])).toEqual([
		["reload", true, "5 overrides on layer 0, mode windows"],
		["battery-pull", true, "yes, keys none"],
		["read-after-pull", false, "0x35 0x1c 0x52 0x2a 0x4f"],
	]);
});

test("storage emptied across the reload fails the reload step, and the stored Apply writes nothing and stops the run", async () => {
	const { second } = await runOnFake({ afterReload: (items) => items.delete(KEYMAP_KEY) });
	expect(second.outcomes.map(({ id, pass }) => [id, pass])).toEqual([
		["reload", false],
		["battery-pull", true],
		["read-after-pull", true],
		["apply-stored", false],
	]);
});

test("a failed first Apply stops the run before any keylog", async () => {
	const { first, second } = await runOnFake({}, { osKeyMode: 0x20 });
	expect(first.outcomes.map(({ id, pass }) => [id, pass])).toEqual([["apply-five", false]]);
	expect(first.paused).toBe(false);
	expect(second.outcomes[0]?.id).toBe("reload");
});

const ticks = U12_PRECONDITIONS.map(({ key }): TranscriptEntry => ({ t: 0, kind: "precondition", key, met: true }));

async function savedTranscript(user: User = {}, boxes = ticks): Promise<Transcript> {
	const { entries } = await runOnFake(user);
	const all = [...boxes, ...entries];
	return {
		format: "tab60kit-transcript/1",
		recordedAt: "2026-10-24T00:00:00.000Z",
		environment: { fake: "no", tool: "abc1234", osKeyMode: "windows", ...u12Preconditions.preconditionEnvironment(all) },
		entries: all,
	};
}

function runVerdict(transcript: Transcript) {
	const dir = mkdtempSync(join(tmpdir(), "u12-verdict-"));
	const file = join(dir, "transcript.json");
	const out = join(dir, "fixtures", "u12-test.json");
	writeFileSync(file, JSON.stringify(transcript));
	const log = spyOn(console, "log").mockImplementation(() => undefined);
	const errors = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		const code = verdictMain([file, "--out", out]);
		const written = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
		const fails = log.mock.calls.map((args) => args.join(" ")).flatMap((line) => (line.startsWith("FAIL ") && line.includes("\n") ? [`${line.split("\n")[0]!.slice(5)} | ${line.split("\n")[1]!.trim()}`] : []));
		return { code, written, fails, errors: errors.mock.calls.map((args) => args.join(" ")) };
	} finally {
		log.mockRestore();
		errors.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The transcript with the "in" entry answering the `nth` frame that starts with `head` replaced by `reply`. */
function withReply(transcript: Transcript, head: string, nth: number, reply: string): Transcript {
	let seen = -1;
	let target = -1;
	transcript.entries.forEach((entry, i) => {
		if (entry.kind === "out" && entry.hex.startsWith(head) && ++seen === nth) target = i;
	});
	const at = transcript.entries.findIndex((entry, i) => i > target && entry.kind === "in");
	return { ...transcript, entries: transcript.entries.map((entry, i) => (i === at ? { t: entry.t, kind: "in", hex: reply.padEnd(128, "0") } : entry)) };
}

test("the U12 verdict passes a clean run and writes the capture", async () => {
	const transcript = await savedTranscript();
	const { code, written, fails } = runVerdict(transcript);
	expect({ code, fails }).toEqual({ code: 0, fails: [] });
	expect(written.format).toBe("tab60kit-u12-verdict/1");
	expect(written.checks.map((c: { title: string; pass: boolean }) => [c.title, c.pass])).toEqual(Object.values(TITLES).map((title) => [title, true]));
});

test("the U12 verdict refuses a fake board with exit 2 and writes nothing", async () => {
	const transcript = await savedTranscript();
	const { code, written } = runVerdict({ ...transcript, environment: { ...transcript.environment, fake: "plain" } });
	expect({ code, written }).toEqual({ code: 2, written: null });
});

test("the U12 verdict fails a run without a battery pull on the pull read, and on every step the stopped run never reached", async () => {
	const { code, fails } = runVerdict(await savedTranscript({ pullsBatteries: false }));
	expect(code).toBe(1);
	expect(fails.map((line) => line.split(" | ")[0])).toEqual([TITLES.order, TITLES.applied, TITLES.keylog, TITLES.pull, TITLES.restore]);
	expect(fails[3]).toContain("read-after-pull: wanted 52202900ff00, got 52202900 reading 522029003500");
	expect(fails[1]).toContain("apply-stored: not where the plan puts it");
});

test("the U12 verdict fails a write in a read step, and a frame after an attestation, on the frame check", async () => {
	const transcript = await savedTranscript();
	const insertAfter = (pick: (entry: TranscriptEntry) => boolean): Transcript => {
		const at = transcript.entries.findIndex(pick) + 1;
		return { ...transcript, entries: [...transcript.entries.slice(0, at), { t: 0, kind: "out", hex: "51202900ff00".padEnd(128, "0") }, ...transcript.entries.slice(at)] };
	};
	const inRead = runVerdict(insertAfter((entry) => entry.kind === "mark" && entry.step === "read-after-pull")).fails;
	expect(inRead).toEqual([`${TITLES.frames} | frame 51202900ff00 in read step read-after-pull`]);
	const afterAttest = runVerdict(insertAfter((entry) => entry.kind === "attest" && entry.step === "battery-pull")).fails;
	expect(afterAttest).toEqual([`${TITLES.frames} | frame 51202900ff00 in user step battery-pull`]);
});

test("the U12 verdict fails a wrong write reply, a gate left open, an emptied storage, a No, and a missing tick each on its own check", async () => {
	const transcript = await savedTranscript();
	expect(runVerdict(withReply(transcript, "51203800", 0, "512038000400")).fails).toEqual([`${TITLES.applied} | apply-five: 512038005200 got 5120380004000000`]);
	expect(runVerdict(withReply(transcript, "41ff", 1, "41800000")).fails.map((line) => line.split(" | ")[0])).toEqual([TITLES.applied]);
	const emptied = { ...transcript, entries: transcript.entries.map((entry) => (entry.kind === "mark" && entry.step === "reload" ? { ...entry, text: "{}" } : entry)) };
	expect(runVerdict(emptied).fails).toEqual([`${TITLES.reload} | storage held "{}"`]);
	const no = await savedTranscript({ answer: (step) => step.id !== "keylog-again-38" });
	expect(runVerdict(no).fails).toEqual([`${TITLES.keylog} | keylog-again-38: the user answered no`]);
	expect(runVerdict(await savedTranscript({}, ticks.slice(1))).fails).toEqual([`${TITLES.preconditions} | not met: ${U12_PRECONDITIONS[0].label}`]);
	const noMode = { ...transcript, environment: { ...transcript.environment, osKeyMode: "" } };
	expect(runVerdict(noMode).fails).toEqual([`${TITLES.preconditions} | environment.osKeyMode is "", not a mode`]);
});

test("the U12 verdict fails a stray frame on the frame gate, and a missing attestation on the plan order", async () => {
	const transcript = await savedTranscript();
	const at = transcript.entries.findIndex((entry) => entry.kind === "attest");
	const stray = { ...transcript, entries: [...transcript.entries.slice(0, at), { t: 0, kind: "out", hex: "50550000".padEnd(128, "0") } as const, ...transcript.entries.slice(at)] };
	expect(runVerdict(stray).fails.map((line) => line.split(" | ")[0])).toEqual([TITLES.frames]);
	const missing = { ...transcript, entries: transcript.entries.filter((entry) => !(entry.kind === "attest" && entry.step === "battery-pull")) };
	const fails = runVerdict(missing).fails;
	expect(fails[0]).toStartWith(`${TITLES.order} | step ${RELOAD_INDEX + 2} (battery-pull): planned attest battery-pull, got mark read-after-pull`);
});

const U12_CAPTURE = "fixtures/u12-macos.json";
const U12_TRANSCRIPT = "testing/fixtures/tab60kit-u12-2026-10-24T13-36-22-812Z.json";
const repoFile = (path: string) => JSON.parse(readFileSync(join(import.meta.dir, "..", path), "utf8"));

test(`${U12_CAPTURE} holds the 2026-10-24 board run byte for byte, in Mac mode, with all eight checks passing`, () => {
	const fixture = repoFile(U12_CAPTURE);
	expect(fixture.format).toBe("tab60kit-u12-verdict/1");
	expect(fixture.transcriptFile).toBe(U12_TRANSCRIPT);
	expect(fixture.transcript).toEqual(repoFile(U12_TRANSCRIPT));
	expect(fixture.environment).toMatchObject({ fake: "no", tool: "57352b7", osKeyMode: "mac" });
	expect(fixture.checks.map((c: { title: string; pass: boolean }) => [c.title, c.pass])).toEqual(Object.values(TITLES).map((title) => [title, true]));
});

test("today's verdict passes the raw board transcript on every check: 464 frames, 17 steps", () => {
	const transcript = parseTranscript(repoFile(U12_TRANSCRIPT));
	const checks = evaluateU12(transcript);
	expect(checks.filter(({ pass }) => !pass)).toEqual([]);
	expect(checks[0]?.detail).toBe("464 frames, all U12 rows, each in a step that sends it");
	expect(checks[1]?.detail).toBe(`${U12_STEPS.length} steps in plan order`);
});

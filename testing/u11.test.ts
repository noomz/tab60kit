import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceRefused, SHIPPED } from "../core/protocol";
import { U1_EXPECTED } from "../lab/u1-job";
import { type Attestation, U11_PRECONDITIONS, U11_STEPS, type UserStep, attestEntry, framesOutsideU11, runU11, u11Clearance, u11Preconditions } from "../lab/u11-run";
import { verdictMain } from "../tools/u11-verdict";
import { startWebHidLab } from "../web/webhid-port";
import { FakeTab60, type FakeOptions } from "./fake-tab60";
import { FakeHid, FakeLocks } from "./fake-webhid";
import { type Transcript, type TranscriptEntry, recording } from "./transcript";

const live = new AbortController().signal;
const CAPS_LOCK_CELL = 4;
const CODES: Readonly<Record<number, string>> = { 0x39: "CapsLock", 0xe0: "ControlLeft" };

/** How the user behaves at each step: by default they type the key the board sends, answer yes, and really power-cycle. */
interface User {
	readonly answer?: (step: UserStep) => boolean;
	readonly powerCycles?: boolean;
}

/** What lab/u11.ts does on the page: one Start, recorded through the same WebHID shell, with the user played by the test. */
async function runOnFake(user: User = {}, options: Partial<FakeOptions> = {}, clearance = u11Clearance()) {
	const board = new FakeTab60({ starting: "official-image", target: { imageBytes: U1_EXPECTED.imageBytes, wireSum32: U1_EXPECTED.imageSum32 }, ...options });
	const entries: TranscriptEntry[] = [];
	const { port, chooser } = startWebHidLab(new FakeHid(board, { rowAppearsInOpenChooser: ["app"], isActive: () => true }), new FakeLocks(), {
		wrap: (link) => recording(link, (entry) => entries.push(entry)),
		onEvent: (event) => entries.push({ t: 0, ...event }),
	});
	const attend = async (step: UserStep): Promise<Attestation> => {
		if (step.id === "power-cycle" && (user.powerCycles ?? true)) board.powerCycle();
		const sent = board.baseLayerPress(CAPS_LOCK_CELL);
		const attestation = { answer: user.answer?.(step) ?? true, keys: step.keylog === null || sent === null ? [] : [CODES[sent] ?? "?", CODES[sent] ?? "?"] };
		entries.push(attestEntry(step, attestation, 0));
		return attestation;
	};
	const clicker = setInterval(() => chooser.needsClick !== null && chooser.pick(), 1);
	try {
		const run = await port.exclusive(() => runU11(port, clearance, attend, () => undefined, live)).then(
			(outcomes) => ({ ok: true, outcomes }) as const,
			(error: unknown) => ({ ok: false, error }) as const,
		);
		const sent = entries.flatMap((entry) => (entry.kind === "out" ? [entry.hex] : []));
		return { run, sent, entries, board };
	} finally {
		clearInterval(clicker);
	}
}

const ATTACH = ["12020000", "12000000"];

test("the guided run on the fake board passes every step, sends exactly the plan, and leaves Caps Lock and the gate as the saved store has them", async () => {
	const { run, sent, entries, board } = await runOnFake();
	if (!run.ok) throw run.error;
	expect(run.outcomes.map(({ id, pass }) => [id, pass])).toEqual(U11_STEPS.map((step) => [step.id, true]));
	const segment = (...frames: string[]) => [...ATTACH, ...frames].map((head) => head.padEnd(12, "0"));
	expect(sent.map((frame) => frame.slice(0, 12))).toEqual([
		...segment("41ff0000", "41800000", "51203900e000", "52203900"),
		...segment("51203900ff00", "52203900", "41000000", "41ff0000", "41800000", "51203900e000", "52203900"),
		...segment("41ff0000", "52203900"),
	]);
	expect(sent.every((frame) => /^0*$/.test(frame.slice(12)))).toBe(true);
	expect(framesOutsideU11(entries)).toEqual([]);
	expect(entries.flatMap((entry) => (entry.kind === "attest" ? [[entry.step, entry.keys]] : []))).toEqual([
		["keylog-usb", ["ControlLeft", "ControlLeft"]],
		["keylog-bluetooth", ["ControlLeft", "ControlLeft"]],
		["power-cycle", []],
		["keylog-after-power", ["CapsLock", "CapsLock"]],
	]);
	expect(board.baseLayerPress(CAPS_LOCK_CELL)).toBe(0x39);
	expect(board.violations).toEqual([]);
});

test("without a real power cycle the second write survives, so the read-back and the keylog after it fail", async () => {
	const { run } = await runOnFake({ powerCycles: false });
	if (!run.ok) throw run.error;
	expect(run.outcomes.filter(({ pass }) => !pass).map(({ id, detail }) => [id, detail])).toEqual([
		["query-after-power", "gate 0x80 timer 0"],
		["read-after-power", "read back override 0xe0 flags 0"],
		["keylog-after-power", "yes, keys ControlLeft ControlLeft"],
	]);
});

test("a No from the user fails that step and the run goes on", async () => {
	const { run } = await runOnFake({ answer: (step) => step.id !== "keylog-bluetooth" });
	if (!run.ok) throw run.error;
	expect(run.outcomes.filter(({ pass }) => !pass).map(({ id }) => id)).toEqual(["keylog-bluetooth"]);
	expect(run.outcomes).toHaveLength(U11_STEPS.length);
});

test("a key write the board refuses stops the run with DeviceRefused before the read-back", async () => {
	const { run, sent } = await runOnFake({}, { refuseAlways: { cmd: 0x51, sub: 0x20 } });
	expect(run.ok ? null : run.error).toBeInstanceOf(DeviceRefused);
	expect(sent.map((frame) => frame.slice(0, 4))).toEqual(["1202", "1200", "41ff", "4180", "5120"]);
});

test("the shipped clearance sends the confirmed U11 rows and passes every step", async () => {
	const { run, entries } = await runOnFake({}, {}, SHIPPED);
	if (!run.ok) throw run.error;
	expect(run.outcomes.map(({ id, pass }) => [id, pass])).toEqual(U11_STEPS.map((step) => [step.id, true]));
	expect(framesOutsideU11(entries)).toEqual([]);
});

const ticks = U11_PRECONDITIONS.map(({ key }): TranscriptEntry => ({ t: 0, kind: "precondition", key, met: true }));

/** A saved page transcript as a real board and a clean build would record it, from a run on the fake board. */
async function savedTranscript(user: User = {}, boxes = ticks): Promise<Transcript> {
	const { run, entries } = await runOnFake(user);
	if (!run.ok) throw run.error;
	const all = [...boxes, ...entries];
	return {
		format: "tab60kit-transcript/1",
		recordedAt: "2026-10-19T00:00:00.000Z",
		environment: { fake: "no", tool: "abc1234", ...u11Preconditions.preconditionEnvironment(all) },
		entries: all,
	};
}

function runVerdict(transcript: Transcript) {
	const dir = mkdtempSync(join(tmpdir(), "u11-verdict-"));
	const file = join(dir, "transcript.json");
	const out = join(dir, "fixtures", "u11-test.json");
	writeFileSync(file, JSON.stringify(transcript));
	const log = spyOn(console, "log").mockImplementation(() => undefined);
	const errors = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		const code = verdictMain([file, "--out", out]);
		const written = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
		const lines = log.mock.calls.map((args) => args.join(" "));
		const fails = lines.flatMap((line, i) => (line.startsWith("FAIL ") ? [`${line.split("\n")[0]!.slice(5)} | ${(line.split("\n")[1] ?? lines[i + 1] ?? "").trim()}`] : []));
		return { code, written, fails, errors: errors.mock.calls.map((args) => args.join(" ")) };
	} finally {
		log.mockRestore();
		errors.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
}

const TITLES = {
	frames: "Every frame sent is one of the seven U11 rows",
	order: "The frames past each attach and the attestations follow the plan, step by step",
	gate: "The gate reads closed at the start, and each open and close is echoed",
	readBack: "Caps Lock reads back 0x00E0 after each write and 0x00FF after the restore",
	keylog: "Over USB and over Bluetooth the keylog shows ControlLeft and no CapsLock, and the user said yes",
	power: "After a power cycle with no save the gate reads 0, Caps Lock reads 0x00FF, and the keylog shows CapsLock",
	end: "The run ends with the gate closed: the last gate frame is a query that reads 0",
	preconditions: "The preconditions were ticked before the first frame and held for the run",
} as const;

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

const editAttest = (transcript: Transcript, step: string, change: Partial<Extract<TranscriptEntry, { kind: "attest" }>>): Transcript => ({
	...transcript,
	entries: transcript.entries.map((entry) => (entry.kind === "attest" && entry.step === step ? { ...entry, ...change } : entry)),
});

test("the U11 verdict passes a clean run with every precondition ticked, and writes the capture", async () => {
	const transcript = await savedTranscript();
	const { code, written, fails } = runVerdict(transcript);
	expect({ code, fails }).toEqual({ code: 0, fails: [] });
	expect(written.format).toBe("tab60kit-u11-verdict/1");
	expect(written.checks.map((c: { title: string; pass: boolean }) => [c.title, c.pass])).toEqual(Object.values(TITLES).map((title) => [title, true]));
	expect(written.transcript).toEqual(transcript);
});

test("the U11 verdict refuses a fake board and a dirty build with exit 2, and writes nothing", async () => {
	const transcript = await savedTranscript();
	for (const [environment, error] of [
		[{ ...transcript.environment, fake: "plain" }, 'environment.fake is "plain", and a fake board is not evidence. Wrote nothing.'],
		[{ ...transcript.environment, tool: "abc1234-dirty" }, 'environment.tool is "abc1234-dirty", and only a build from a clean commit is evidence. Wrote nothing.'],
	] as const) {
		const { code, written, errors } = runVerdict({ ...transcript, environment });
		expect({ code, written, errors }).toEqual({ code: 2, written: null, errors: [error] });
	}
});

test("the U11 verdict fails a run without a real power cycle on the power-cycle check and the gate-closed check", async () => {
	const { code, written, fails } = runVerdict(await savedTranscript({ powerCycles: false }));
	expect({ code, written, fails }).toEqual({
		code: 1,
		written: null,
		fails: [
			`${TITLES.power} | query-after-power: wanted 410000000000, got 4180000000000000; read-after-power: wanted 52203900ff00, got 52203900e0000000; keylog-after-power: the keylog shows no CapsLock (ControlLeft ControlLeft); keylog-after-power: the keylog shows ControlLeft`,
			`${TITLES.end} | the last gate query read 41800000`,
		],
	});
});

test("the U11 verdict fails a No over Bluetooth, and a USB keylog that shows CapsLock, on the keylog check only", async () => {
	const no = runVerdict(await savedTranscript({ answer: (step) => step.id !== "keylog-bluetooth" }));
	expect({ code: no.code, fails: no.fails }).toEqual({ code: 1, fails: [`${TITLES.keylog} | keylog-bluetooth: the user answered no`] });
	const caps = runVerdict(editAttest(await savedTranscript(), "keylog-usb", { keys: ["ControlLeft", "CapsLock"] }));
	expect(caps.fails).toEqual([`${TITLES.keylog} | keylog-usb: the keylog shows CapsLock`]);
});

test("the U11 verdict fails a wrong read-back, a gate open at the start, and a refused write on the check that owns each reply", async () => {
	const transcript = await savedTranscript();
	expect(runVerdict(withReply(transcript, "52203900", 0, "52203900e100")).fails).toEqual([`${TITLES.readBack} | read-control: wanted 52203900e000, got 52203900e1000000`]);
	expect(runVerdict(withReply(transcript, "41ff", 0, "41800000")).fails).toEqual([`${TITLES.gate} | query-start: wanted 410000000000, got 4180000000000000`]);
	expect(runVerdict(withReply(transcript, "51203900ff", 0, "ffaa000051203900")).fails).toEqual([`${TITLES.readBack} | restore: wanted 51203900ff00, got ffaa000051203900`]);
});

test("the U11 verdict fails a stray frame on the frame gate and the plan order, and a missing attestation on the plan order", async () => {
	const transcript = await savedTranscript();
	const at = transcript.entries.findIndex((entry) => entry.kind === "attest");
	const stray = { ...transcript, entries: [...transcript.entries.slice(0, at), { t: 0, kind: "out", hex: "51210000".padEnd(128, "0") } as const, ...transcript.entries.slice(at)] };
	const strayFails = runVerdict(stray).fails.map((line) => line.split(" | ")[0]);
	expect(strayFails).toEqual([TITLES.frames, TITLES.order, TITLES.gate, TITLES.readBack, TITLES.keylog, TITLES.power]);
	const missing = { ...transcript, entries: transcript.entries.filter((entry) => !(entry.kind === "attest" && entry.step === "keylog-bluetooth")) };
	const missingFails = runVerdict(missing).fails;
	expect(missingFails.map((line) => line.split(" | ")[0])).toEqual([TITLES.order, TITLES.gate, TITLES.readBack, TITLES.keylog, TITLES.power]);
	expect(missingFails[0]).toStartWith(`${TITLES.order} | step 6 (keylog-bluetooth): planned attest keylog-bluetooth, got frame 51203900ff00`);
});

test("the U11 verdict fails a precondition left unticked", async () => {
	const { fails } = runVerdict(await savedTranscript({}, ticks.slice(1)));
	expect(fails).toEqual([`${TITLES.preconditions} | not met: ${U11_PRECONDITIONS[0].label}`]);
});

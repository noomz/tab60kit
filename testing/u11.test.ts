import { expect, test } from "bun:test";
import { DeviceRefused, NotCleared, SHIPPED } from "../core/protocol";
import { U1_EXPECTED } from "../lab/u1-job";
import { type Attestation, U11_STEPS, type UserStep, attestEntry, framesOutsideU11, runU11, u11Clearance } from "../lab/u11-run";
import { startWebHidLab } from "../web/webhid-port";
import { FakeTab60, type FakeOptions } from "./fake-tab60";
import { FakeHid, FakeLocks } from "./fake-webhid";
import { type TranscriptEntry, recording } from "./transcript";

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

test("the shipped clearance stops at the gate query with NotCleared, and nothing past the attach leaves", async () => {
	const { run, sent } = await runOnFake({}, {}, SHIPPED);
	expect(run.ok ? null : run.error).toBeInstanceOf(NotCleared);
	expect(sent.map((frame) => frame.slice(0, 8))).toEqual(ATTACH);
});

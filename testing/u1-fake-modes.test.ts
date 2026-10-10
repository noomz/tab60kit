import { expect, test } from "bun:test";
import { FAKE_MODES, type FakeMode, fakeHardware } from "../lab/u1-fake";
import { type U1Context, u1Clearance, u1Run } from "../lab/u1-job";
import { type Phase, type Run, type RunOutcome, outcomeOfError, phaseAfterRun } from "../lab/u1-state";
import { startWebHidLab } from "../web/webhid-port";
import { type TranscriptEntry, recording } from "./transcript";

const PROBES = 6;
const probes = (n: number) => Array.from({ length: n }, () => "1202");
const CONNECT = ["1202", "1200", "1220", "1221", "1222", ...probes(PROBES)];
const UPDATE_ATTACH = ["1202", "1200", "1201"];
const UPDATE_OBSERVE = ["1220", "1221", "1222", "1d01"];
const HOME = ["1101", "1202", "1200"];
const UPDATE_CHECKS = [...UPDATE_ATTACH, ...UPDATE_OBSERVE, ...probes(PROBES), ...HOME];
const DEEP = ["1100", ...UPDATE_CHECKS];

interface Step {
	readonly what: Run;
	readonly frames: readonly string[];
	readonly phase: Phase["kind"];
	readonly openHandles: number;
}

/** The page's run loop without the DOM: the mode's flips, then u1Run inside the lock, then the phase the page derives. */
async function drive(mode: FakeMode, runs: readonly Run[]) {
	const fake = fakeHardware(mode, { probes: PROBES, hid: { isActive: () => true } });
	const entries: TranscriptEntry[] = [];
	const { port, chooser } = startWebHidLab(fake.hid, fake.locks, {
		wrap: (link) => recording(link, (entry) => entries.push(entry)),
		onEvent: (event) => entries.push({ t: performance.now(), ...event }),
	});
	const user = setInterval(() => chooser.needsClick?.modes.includes(fake.hid.device.mode) && chooser.pick(), 2);
	const frames = () => entries.flatMap((entry) => (entry.kind === "out" ? [entry.hex.slice(0, 4)] : []));
	const steps: Step[] = [];
	let phase: Phase = { kind: "idle" };
	try {
		for (const what of runs) {
			const before = frames().length;
			const controller = new AbortController();
			fake.adjust(what);
			const ctx: U1Context = { port, clearance: u1Clearance(), signal: controller.signal, log: () => undefined, series: { probes: PROBES, everyMs: 1 } };
			let outcome: RunOutcome;
			try {
				outcome = await port.exclusive(() => u1Run(what, phase, ctx));
			} catch (error) {
				outcome = outcomeOfError(error);
			}
			controller.abort(new DOMException("the run ended", "AbortError"));
			phase = phaseAfterRun(entries, outcome);
			steps.push({ what, frames: frames().slice(before), phase: phase.kind, openHandles: fake.hid.openHandles });
		}
	} finally {
		clearInterval(user);
	}
	if (phase.kind === "connected") await phase.app.close();
	if (phase.kind === "refused") await phase.refused.close();
	if (phase.kind === "away" && phase.holding !== null) await phase.holding.close();
	return { steps, entries, fake, finalPhase: phase.kind, openHandlesAfterClose: fake.hid.openHandles };
}

/** Per mode: the runs a user makes, and what each run sends, ends in, and leaves open. A connected or refused phase holds one link. */
const SCRIPTS: Readonly<Record<FakeMode, readonly Step[]>> = {
	plain: [
		{ what: "connect", frames: CONNECT, phase: "connected", openHandles: 1 },
		{ what: "deep-check", frames: DEEP, phase: "connected", openHandles: 1 },
	],
	parked: [
		{ what: "connect", frames: CONNECT, phase: "connected", openHandles: 1 },
		{ what: "deep-check", frames: DEEP, phase: "connected", openHandles: 1 },
	],
	deaf: [
		{ what: "connect", frames: CONNECT, phase: "connected", openHandles: 1 },
		{ what: "deep-check", frames: ["1100", "1202", "1101"], phase: "away", openHandles: 0 },
		{ what: "try-again", frames: UPDATE_CHECKS, phase: "connected", openHandles: 1 },
	],
	cancelled: [
		{ what: "connect", frames: CONNECT, phase: "connected", openHandles: 1 },
		{ what: "deep-check", frames: ["1100"], phase: "away", openHandles: 0 },
		{ what: "restart", frames: [...UPDATE_ATTACH, ...HOME], phase: "connected", openHandles: 1 },
	],
	refused: [
		{ what: "connect", frames: CONNECT, phase: "connected", openHandles: 1 },
		{ what: "deep-check", frames: ["1100", ...UPDATE_ATTACH], phase: "away", openHandles: 1 },
		{ what: "try-again", frames: UPDATE_ATTACH, phase: "away", openHandles: 1 },
		{ what: "restart", frames: HOME, phase: "connected", openHandles: 1 },
	],
	"sum-refused": [
		{ what: "connect", frames: CONNECT, phase: "connected", openHandles: 1 },
		{ what: "deep-check", frames: ["1100", ...UPDATE_ATTACH, ...UPDATE_OBSERVE, "1101"], phase: "away", openHandles: 0 },
		{ what: "connect", frames: CONNECT, phase: "connected", openHandles: 1 },
	],
	drop: [
		{ what: "connect", frames: CONNECT, phase: "connected", openHandles: 1 },
		{ what: "deep-check", frames: ["1100", ...UPDATE_ATTACH, ...UPDATE_OBSERVE, ...probes(5), "1101"], phase: "away", openHandles: 0 },
		{ what: "try-again", frames: UPDATE_CHECKS, phase: "connected", openHandles: 1 },
	],
	slow: [
		{ what: "connect", frames: CONNECT, phase: "connected", openHandles: 1 },
		{ what: "deep-check", frames: DEEP, phase: "connected", openHandles: 1 },
	],
};

for (const mode of FAKE_MODES) {
	test(`?fake=${mode}: each run sends only the nine frames, ends in its phase, and leaks no link`, async () => {
		const script = SCRIPTS[mode];
		const { steps, fake, finalPhase, openHandlesAfterClose } = await drive(
			mode,
			script.map((step) => step.what),
		);
		expect(steps).toEqual([...script]);
		expect(finalPhase).toBe("connected");
		expect(openHandlesAfterClose).toBe(0);
		expect(fake.board.violations).toEqual([]);
	}, 10_000);
}

test("?fake=drop records the RESET to app it could not send on the dropped link", async () => {
	const { entries } = await drive("drop", ["connect", "deep-check"]);
	expect(entries.filter((entry) => entry.kind === "send-failed").map((entry) => (entry.kind === "send-failed" ? entry.hex.slice(0, 4) : ""))).toEqual(["1101"]);
});

test("?fake=slow records the fifth update-mode probe's 700 ms answer instead of timing out", async () => {
	const { entries } = await drive("slow", ["connect", "deep-check"]);
	const reset = entries.findIndex((entry) => entry.kind === "out" && entry.hex.startsWith("1100"));
	const latencies: number[] = [];
	for (let i = reset; i < entries.length; i++) {
		const entry = entries[i];
		const reply = entries[i + 1];
		if (entry?.kind === "out" && entry.hex.startsWith("1202") && reply?.kind === "in") latencies.push(reply.t - entry.t);
	}
	expect(latencies.filter((ms) => ms >= 690)).toHaveLength(1);
	expect(latencies.findIndex((ms) => ms >= 690)).toBe(5);
});

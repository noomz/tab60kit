import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../core/firmware";
import { type InReport, type Link, LinkLost, LinkTimeout, PickCancelled, asInReport } from "../core/port";
import { DeviceRefused, type EgressContext, IapAttachFailed, auditEgress, clears, connect } from "../core/protocol";
import { evaluateU1 } from "../lab/u1-checks";
import { FrameNotAllowed, u1Wrap } from "../lab/u1-frames";
import { type U1Context, U1_EXPECTED, u1Clearance, u1Connect, u1DeepCheck, u1Run, u1TryAgain } from "../lab/u1-job";
import { type RunOutcome, awayFromHome, outcomeOfError, phaseAfterRun } from "../lab/u1-state";
import { startWebHidLab } from "../web/webhid-port";
import { verdictMain } from "../tools/u1-verdict";
import { TARGET, recordFakeRun } from "./fake-run";
import { type FakeOptions, FakeTab60, syntheticVersionBlock } from "./fake-tab60";
import { FakeHid, type FakeHidOptions, FakeLocks } from "./fake-webhid";
import { ScriptedLink, ScriptedPort, fromHex, report, toHex } from "./scripted";
import type { Transcript, TranscriptEntry } from "./transcript";

const PROBES = 3;
const probes = (n: number) => Array.from({ length: n }, () => "1202");
const CONNECT = ["1202", "1200", "1220", "1221", "1222", ...probes(PROBES)];
const UPDATE_ATTACH = ["1202", "1200", "1201"];
const UPDATE_OBSERVE = ["1220", "1221", "1222", "1d01"];
const CONFIRM = ["1202", "1200"];
const ROUND_TRIP = [...CONNECT, "1100", ...UPDATE_ATTACH, ...UPDATE_OBSERVE, ...probes(PROBES), "1101", ...CONFIRM];
const AWAY = { kind: "away", holding: null } as const;
const IDLE = { kind: "idle" } as const;
const cancel = () => new DOMException("cancelled from the page", "AbortError");
const once = <A extends unknown[]>(when: (...args: A) => boolean, act: (...args: A) => void) => {
	let done = false;
	return (...args: A) => {
		if (done || !when(...args)) return;
		done = true;
		act(...args);
	};
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (run: Promise<RunOutcome>) => run.catch((error: unknown) => outcomeOfError(error));
const rejection = (work: Promise<unknown>) =>
	work.then(
		() => {
			throw new Error("the run resolved");
		},
		(error: unknown) => error,
	);

interface RigOptions {
	readonly board?: Partial<FakeOptions>;
	readonly hid?: Partial<FakeHidOptions>;
	readonly wrap?: (link: Link) => Link;
	/** Wraps the link inside the recording, so the transcript shows what the page sent and how each send ended. */
	readonly inner?: (link: Link) => Link;
	readonly onEntry?: (entry: TranscriptEntry, board: FakeTab60) => void;
	readonly onLog?: (line: string, board: FakeTab60) => void;
}

function rig(options: RigOptions = {}) {
	const board = new FakeTab60({ starting: "official-image", target: TARGET, ...options.board });
	const hid = new FakeHid(board, { rowAppearsInOpenChooser: ["app", "iap"], isActive: () => true, ...options.hid });
	const entries: TranscriptEntry[] = [];
	const sink = (entry: TranscriptEntry) => {
		entries.push(entry);
		options.onEntry?.(entry, board);
	};
	const { port, chooser } = startWebHidLab(hid, new FakeLocks(), {
		wrap: (link) => {
			const lab = u1Wrap(sink)(options.inner?.(link) ?? link);
			return options.wrap?.(lab) ?? lab;
		},
		onEvent: (event) => sink({ t: performance.now(), ...event }),
	});
	const log: string[] = [];
	const ctx = (signal = new AbortController().signal): U1Context => ({
		port,
		clearance: u1Clearance(),
		signal,
		log: (line) => {
			log.push(line);
			options.onLog?.(line, board);
		},
		series: { probes: PROBES, everyMs: 1 },
	});
	const pairs = () => entries.flatMap((entry) => (entry.kind === "out" ? [entry.hex.slice(0, 4)] : []));
	const connected = async () => {
		const end = await u1Connect(ctx());
		if (end.kind !== "connected") throw new Error(`normal mode refused: ${end.refused.refusal.code}`);
		return end.session;
	};
	return { board, hid, entries, chooser, ctx, pairs, log, connected };
}

test("a Cancel at any entry of a Connect run leaves no link open, and the next Connect connects", async () => {
	const clean = rig();
	const connected = await u1Run("connect", IDLE, clean.ctx());
	if (connected.kind !== "connected") throw new Error("the clean Connect did not connect");
	const entries = clean.entries.length;
	await connected.app.close();
	let cancelled = 0;
	for (let at = 1; at <= entries; at++) {
		const controller = new AbortController();
		let seen = 0;
		const r = rig({ onEntry: () => ++seen === at && controller.abort(cancel()) });
		const outcome = await settle(u1Run("connect", IDLE, r.ctx(controller.signal)));
		if (outcome.kind === "cancelled") cancelled++;
		const phase = phaseAfterRun(r.entries, outcome);
		expect({ at, phase: phase.kind, openHandles: r.hid.openHandles }).toEqual(
			outcome.kind === "cancelled" ? { at, phase: "idle", openHandles: 0 } : { at, phase: "connected", openHandles: 1 },
		);
		const again = await u1Run("connect", phase, r.ctx());
		expect({ at, again: again.kind, openHandles: r.hid.openHandles }).toEqual({ at, again: "connected", openHandles: 1 });
		if (again.kind === "connected") await again.app.close();
	}
	expect(cancelled).toBe(entries - 2);
});

/** Replaces the third READ MODE answer, the second Connect probe's, once across every link the rig opens. */
function onThirdReadMode(replace: (reply: InReport) => InReport) {
	let readModes = 0;
	return (link: Link): Link => ({
		mode: link.mode,
		lost: link.lost,
		send: (frame) => link.send(frame),
		next: async (timeoutMs) => {
			const reply = await link.next(timeoutMs);
			return reply[0] === 0x12 && reply[1] === 0x02 && ++readModes === 3 ? replace(reply) : reply;
		},
		discardPending: () => link.discardPending(),
		close: () => link.close(),
	});
}

const probeFailures: readonly [string, (reply: InReport) => InReport][] = [
	[
		"LinkTimeout",
		() => {
			throw new LinkTimeout("no input report within 1000 ms");
		},
	],
	["ModeDisagrees", (reply) => asInReport(Uint8Array.from(reply, (byte, at) => (at === 4 ? 0 : byte)))],
];
for (const [name, replace] of probeFailures) {
	test(`a ${name} during the Connect probes closes the link, and the next Connect connects`, async () => {
		const r = rig({ wrap: onThirdReadMode(replace) });
		const error = await rejection(u1Run("connect", IDLE, r.ctx()));
		expect(error).toMatchObject({ name });
		const phase = phaseAfterRun(r.entries, outcomeOfError(error));
		expect({ phase: phase.kind, openHandles: r.hid.openHandles }).toEqual({ phase: "failed", openHandles: 0 });
		const again = await u1Run("connect", phase, r.ctx());
		expect({ again: again.kind, openHandles: r.hid.openHandles }).toEqual({ again: "connected", openHandles: 1 });
		if (again.kind === "connected") await again.app.close();
	});
}

/** A rig whose Cancel lands on the first entry that `when` matches, and the frames that left after it. */
function cancelling(when: (entry: TranscriptEntry, board: FakeTab60) => boolean) {
	const controller = new AbortController();
	let sentBefore = 0;
	const r = rig({
		onEntry: once(when, () => {
			sentBefore = r.pairs().length;
			controller.abort(cancel());
		}),
	});
	return { ...r, signal: controller.signal, framesAfterCancel: () => r.pairs().slice(sentBefore) };
}

const updateModeAnswer = (prefix: string) => (entry: TranscriptEntry, board: FakeTab60) => board.mode === "iap" && entry.kind === "in" && entry.hex.startsWith(prefix);

for (const [where, prefix] of [
	["the update-mode attach's READ MODE answer", "1202"],
	["the first update-mode version page part", "1220"],
] as const) {
	test(`a Cancel at ${where} is followed by RESET to app and nothing else`, async () => {
		const r = cancelling(updateModeAnswer(prefix));
		const app = await r.connected();
		const error = await rejection(u1DeepCheck(app, r.ctx(r.signal)));
		expect(error).toMatchObject({ name: "AbortError" });
		expect(r.framesAfterCancel()).toEqual(["1101"]);
		expect(r.hid.openHandles).toBe(0);
		expect(phaseAfterRun(r.entries, outcomeOfError(error))).toEqual(AWAY);
	});
}

test("a Cancel after READ BL INFO in Connect is followed by no frame", async () => {
	const r = cancelling((entry) => entry.kind === "in" && entry.hex.startsWith("1200"));
	const error = await rejection(u1Connect(r.ctx(r.signal)));
	expect(error).toMatchObject({ name: "AbortError" });
	expect(r.framesAfterCancel()).toEqual([]);
	expect(r.hid.openHandles).toBe(0);
});

test("a Cancel during the update-mode probes sends RESET to app and closes the link, and the page shows away", async () => {
	const controller = new AbortController();
	let answers = 0;
	const r = rig({
		onEntry: (entry, board) => {
			if (board.mode === "iap" && entry.kind === "in" && entry.hex.startsWith("1202") && ++answers === 3) controller.abort(cancel());
		},
	});
	const app = await r.connected();
	const error = await rejection(u1DeepCheck(app, { ...r.ctx(controller.signal), series: { probes: 10, everyMs: 1 } }));
	expect(error).toMatchObject({ name: "AbortError" });
	expect(r.pairs()).toEqual([...CONNECT, "1100", ...UPDATE_ATTACH, ...UPDATE_OBSERVE, ...probes(2), "1101"]);
	expect(r.hid.openHandles).toBe(0);
	expect(awayFromHome(r.entries)).toBe(true);
	expect(phaseAfterRun(r.entries, outcomeOfError(error))).toEqual(AWAY);
	await sleep(10);
	expect(r.board.mode).toBe("app");
	expect(r.board.violations).toEqual([]);
});

test("a Cancel as the update-mode probes start sends no probe, then RESET to app", async () => {
	const controller = new AbortController();
	const r = rig({ onLog: (line) => line.startsWith("boot target") && controller.abort(cancel()) });
	const app = await r.connected();
	const error = await rejection(u1DeepCheck(app, r.ctx(controller.signal)));
	expect(error).toMatchObject({ name: "AbortError" });
	expect(r.pairs()).toEqual([...CONNECT, "1100", ...UPDATE_ATTACH, ...UPDATE_OBSERVE, "1101"]);
	expect(r.hid.openHandles).toBe(0);
	expect(phaseAfterRun(r.entries, outcomeOfError(error))).toEqual(AWAY);
});

test("FF AA to SUM sends RESET to app and closes the link, and the page shows away", async () => {
	const r = rig({ board: { refuseOnce: { cmd: 0x1d, sub: 0x01 } } });
	const app = await r.connected();
	const error = await rejection(u1DeepCheck(app, r.ctx()));
	expect(error).toBeInstanceOf(DeviceRefused);
	expect(r.pairs()).toEqual([...CONNECT, "1100", ...UPDATE_ATTACH, ...UPDATE_OBSERVE, "1101"]);
	expect(r.hid.openHandles).toBe(0);
	expect(phaseAfterRun(r.entries, outcomeOfError(error))).toEqual(AWAY);
	await sleep(10);
	expect(r.board.mode).toBe("app");
});

test("a frame the allowlist refuses on the first update-mode probe ends the Deep check away, fails the frames gate, and sends only RESET to app after it", async () => {
	const forged = `1202${"0".repeat(122)}ff`;
	let readModes = 0;
	let sentBefore = -1;
	const forgeFirstUpdateProbe = (link: Link): Link => ({
		mode: link.mode,
		lost: link.lost,
		send(frame) {
			if (link.mode === "iap" && frame[0] === 0x12 && frame[1] === 0x02 && ++readModes === 2) {
				sentBefore = r.pairs().length;
				frame[63] = 0xff;
			}
			return link.send(frame);
		},
		next: (timeoutMs) => link.next(timeoutMs),
		discardPending: () => link.discardPending(),
		close: () => link.close(),
	});
	const r = rig({ wrap: forgeFirstUpdateProbe });
	const app = await r.connected();
	const error = await rejection(u1DeepCheck(app, r.ctx()));
	expect(error).toMatchObject({ name: "FrameNotAllowed", hex: forged });
	expect(error).toBeInstanceOf(FrameNotAllowed);
	expect(r.pairs().slice(sentBefore)).toEqual(["1202", "1101"]);
	expect(r.entries.filter((entry) => "hex" in entry && entry.hex === forged).map((entry) => entry.kind)).toEqual(["out", "send-failed"]);
	expect(r.board.violations).toEqual([]);
	const own = { ...U1_EXPECTED, versionPageSha256: await sha256(syntheticVersionBlock()), probeSpacingMs: 0 };
	const transcript: Transcript = { format: "tab60kit-transcript/1", recordedAt: "2026-10-10T00:00:00.000Z", environment: { fake: "plain" }, entries: r.entries };
	expect((await evaluateU1(transcript, { expected: own, typing: "types" })).frames).toMatchObject({ pass: false, detail: expect.stringContaining(forged) });
	expect(r.log.some((line) => line.includes(forged))).toBe(true);
	expect(r.hid.openHandles).toBe(0);
	expect(phaseAfterRun(r.entries, outcomeOfError(error))).toEqual(AWAY);
});

test("silence after the update-mode observation times out, sends RESET to app, and Try again then finishes the round trip", async () => {
	const deafAfterSum = once(
		(entry: TranscriptEntry, _board: FakeTab60) => entry.kind === "in" && entry.hex.startsWith("1d01"),
		(_entry, board) => {
			board.ignoreInIap = true;
		},
	);
	const r = rig({ onEntry: deafAfterSum });
	const app = await r.connected();
	const error = await rejection(u1DeepCheck(app, r.ctx()));
	expect(error).toBeInstanceOf(LinkTimeout);
	const failed = [...CONNECT, "1100", ...UPDATE_ATTACH, ...UPDATE_OBSERVE, "1202", "1101"];
	expect(r.pairs()).toEqual(failed);
	expect(r.hid.openHandles).toBe(0);
	expect(r.board.mode).toBe("iap");
	expect(phaseAfterRun(r.entries, outcomeOfError(error))).toEqual(AWAY);
	r.board.ignoreInIap = false;
	const end = await u1TryAgain(r.ctx());
	if (end.kind !== "done" || end.back === null || "refusal" in end.back) throw new Error("Try again did not come home");
	expect(r.pairs()).toEqual([...failed, ...UPDATE_ATTACH, ...UPDATE_OBSERVE, ...probes(PROBES), "1101", ...CONFIRM]);
	expect(phaseAfterRun(r.entries, { kind: "connected", app: end.back })).toMatchObject({ kind: "connected" });
	await end.back.close();
	expect(r.hid.openHandles).toBe(0);
}, 10_000);

test("a RESET to IAP whose send rejects after the board took it still reaches update mode and comes home", async () => {
	const lossOnReset = (recorded: Link): Link => ({
		mode: recorded.mode,
		lost: recorded.lost,
		async send(frame) {
			await recorded.send(frame);
			if (frame[0] === 0x11 && frame[1] === 0x00) throw new LinkLost("sendReport failed: NetworkError: Failed to write the report.");
		},
		next: (timeoutMs) => recorded.next(timeoutMs),
		discardPending: () => recorded.discardPending(),
		close: () => recorded.close(),
	});
	const r = rig({ board: { reenumerateAfterMs: 50 }, wrap: lossOnReset });
	const app = await r.connected();
	const end = await u1DeepCheck(app, r.ctx());
	if (end.kind !== "done" || end.back === null || "refusal" in end.back) throw new Error("the round trip did not come home");
	expect(r.pairs()).toEqual(ROUND_TRIP);
	expect(r.entries.flatMap((entry) => (entry.kind === "opened" ? [entry.productId] : []))).toEqual([0x0304, 0x1304, 0x0304]);
	await end.back.close();
	expect(r.hid.openHandles).toBe(0);
	expect(r.board.violations).toEqual([]);
});

test("a Cancel while the Deep check chooser is open sends no frame after the cancel", async () => {
	const controller = new AbortController();
	const r = rig({ board: { reenumerateAfterMs: 150 } });
	const app = await r.connected();
	const deep = rejection(u1DeepCheck(app, r.ctx(controller.signal)));
	await sleep(40);
	const before = r.pairs().length;
	controller.abort(cancel());
	const error = await deep;
	expect(error).toMatchObject({ name: "AbortError" });
	expect(r.pairs().slice(before)).toEqual([]);
	expect(r.pairs()).toEqual([...CONNECT, "1100"]);
	expect(r.hid.openHandles).toBe(0);
	expect(r.board.mode).toBe("iap");
	expect(phaseAfterRun(r.entries, outcomeOfError(error))).toEqual(AWAY);
});

test("an abort as the Deep check starts settles the run at once, sends no RESET to IAP, and leaves no pick parked", async () => {
	const controller = new AbortController();
	const r = rig({ hid: { rowAppearsInOpenChooser: [] } });
	const app = await r.connected();
	const deep = rejection(u1DeepCheck(app, r.ctx(controller.signal)));
	controller.abort(cancel());
	const settled = await Promise.race([deep, sleep(500).then(() => "still pending")]);
	expect(settled).toMatchObject({ name: "AbortError" });
	expect(r.chooser.needsClick).toBeNull();
	expect(r.hid.openHandles).toBe(0);
	expect(r.pairs()).toEqual(CONNECT);
	expect(phaseAfterRun(r.entries, outcomeOfError(settled))).toEqual(IDLE);
});

test("silence at the end of the update-mode observation sends RESET to app, closes the link, and the page offers Try again", async () => {
	const r = rig({ onLog: (line, board) => line.startsWith("boot target") && (board.ignoreInIap = true) });
	const app = await r.connected();
	const error = await rejection(u1DeepCheck(app, r.ctx()));
	expect(error).toBeInstanceOf(LinkTimeout);
	expect(r.pairs()).toEqual([...CONNECT, "1100", ...UPDATE_ATTACH, ...UPDATE_OBSERVE, "1202", "1101"]);
	expect(r.hid.openHandles).toBe(0);
	expect(r.log.some((line) => line.endsWith("sending RESET to app"))).toBe(true);
	expect(phaseAfterRun(r.entries, outcomeOfError(error))).toEqual(AWAY);
}, 10_000);

test("a chooser cancelled twice after the reset leaves the page away, not idle", async () => {
	const r = rig();
	const app = await r.connected();
	r.hid.chooser = "cancel";
	const deep = rejection(u1DeepCheck(app, r.ctx()));
	for (let i = 0; i < 200 && r.chooser.needsClick === null; i++) await sleep(2);
	expect(r.chooser.needsClick).toEqual({ modes: ["iap"], reason: "enter-update-mode" });
	r.chooser.pick();
	const error = await deep;
	expect(error).toBeInstanceOf(PickCancelled);
	expect(r.pairs()).toEqual([...CONNECT, "1100"]);
	expect(r.hid.openHandles).toBe(0);
	expect(outcomeOfError(error)).toEqual({ kind: "cancelled" });
	expect(phaseAfterRun(r.entries, outcomeOfError(error))).toEqual(AWAY);
});

test("a sendReport that rejects after the board took RESET to IAP still reaches update mode and comes home", async () => {
	const r = rig();
	const app = await r.connected();
	const device = r.hid.device;
	const sendReport = device.sendReport.bind(device);
	device.sendReport = async (id, data) => {
		await sendReport(id, data);
		if (new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer)[0] === 0x11) throw new DOMException("Failed to write the output report.", "NotAllowedError");
	};
	const end = await u1DeepCheck(app, r.ctx());
	if (end.kind !== "done" || end.back === null || "refusal" in end.back) throw new Error("the round trip did not come home");
	expect(r.pairs()).toEqual(ROUND_TRIP);
	expect(r.entries.some((entry) => entry.kind === "send-failed" && entry.hex.startsWith("1100"))).toBe(true);
	await end.back.close();
	expect(r.hid.openHandles).toBe(0);
});

test("FF AA to the first update-mode frame keeps the link, and the job sends exactly RESET to app on it", async () => {
	const ffaa = () => report("ffaa0000" + "1202");
	const iap = new ScriptedLink("iap", [ffaa()]);
	const attach = await rejection(connect({ port: new ScriptedPort([iap]), clearance: u1Clearance(), signal: new AbortController().signal }, { modes: ["iap"], reason: "enter-update-mode" }));
	if (!(attach instanceof IapAttachFailed)) throw new Error("not IapAttachFailed");
	expect(attach.cause).toBeInstanceOf(DeviceRefused);
	expect(iap.closed).toBe(0);
	await attach.restartToApp();
	expect(iap.sent.map(toHex)).toEqual(["1202".padEnd(128, "0"), "1101".padEnd(128, "0")]);
	expect(iap.closed).toBe(1);

	const viaJob = new ScriptedLink("iap", [ffaa()]);
	const ctx: U1Context = { port: new ScriptedPort([viaJob]), clearance: u1Clearance(), signal: new AbortController().signal, log: () => undefined, series: { probes: PROBES, everyMs: 1 } };
	expect(await rejection(u1TryAgain(ctx))).toBeInstanceOf(DeviceRefused);
	expect(viaJob.sent.map((frame) => toHex(frame.subarray(0, 2)))).toEqual(["1202", "1101"]);
	expect(viaJob.closed).toBeGreaterThan(0);
});

test("Try again after a mid-phase timeout opens the device again and finishes the round trip", async () => {
	const deafAtBootTarget = once(
		(line: string, _board: FakeTab60) => line.startsWith("boot target"),
		(_line, board) => {
			board.ignoreInIap = true;
		},
	);
	const r = rig({ onLog: deafAtBootTarget });
	const app = await r.connected();
	expect(await rejection(u1DeepCheck(app, r.ctx()))).toBeInstanceOf(LinkTimeout);
	r.board.ignoreInIap = false;
	const end = await u1TryAgain(r.ctx());
	if (end.kind !== "done" || end.back === null || "refusal" in end.back) throw new Error("Try again did not come home");
	expect(r.entries.flatMap((entry) => (entry.kind === "open-attempt" && entry.error !== null ? [entry.error] : []))).toEqual([]);
	expect(r.entries.flatMap((entry) => (entry.kind === "opened" ? [entry.productId] : []))).toEqual([0x0304, 0x1304, 0x1304, 0x0304]);
	await end.back.close();
	expect(r.hid.openHandles).toBe(0);
}, 10_000);

test("check 9 judges each link's probes apart, so Connect, a pause, Connect again, and Deep check still pass it", async () => {
	const r = rig();
	const first = await u1Run("connect", IDLE, r.ctx());
	await sleep(1_100);
	const second = await u1Run("connect", phaseAfterRun(r.entries, first), r.ctx());
	const end = await u1Run("deep-check", phaseAfterRun(r.entries, second), r.ctx());
	if (end.kind === "connected") await end.app.close();
	const expected = { ...U1_EXPECTED, probes: PROBES, versionPageSha256: await sha256(syntheticVersionBlock()), probeSpacingMs: 0 };
	const transcript: Transcript = { format: "tab60kit-transcript/1", recordedAt: "2026-10-10T00:00:00.000Z", environment: { fake: "plain" }, entries: r.entries };
	expect((await evaluateU1(transcript, { expected, typing: "types" })).checks[8]).toMatchObject({ id: 9, pass: true });
});

test("the audit refuses junk in bytes 2..63 of the U1 frames", () => {
	const ctx = (mode: "app" | "iap"): EgressContext => ({ mode, window: null, cursor: null, cleared: (name) => clears(u1Clearance(), name) });
	const frame = (hex: string) => fromHex(hex.padEnd(128, "0").slice(0, 128));
	const refusal = (hex: string, name: Parameters<typeof auditEgress>[1], mode: "app" | "iap") => {
		const verdict = auditEgress(frame(hex), name, ctx(mode));
		return verdict.ok ? "ok" : verdict.refusal.code;
	};
	const junk = (head: string) => `${head}dead${"ab".repeat(60)}`;
	expect([refusal(junk("1100"), "resetToIap", "app"), refusal(junk("1202"), "readMode", "app"), refusal(junk("1220"), "readVersionPage", "iap")]).toEqual(["crc16-field", "crc16-field", "crc16-field"]);
	const past = (head: string) => `${head}0000${"ab".repeat(60)}`;
	expect([refusal(past("1100"), "resetToIap", "app"), refusal(past("1202"), "readMode", "app"), refusal(past("1220"), "readVersionPage", "iap")]).toEqual(["payload-overrun", "payload-overrun", "payload-overrun"]);
	expect([refusal("1100", "resetToIap", "app"), refusal("1202", "readMode", "app"), refusal("1220", "readVersionPage", "iap")]).toEqual(["ok", "ok", "ok"]);
});

test("the CLI refuses a fake transcript with exit 2 and writes no fixture, even when every check would pass", async () => {
	const { transcript } = await recordFakeRun();
	const fake: Transcript = { ...transcript, environment: { ...transcript.environment, fake: "plain", tool: "abc1234-dirty" } };
	const own = { ...U1_EXPECTED, versionPageSha256: await sha256(syntheticVersionBlock()), probeSpacingMs: 0 };
	const typedFake: Transcript = { ...fake, entries: [...fake.entries, { t: (fake.entries.at(-1)?.t ?? 0) + 1, kind: "typing", chars: 4 }] };
	expect((await evaluateU1(typedFake, { expected: own, typing: "types" })).checks.every((check) => check.pass)).toBe(true);
	const dir = mkdtempSync(join(tmpdir(), "u1-recovery-"));
	try {
		const file = join(dir, "t.json");
		writeFileSync(file, JSON.stringify(typedFake));
		const out = join(dir, "u1-macos.json");
		expect(await verdictMain([file, "--types", "--out", out])).toBe(2);
		expect(existsSync(out)).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("check 8 fails when RESET to app never brought the board back and a later Connect found 0x0304", async () => {
	const { transcript } = await recordFakeRun();
	const at = transcript.entries.findIndex((entry) => entry.kind === "out" && entry.hex.startsWith("1101"));
	const t = transcript.entries[at]?.t ?? 0;
	const entries: TranscriptEntry[] = [
		...transcript.entries.slice(0, at + 1),
		{ t: t + 1, kind: "pick", reason: "confirm-normal-mode", path: "parked", productId: null, waitMs: 5000 },
		{ t: t + 60_000, kind: "pick", reason: "connect", path: "activation", productId: 0x0304, waitMs: 2000 },
		{ t: t + 60_001, kind: "opened", reason: "connect", productId: 0x0304, productName: "USB-HID Keyboard", collections: [{ usagePage: 0xff00, usage: 1, inputReportBytes: 64, outputReportBytes: 64, featureReportBytes: 0 }] },
		{ t: t + 60_002, kind: "typing", chars: 5 },
	];
	const own = { ...U1_EXPECTED, versionPageSha256: await sha256(syntheticVersionBlock()), probeSpacingMs: 0 };
	const check8 = (await evaluateU1({ ...transcript, entries }, { expected: own, typing: "types" })).checks[7];
	expect(check8?.pass).toBe(false);
	expect(check8?.detail).toMatch(/no 0x0304 opened for the confirm after the last RESET to app that left/);
});

/** The board ignores the first RESET to app. The second reaches it, and its send rejects after the board took it. */
function ignoresFirstResetThenRejects() {
	let resets = 0;
	return (link: Link): Link => ({
		mode: link.mode,
		lost: link.lost,
		async send(frame) {
			const reset = frame[0] === 0x11 && frame[1] === 0x01;
			if (reset && ++resets === 1) return;
			await link.send(frame);
			if (reset) throw new LinkLost("sendReport failed: the board reset before the write settled");
		},
		next: (timeoutMs) => link.next(timeoutMs),
		discardPending: () => link.discardPending(),
		close: () => link.close(),
	});
}

test("check 8 fails when the last RESET to app that left brought nothing back, though the board came back after a later one whose send failed", async () => {
	const r = rig({ hid: { emptyChooserClosesAfterMs: 30 }, inner: ignoresFirstResetThenRejects() });
	const user = setInterval(() => r.chooser.needsClick !== null && r.chooser.pick(), 2);
	try {
		const connect = await settle(u1Run("connect", IDLE, r.ctx()));
		const deep = phaseAfterRun(r.entries, await settle(u1Run("deep-check", phaseAfterRun(r.entries, connect), r.ctx())));
		const tryAgain = await settle(u1Run("try-again", deep, r.ctx()));
		expect([connect.kind, deep.kind, tryAgain.kind, r.board.mode]).toEqual(["connected", "away", "connected", "app"]);
		if (tryAgain.kind === "connected") await tryAgain.app.close();
	} finally {
		clearInterval(user);
	}
	expect(
		r.entries.flatMap((entry) =>
			entry.kind === "opened" ? [`opened ${entry.productId.toString(16)} ${entry.reason}`] : (entry.kind === "out" || entry.kind === "send-failed") && entry.hex.startsWith("1101") ? [`${entry.kind} 1101`] : [],
		),
	).toEqual(["opened 304 connect", "opened 1304 enter-update-mode", "out 1101", "opened 1304 enter-update-mode", "out 1101", "send-failed 1101", "opened 304 confirm-normal-mode"]);
	r.entries.push({ t: performance.now(), kind: "typing", chars: 5 });
	const expected = { ...U1_EXPECTED, probes: PROBES, versionPageSha256: await sha256(syntheticVersionBlock()), probeSpacingMs: 0 };
	const transcript: Transcript = { format: "tab60kit-transcript/1", recordedAt: "2026-10-10T00:00:00.000Z", environment: { fake: "plain" }, entries: r.entries };
	const verdict = await evaluateU1(transcript, { expected, typing: "types" });
	expect(verdict.checks[7]).toMatchObject({ id: 8, pass: false, detail: "no 0x0304 opened for the confirm after the last RESET to app that left and before the next one" });
	expect(verdict.findings).toContain("1 times 0x0304 opened after a RESET to app whose send failed, so that return does not show the reset worked");
});

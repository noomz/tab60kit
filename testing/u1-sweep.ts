/**
 * The U1 sweep: fake page sessions with the link lost at every packet, a Cancel after every transcript entry, and a
 * Cancel at every point inside Restart and Try again, each judged by one strict predicate (`problems`).
 * `bun run sweep` runs the full set and exits 1 on any problem. testing/u1-sweep.test.ts runs a reduced set.
 */
import type { Mode } from "../core/port";
import { FrameNotAllowed, U1_FRAMES, u1Wrap } from "../lab/u1-frames";
import { type U1Context, u1Clearance, u1Run } from "../lab/u1-job";
import { type Phase, type Run, type RunOutcome, awayFromHome, outcomeOfError, phaseAfterRun, updateModeLinkOpen } from "../lab/u1-state";
import { startWebHidLab } from "../web/webhid-port";
import { TARGET } from "./fake-run";
import { FakeTab60 } from "./fake-tab60";
import { FakeHid, FakeLocks } from "./fake-webhid";
import type { TranscriptEntry } from "./transcript";

const PROBES = 3;
/** The fake user closes a chooser that shows no row after this long, so a run that waits for a missing row parks at once. */
const EMPTY_CHOOSER_MS = 30;
/** A healthy fake run ends in well under 100 ms, so one still going after this long waits for something that will not come. */
const HANG_MS = 1_500;
const STUCK_MS = 1_000;
/** Lets the fake board finish re-enumerating after a run that ended right after a reset. */
const SETTLE_MS = 10;

export type Recovery = "restart" | "try-again";

/** One fake page session. It clicks Connect, then Deep check, then a recovery where the scenario names one. */
export interface Scenario {
	/** Lose the link right before the board receives this output report, counted from page load. */
	readonly lossAt?: number;
	/** On that loss, also reset the MCU. */
	readonly resetOnLoss?: boolean;
	/** Strand the board first, with every Deep check chooser closing empty, then click this. */
	readonly recovery?: Recovery;
	/** Cancel after this many transcript entries, counted from page load, or from the recovery's click when there is one. */
	readonly cancelAfter?: number;
}

export interface CancelRecord {
	/** The scenario's injected Cancel, or the harness's Cancel of a run that had not ended after HANG_MS. */
	readonly by: "scenario" | "harness";
	/** Whether an update-mode link was open, or the board may have been away, when the Cancel landed. */
	readonly landed: string;
	readonly owesResetToApp: boolean;
	/** The frames recorded after the Cancel, until the run ended. */
	readonly framesAfter: readonly string[];
}

export interface RunRecord {
	readonly what: Run;
	readonly phase: Phase["kind"];
	readonly board: Mode;
	/** Open handles beyond the one link the phase holds. */
	readonly leaked: number;
	readonly cancel: CancelRecord | null;
	/** Still going STUCK_MS after its Cancel. */
	readonly stuck: boolean;
	/** The final Restart the sweep clicks for a board left in update mode, which must bring it home. */
	readonly bringsHome: boolean;
}

export interface ScenarioResult {
	readonly scenario: Scenario;
	readonly runs: readonly RunRecord[];
	readonly entries: number;
	/** Entries recorded before the recovery click, so a sweep can count the recovery's own entries. */
	readonly recoveryStart: number;
	readonly frames: readonly string[];
	readonly refusedByAllowlist: number;
	readonly violations: number;
}

const sleep = (ms: number) => new Promise<"timer">((resolve) => setTimeout(() => resolve("timer"), ms));
const cancel = () => new DOMException("cancelled from the page", "AbortError");

function holds(phase: Phase): number {
	if (phase.kind === "connected" || phase.kind === "refused") return 1;
	return phase.kind === "away" && phase.holding !== null ? 1 : 0;
}

export function owesResetToApp(entries: readonly TranscriptEntry[]): boolean {
	if (!updateModeLinkOpen(entries)) return false;
	let owed = false;
	for (const entry of entries) {
		if (entry.kind === "opened") owed = true;
		if (entry.kind === "out" && entry.hex.startsWith("1101")) owed = false;
	}
	return owed;
}

function where(entries: readonly TranscriptEntry[]): string {
	if (owesResetToApp(entries)) return "with an update-mode link open before its RESET to app";
	if (updateModeLinkOpen(entries)) return "with an update-mode link open after its RESET to app";
	return awayFromHome(entries) ? "with the board possibly away and no update-mode link" : "with the board home";
}

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
	const board = new FakeTab60({
		starting: "official-image",
		target: TARGET,
		...(scenario.lossAt === undefined ? {} : { loseLinkAtPacket: scenario.lossAt, resetOnLoss: scenario.resetOnLoss ?? false }),
	});
	const hid = new FakeHid(board, { rowAppearsInOpenChooser: ["app", "iap"], isActive: () => true, emptyChooserClosesAfterMs: EMPTY_CHOOSER_MS });
	const entries: TranscriptEntry[] = [];
	let running: AbortController | null = null;
	let cancelAt: number | null = scenario.recovery === undefined ? (scenario.cancelAfter ?? null) : null;
	let cancelled: { readonly by: CancelRecord["by"]; readonly at: number } | null = null;
	const sink = (entry: TranscriptEntry) => {
		entries.push(entry);
		if (entries.length !== cancelAt || running === null || running.signal.aborted) return;
		cancelled = { by: "scenario", at: entries.length };
		running.abort(cancel());
	};
	const { port, chooser } = startWebHidLab(hid, new FakeLocks(), { wrap: u1Wrap(sink), onEvent: (event) => sink({ t: performance.now(), ...event }) });
	const user = setInterval(() => {
		if (chooser.needsClick?.modes.includes(hid.device.mode)) chooser.pick();
	}, 2);
	let phase = { kind: "idle" } as Phase;
	let refusedByAllowlist = 0;
	const runs: RunRecord[] = [];

	const click = async (what: Run, bringsHome = false): Promise<RunRecord> => {
		const own = new AbortController();
		running = own;
		cancelled = null;
		const ctx: U1Context = { port, clearance: u1Clearance(), signal: own.signal, log: () => undefined, series: { probes: PROBES, everyMs: 1 } };
		const settled = port.exclusive(() => u1Run(what, phase, ctx)).catch((error: unknown): RunOutcome => {
			if (error instanceof FrameNotAllowed) refusedByAllowlist++;
			return outcomeOfError(error);
		});
		let outcome = await Promise.race([settled, sleep(HANG_MS)]);
		if (outcome === "timer") {
			cancelled ??= { by: "harness", at: entries.length };
			own.abort(cancel());
			outcome = await Promise.race([settled, sleep(STUCK_MS)]);
		}
		const endedAt = entries.length;
		own.abort(new DOMException("the run ended", "AbortError"));
		running = null;
		if (outcome !== "timer") phase = phaseAfterRun(entries, outcome);
		await sleep(SETTLE_MS);
		const record: RunRecord = {
			what,
			phase: phase.kind,
			board: board.mode,
			leaked: hid.openHandles - holds(phase),
			cancel:
				cancelled === null
					? null
					: {
							by: cancelled.by,
							landed: `in ${what} ${where(entries.slice(0, cancelled.at))}`,
							owesResetToApp: owesResetToApp(entries.slice(0, cancelled.at)),
							framesAfter: entries.slice(cancelled.at, endedAt).flatMap((entry) => (entry.kind === "out" ? [entry.hex.slice(0, 4)] : [])),
						},
			stuck: outcome === "timer",
			bringsHome,
		};
		runs.push(record);
		return record;
	};

	let recoveryStart = 0;
	try {
		if ((await click("connect")).phase === "connected") {
			if (scenario.recovery !== undefined) hid.chooser = "cancel";
			const deep = await click("deep-check");
			hid.chooser = "pick";
			if (scenario.recovery !== undefined && deep.phase === "away") {
				recoveryStart = entries.length;
				if (scenario.cancelAfter !== undefined) cancelAt = recoveryStart + scenario.cancelAfter;
				await click(scenario.recovery);
			}
		}
		if (runs.at(-1)?.stuck !== true && board.mode === "iap") await click("restart", true);
	} finally {
		clearInterval(user);
		if (phase.kind === "connected") await phase.app.close();
		if (phase.kind === "refused") await phase.refused.close();
		if (phase.kind === "away" && phase.holding !== null) await phase.holding.close();
	}
	return {
		scenario,
		runs,
		entries: entries.length,
		recoveryStart,
		frames: entries.flatMap((entry) => (entry.kind === "out" ? [entry.hex] : [])),
		refusedByAllowlist,
		violations: board.violations.length,
	};
}

/** The sweep's predicate. Each line is one reason the scenario failed, and an empty list means it passed. */
export function problems(result: ScenarioResult): string[] {
	const found: string[] = [];
	const off = result.frames.filter((hex) => !U1_FRAMES.includes(hex));
	if (off.length > 0) found.push(`${off.length} frames off the golden list: ${[...new Set(off)].join(", ")}`);
	if (result.refusedByAllowlist > 0) found.push(`the core tried ${result.refusedByAllowlist} frames the allowlist refused`);
	const resetsToIap = result.frames.filter((hex) => hex.startsWith("1100")).length;
	if (resetsToIap > 1) found.push(`${resetsToIap} RESET to IAP frames`);
	if (result.violations > 0) found.push(`${result.violations} board violations`);
	for (const run of result.runs) {
		if (run.stuck) found.push(`${run.what} did not end after a Cancel`);
		if (run.board === "iap" && run.phase !== "away") found.push(`${run.what} left the board in update mode with the page ${run.phase}`);
		if (run.leaked !== 0) found.push(`${run.what} leaked ${run.leaked} open handles`);
		if (run.bringsHome && run.board === "iap") found.push("Restart left the board in update mode");
		if (run.cancel !== null) {
			const sent = run.cancel.framesAfter.join(" ") || "nothing";
			const owed = run.cancel.owesResetToApp ? "1101" : "nothing";
			if (sent !== owed) found.push(`${run.what} sent ${sent} after a Cancel that owed ${owed}`);
		}
	}
	return found;
}

function describeScenario(scenario: Scenario): string {
	const parts = [
		scenario.lossAt === undefined ? null : `link lost at packet ${scenario.lossAt}${scenario.resetOnLoss ? " with an MCU reset" : ""}`,
		scenario.recovery === undefined ? null : `${scenario.recovery} after a stranded Deep check`,
		scenario.cancelAfter === undefined ? null : `Cancel after entry ${scenario.cancelAfter}`,
	];
	return parts.filter((part) => part !== null).join(", ") || "clean";
}

export interface SweepOptions {
	/** Packets to lose the link at, each with and without an MCU reset. Default: every packet of a clean run. */
	readonly lossAt?: readonly number[];
	/** Entries to Cancel after, counted from page load. Default: every entry of a clean run. */
	readonly cancelAfter?: readonly number[];
	/** Entries to Cancel after, counted from each recovery's click. Default: every entry of a clean recovery. */
	readonly cancelInRecovery?: Readonly<Record<Recovery, readonly number[]>>;
}

export interface SweepReport {
	readonly scenarios: number;
	readonly problems: readonly string[];
	/** How many runs saw each Cancel sender, landing place, and list of frames after it. */
	readonly afterCancel: ReadonlyMap<string, number>;
}

export async function sweep(options: SweepOptions = {}): Promise<SweepReport> {
	const results: ScenarioResult[] = [];
	const run = async (scenario: Scenario) => {
		const result = await runScenario(scenario);
		results.push(result);
		return result;
	};
	const every = (count: number) => Array.from({ length: count }, (_, i) => i + 1);
	const clean = await run({});
	for (const lossAt of options.lossAt ?? every(clean.frames.length).map((n) => n - 1)) {
		for (const resetOnLoss of [false, true]) await run({ lossAt, resetOnLoss });
	}
	for (const cancelAfter of options.cancelAfter ?? every(clean.entries)) await run({ cancelAfter });
	for (const recovery of ["restart", "try-again"] as const) {
		const stranded = await run({ recovery });
		for (const cancelAfter of options.cancelInRecovery?.[recovery] ?? every(stranded.entries - stranded.recoveryStart)) await run({ recovery, cancelAfter });
	}
	const afterCancel = new Map<string, number>();
	for (const { cancel } of results.flatMap((result) => result.runs)) {
		if (cancel === null) continue;
		const key = `${cancel.by === "scenario" ? "a Cancel" : "the harness's Cancel of a hung run"} ${cancel.landed}: ${cancel.framesAfter.length === 0 ? "nothing" : cancel.framesAfter.join(" ")}`;
		afterCancel.set(key, (afterCancel.get(key) ?? 0) + 1);
	}
	return {
		scenarios: results.length,
		problems: results.flatMap((result) => problems(result).map((problem) => `${describeScenario(result.scenario)}: ${problem}`)),
		afterCancel,
	};
}

if (import.meta.main) {
	const started = performance.now();
	const report = await sweep();
	for (const [landed, count] of report.afterCancel) console.log(`after ${landed} (${count} runs)`);
	for (const problem of report.problems) console.log(`PROBLEM ${problem}`);
	console.log(`${report.scenarios} scenarios, ${report.problems.length} problems, ${((performance.now() - started) / 1000).toFixed(1)} s`);
	process.exit(report.problems.length === 0 ? 0 : 1);
}

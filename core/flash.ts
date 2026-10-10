/**
 * Flashing as convergence on the board's own state.
 *
 * The loop keeps no cursor. Each turn it observes the board, asks a pure policy for the next step, performs it,
 * and observes again. A lost link, a timeout, an MCU reset, a cancelled chooser, or a reloaded tab all lead to
 * the same place: the next observation. Running the job again from any state reaches the same end state,
 * because each step's precondition is read from the board, not remembered.
 *
 * Safety order (R1 Sequences, the vendor updater):
 *   erase the version page -> erase the app region -> write the image -> SUM (+CRC) must match -> only then write
 *   the version block.
 * The version block is what makes the IAP boot the image. It is erased first by its own command, written only after
 * an observation in update mode has proven the image, and its magic lands in its last chunk.
 *
 * Three pure functions make every flash decision. decideInApp and decideInIap pick the next step from an
 * observation, and judgeLink says whether the link has been quiet long enough to start a step that changes flash.
 */
import { type AppChip, type IapChip, type PageState, type ImageCheck, observe } from "./chip";
import type { FlashableImage } from "./firmware";
import type { Job } from "./job";
import { connect } from "./protocol";
import { notImplemented } from "./units";

export type AppStep = "done" | "enter-iap";
export type IapStep = "erase-and-write-image" | "write-version-block" | "exit-to-app";
export type Step = AppStep | IapStep;

/**
 * Per step: the attempt budget, and whether the step changes flash (the link gate runs before the first such step on
 * each link). A Record over every step, so a new step fails to compile until both are decided.
 *
 * The vendor updater gives up after three write attempts, and the same budget covers every step. Attempts count
 * steps the board answered and the policy chose again. A lost link resets every count, because a drop says nothing
 * about the step and MAX_LINK_LOSSES bounds drops on its own. Counting drops as attempts made three drops inside one
 * step end a healthy flash in update mode; testing/reconcile-model.ts reproduces that false stop.
 */
export const STEPS: Readonly<Record<Step, { readonly maxAttempts: number; readonly changesFlash: boolean }>> = {
	done: { maxAttempts: 1, changesFlash: false },
	"enter-iap": { maxAttempts: 3, changesFlash: false },
	"erase-and-write-image": { maxAttempts: 3, changesFlash: true },
	"write-version-block": { maxAttempts: 3, changesFlash: true },
	"exit-to-app": { maxAttempts: 3, changesFlash: false },
};

/** Each loss costs a click and a pick in a browser, so the user is the real budget there. This bounds the Node and fake shells. */
export const MAX_LINK_LOSSES = 10;

function isTargetPage(page: PageState, target: FlashableImage): boolean {
	return page.kind === "official" && page.entry.id === target.entry.id;
}

function isTargetImage(image: ImageCheck, target: FlashableImage): boolean {
	return image.kind === "official" && image.entry.id === target.entry.id;
}

/**
 * Normal mode. `verified` turns true once this job has observed, in update mode, the target page over the
 * target image. A board that only reports the right version page still gets checked: "done" means checked.
 */
export function decideInApp(chip: AppChip, target: FlashableImage, verified: boolean): AppStep {
	return verified && isTargetPage(chip.page, target) ? "done" : "enter-iap";
}

/**
 * Update mode. The whole policy:
 *
 *   rewrite | image   | page           | step
 *   --------+---------+----------------+-----------------------
 *   owed    | any     | any            | erase-and-write-image
 *   no      | target  | target         | exit-to-app
 *   no      | target  | erased         | write-version-block
 *   no      | target  | other/partial  | erase-and-write-image
 *   no      | other   | any            | erase-and-write-image
 *
 * A rewrite is owed when the caller asked for one and this job has not finished writing the image yet. Without it,
 * a board that already holds the target converges with no write, so plan unit U7 could not exercise the write path on
 * the user's board, which already runs V1.01.13 (candidate A's reinstall).
 */
export function decideInIap(chip: IapChip, target: FlashableImage, rewrite: boolean): IapStep {
	if (rewrite || !isTargetImage(chip.image, target)) return "erase-and-write-image";
	if (isTargetPage(chip.page, target)) return "exit-to-app";
	if (chip.page.kind === "erased") return "write-version-block";
	return "erase-and-write-image";
}

/** What the link gate saw on the links of one job, stamped with the port's clock. */
export type LinkEvent =
	| { readonly t: number; readonly kind: "probe-ok" }
	| { readonly t: number; readonly kind: "timeout" }
	| { readonly t: number; readonly kind: "lost" };

export interface LinkRule {
	/** How long the link must be quiet: no timeout, no loss, and probes answering throughout. */
	readonly quietMs: number;
	/** The longest silence between answered probes that still counts as one quiet run. */
	readonly maxProbeGapMs: number;
}

/**
 * The gate before the first step that changes flash on each link (candidate A). Recovery from an interrupted flash
 * rests on an INFERRED bootloader rule, and the USB side dropped three times in 24.5 min while Karabiner's LED loop
 * ran (none in 67.6 min with it off, STATE decision log). So the tool waits for evidence of a quiet link instead of
 * trusting the recovery. Hard in v1, with no override; design.md open question 12 asks whether to keep it hard.
 */
export const WRITE_LINK_RULE: LinkRule = { quietMs: 15_000, maxProbeGapMs: 1_000 };

/** How often the gate probes. Two probes per maxProbeGapMs, so one slow answer does not break the run. */
export const PROBE_EVERY_MS = 500;

export type LinkVerdict =
	| { readonly kind: "stable" }
	| { readonly kind: "unstable"; readonly lastFailureAt: number }
	| { readonly kind: "insufficient"; readonly quietMs: number; readonly needMs: number };

/**
 * Pure: events and a clock reading in, verdict out, so tests need no timers.
 * Unstable while a timeout or loss falls inside the last `quietMs`. Stable once answered probes have covered the
 * last `quietMs` with no gap longer than `maxProbeGapMs`, the newest probe included. Insufficient otherwise.
 */
export function judgeLink(events: readonly LinkEvent[], now: number, rule: LinkRule): LinkVerdict {
	let lastFailure = Number.NEGATIVE_INFINITY;
	for (const event of events) {
		if (event.kind !== "probe-ok" && event.t <= now) lastFailure = Math.max(lastFailure, event.t);
	}
	if (lastFailure > now - rule.quietMs) return { kind: "unstable", lastFailureAt: lastFailure };
	const answered = events
		.filter((event) => event.kind === "probe-ok" && event.t > lastFailure && event.t <= now)
		.map((event) => event.t)
		.sort((a, b) => a - b);
	let runStart: number | null = null;
	let newest: number | null = null;
	for (const t of answered) {
		if (newest === null || t - newest > rule.maxProbeGapMs) runStart = t;
		newest = t;
	}
	const quietMs = runStart !== null && newest !== null && now - newest <= rule.maxProbeGapMs ? now - runStart : 0;
	return quietMs >= rule.quietMs ? { kind: "stable" } : { kind: "insufficient", quietMs, needMs: rule.quietMs };
}

export interface FlashOptions {
	/** Erase and write the image even when the board already holds it. Plan unit U7 runs the first write this way. */
	readonly rewrite: boolean;
}

/**
 * The flash job.
 * TODO:
 *   attempts = zero per step; losses = 0; verified = false; rewrite = options.rewrite
 *   events: LinkEvent[] = []; gated: Session | null = null; session = start; board = null
 *   loop:
 *     if signal aborted -> stopped(cancelled, during: last activity)
 *     try:
 *       session ??= connect(ctx, { modes: ["app", "iap"], reason: losses ? "after-link-loss" : "connect" })
 *                   (a LayoutRefusal -> stopped(board-refused))
 *       obs = await observe(session, signal); board = obs.chip; progress(reading, board)
 *       step = obs.mode === "app" ? decideInApp(obs.chip, target, verified) : decideInIap(obs.chip, target, rewrite)
 *       if step === "done" -> finished(official, confirmedInNormalMode: true)
 *       if ++attempts[step] > STEPS[step].maxAttempts -> stopped(attempts-exhausted)
 *       if STEPS[step].changesFlash and gated !== obs.session:
 *         await holdLink(obs.session, events, ctx); gated = obs.session          no flash write before the gate says stable
 *       switch on obs.mode, then on step (exhaustive, so a new step fails to compile until handled):
 *         app / "enter-iap":            progress(restarting iap); session = await obs.session.enterIap(ctx)
 *         iap / "erase-and-write-image": progress(erasing); await eraseWindow()
 *                                       await writeImage(target, (i, n) => progress(writing-image i of n)); rewrite = false
 *         iap / "write-version-block":  progress(writing-version-block); await writeVersionBlock(target)
 *         iap / "exit-to-app":          verified = true; session = await leaveUpdateMode(obs.session, ctx)
 *                                       null (confirm skipped) -> finished(official, confirmedInNormalMode: false)
 *                                       otherwise loop: the next observation in normal mode returns "done"
 *     catch IapAttachFailed: close its link, then handle its cause as below (no observation exists to decide a reset)
 *     catch LinkLost or LinkTimeout: events.push(lost or timeout at clock.now()); session = null
 *                                    attempts = zero per step              a drop is not a failed attempt
 *                                    ++losses > MAX_LINK_LOSSES -> stopped(too-many-link-losses); progress(link-lost); continue
 *     catch DeviceRefused: continue (the attempt is already counted; the next observation decides)
 *     catch NotCleared: stopped(gate, its message)          G1: nothing was sent for this command
 *     catch PickCancelled: stopped(cancelled)               the board stays wherever the last step left it; rerun converges
 *     catch OsPermissionDenied: stopped(os-permission)
 *
 * holdLink(iap, events, ctx), the link gate. Once per link, because every later failure ends the link:
 *   loop:
 *     verdict = judgeLink(events, clock.now(), WRITE_LINK_RULE)
 *     stable -> return
 *     progress(holding-link, verdict's quiet time so far, WRITE_LINK_RULE.quietMs)
 *     await iap.probe(signal); events.push(probe-ok at clock.now()); await clock.sleep(PROBE_EVERY_MS, signal)
 *   a timeout or loss during a probe propagates to the loop above, which records it and reconnects
 */
export function makeOfficial(target: FlashableImage, options: FlashOptions = { rewrite: false }): Job {
	return async (start, ctx) =>
		notImplemented(
			`makeOfficial(${target.entry.id}, rewrite=${options.rewrite}) from ${String(start?.mode)} via ${connect.name} and ${observe.name}, ${ctx.clearance.kind}, aborted=${ctx.signal.aborted}`,
		);
}

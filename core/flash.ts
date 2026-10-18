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
import { type AppChip, type ChipState, type IapChip, type ImageCheck, type PageState, home, leaveUpdateMode, observe } from "./chip";
import { CATALOG, type FlashableImage } from "./firmware";
import { type Activity, type Job, type JobContext, type JobEnd, type StopReason, isLinkFailure, stopReasonFor } from "./job";
import { DeviceRefused, IapAttachFailed, ReadBackMismatch, type Session, connect } from "./protocol";

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
 * The flash job: observe, decide, act, and observe again, until the board is checked official or a budget runs out.
 * Any lost link, timeout, refusal, MCU reset, or cancel leaves the next run to start from a fresh observation.
 *
 * It recognizes CATALOG plus the entry it was asked to write. `admit` already proved that entry, so for a shipped
 * image this is CATALOG, and a test's synthetic image converges like a real one.
 */
export function makeOfficial(target: FlashableImage, options: FlashOptions = { rewrite: false }): Job {
	const catalog = CATALOG.some((entry) => entry.id === target.entry.id) ? CATALOG : [...CATALOG, target.entry];
	return async (start, ctx) => {
		const attempts: Record<Step, number> = { done: 0, "enter-iap": 0, "erase-and-write-image": 0, "write-version-block": 0, "exit-to-app": 0 };
		const events: LinkEvent[] = [];
		let losses = 0;
		let verified = false;
		let rewrite = options.rewrite;
		let gated: Session | null = null;
		let session: Session | null = start;
		let board: ChipState | null = null;
		let during: Activity | null = null;
		const progress = (activity: Activity, chip?: ChipState) => {
			during = activity;
			if (chip === undefined) ctx.progress(activity);
			else {
				board = chip;
				ctx.progress(activity, chip);
			}
		};
		const stopped = (reason: StopReason, end: Session | null = null): JobEnd => ({ kind: "stopped", reason, session: end, board });
		const finished = (confirmedInNormalMode: boolean, end: Session | null): JobEnd => ({
			kind: "finished",
			result: { kind: "official", entry: target.entry, confirmedInNormalMode },
			session: end,
			board,
		});
		for (;;) {
			if (ctx.signal.aborted) {
				await session?.close().catch(() => undefined);
				return stopped({ kind: "cancelled", during });
			}
			try {
				if (session === null) {
					const opened = await connect(ctx, { modes: ["app", "iap"], reason: losses > 0 ? "after-link-loss" : "connect" });
					if ("refusal" in opened) {
						await opened.close();
						return stopped({ kind: "board-refused", refusal: opened.refusal });
					}
					session = opened;
				}
				const obs = await observe(session, ctx.signal, catalog);
				progress({ kind: "reading" }, obs.chip);
				const step: Step = obs.mode === "app" ? decideInApp(obs.chip, target, verified) : decideInIap(obs.chip, target, rewrite);
				if (step === "done") return finished(true, obs.session);
				if (++attempts[step] > STEPS[step].maxAttempts) return stopped({ kind: "attempts-exhausted", step, attempts: attempts[step] - 1 }, obs.session);
				if (STEPS[step].changesFlash && gated !== obs.session) {
					await holdLink(obs.session, events, ctx, progress);
					gated = obs.session;
				}
				if (obs.mode === "app") {
					switch (step) {
						case "enter-iap":
							progress({ kind: "restarting", into: "iap" });
							session = null;
							{
								const iap = await obs.session.enterIap(ctx);
								if ("refusal" in iap) return stopped({ kind: "board-refused", refusal: iap.refusal }, await home(await leaveUpdateMode(iap, ctx)));
								session = iap;
							}
							break;
						default:
							throw new Error(`decideInApp chose ${step}`);
					}
					continue;
				}
				const iap = obs.session;
				switch (step) {
					case "erase-and-write-image":
						progress({ kind: "erasing" });
						await iap.eraseWindow();
						await iap.writeImage(target, (chunk, chunks) => progress({ kind: "writing-image", chunk, chunks }));
						rewrite = false;
						break;
					case "write-version-block":
						progress({ kind: "writing-version-block" });
						await iap.writeVersionBlock(target);
						break;
					case "exit-to-app": {
						verified = true;
						session = null;
						const back = await leaveUpdateMode(iap, ctx);
						if (back === null) return finished(false, null);
						if ("refusal" in back) {
							await back.close();
							return stopped({ kind: "board-refused", refusal: back.refusal });
						}
						session = back;
						break;
					}
					default:
						throw new Error(`decideInIap chose ${step}`);
				}
			} catch (error) {
				let cause = error;
				if (error instanceof IapAttachFailed) {
					await error.close().catch(() => undefined);
					cause = error.cause;
				} else await session?.close().catch(() => undefined);
				session = null;
				if (isLinkFailure(cause)) {
					events.push({ t: ctx.port.clock.now(), kind: cause.name === "LinkTimeout" ? "timeout" : "lost" });
					for (const step of Object.keys(attempts) as Step[]) attempts[step] = 0;
					if (++losses > MAX_LINK_LOSSES) return stopped({ kind: "too-many-link-losses", losses });
					progress({ kind: "link-lost", losses });
					continue;
				}
				// The attempt is already counted; the next observation decides.
				if (cause instanceof DeviceRefused || cause instanceof ReadBackMismatch) continue;
				const reason = stopReasonFor(cause, ctx.signal, during);
				if (reason === null) throw cause;
				return stopped(reason);
			}
		}
	};
}

/**
 * The link gate. Once per link, because every later failure ends the link. Probes until judgeLink says stable; a
 * timeout or loss during a probe propagates to the loop, which records it and reconnects.
 */
async function holdLink(session: Session, events: LinkEvent[], ctx: JobContext, progress: (activity: Activity) => void): Promise<void> {
	const { clock } = ctx.port;
	for (;;) {
		const verdict = judgeLink(events, clock.now(), WRITE_LINK_RULE);
		if (verdict.kind === "stable") return;
		progress({ kind: "holding-link", quietMs: verdict.kind === "insufficient" ? verdict.quietMs : 0, needMs: WRITE_LINK_RULE.quietMs });
		await session.probe(ctx.signal);
		events.push({ t: clock.now(), kind: "probe-ok" });
		await clock.sleep(PROBE_EVERY_MS, ctx.signal);
	}
}

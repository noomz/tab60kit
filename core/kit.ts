/**
 * The kit: one per page or process. It owns the open session between jobs, runs one job at a time, and turns
 * job progress into the JobState the UI renders.
 */
import { deepCheck, quickCheck } from "./chip";
import type { FlashableImage } from "./firmware";
import { type FlashOptions, makeOfficial } from "./flash";
import type { JobState } from "./job";
import { type ConfigCapabilities, type KeymapDoc, applyKeymap, capabilities } from "./keymap";
import type { DevicePort } from "./port";
import { type Clearance, SHIPPED } from "./protocol";
import { notImplemented } from "./units";

export interface Kit {
	readonly state: JobState;
	/** Calls `listener` on every state change. Returns the unsubscribe function. */
	subscribe(listener: (state: JobState) => void): () => void;
	check(depth: "quick" | "deep"): Promise<JobState>;
	/** `{ rewrite: true }` writes the image even when the board already holds it (plan unit U7). */
	makeOfficial(image: FlashableImage, options?: FlashOptions): Promise<JobState>;
	applyKeymap(doc: KeymapDoc): Promise<JobState>;
	/** What G1 lets this kit's keymap editor do, derived from COMMANDS and the kit's clearance. */
	capabilities(): ConfigCapabilities;
	/**
	 * Stops the running job at its next step boundary, or rejects a pending device prompt.
	 * During the optional confirm pick after a flash, this is Skip: the job still finishes as official.
	 */
	cancel(): void;
}

/**
 * `clearance` is what G1 lets this kit send. A shipped page passes nothing and gets SHIPPED, which sends only
 * confirmed rows. A lab page passes a labClearance, which neither package entry exports.
 * TODO:
 *   session: Session | null = null       held only between jobs
 *   state: JobState = { kind: "idle", board: null }; listeners; controller: AbortController | null = null
 *
 *   run(kind: JobKind, job: Job):
 *     if controller !== null -> throw (the UI disables job buttons while a job runs; this is the backstop)
 *     controller = new AbortController()
 *     try:
 *       return await port.exclusive(async () => {
 *         start = session; session = null                       ownership moves to the job
 *         ctx = { port: watched(port), clearance, signal, progress: (activity, board) => set working state }
 *           watched(port).open(want, signal): opening = port.open(want, signal) first, so a WebHID port has already
 *             parked or opened its chooser; then set awaiting-device { job: kind, want }; await opening; set working
 *         end = await job(start, ctx)
 *         session = end.session                                 and comes back
 *         set finished or stopped from end; return state
 *       })
 *     catch Busy -> set stopped { reason: busy }                another tab or process has the board
 *     finally controller = null
 *
 *   check(depth) = run(depth === "quick" ? "quick-check" : "deep-check", depth === "quick" ? quickCheck : deepCheck)
 *   makeOfficial(image, options) = run("make-official", makeOfficial(image, options))
 *   applyKeymap(doc) = run("apply-keymap", applyKeymap(doc))
 *   capabilities() = keymap capabilities(clearance)
 *   cancel() = controller?.abort()
 */
export function createKit(port: DevicePort, clearance: Clearance = SHIPPED): Kit {
	const jobs = [quickCheck, deepCheck, makeOfficial, applyKeymap].map((job) => job.name).join(", ");
	return notImplemented(`createKit(${typeof port.open}, ${clearance.kind}): ${jobs}, ${capabilities.name}`);
}

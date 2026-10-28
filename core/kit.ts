/**
 * The kit: one per page or process. It owns the open session between jobs, runs one job at a time, and turns
 * job progress into the JobState the UI renders.
 */
import { deepCheck, quickCheck } from "./chip";
import type { FlashableImage } from "./firmware";
import { type FlashOptions, makeOfficial } from "./flash";
import type { Activity, Job, JobContext, JobKind, JobState } from "./job";
import { type ConfigCapabilities, type KeymapDoc, type OsKeyMode, applyKeymap, capabilities } from "./keymap";
import { Busy, type DevicePort } from "./port";
import { type Clearance, SHIPPED, type Session } from "./protocol";

export interface Kit {
	readonly state: JobState;
	/** Calls `listener` on every state change. Returns the unsubscribe function. */
	subscribe(listener: (state: JobState) => void): () => void;
	check(depth: "quick" | "deep"): Promise<JobState>;
	/** `{ rewrite: true }` writes the image even when the board already holds it (unit U7). */
	makeOfficial(image: FlashableImage, options?: FlashOptions): Promise<JobState>;
	/** Writes `doc` to the board's RAM. `mode` is the OS key mode the board runs in (Fn+Q, Fn+W, or Fn+E), which no command reads. */
	applyKeymap(doc: KeymapDoc, mode: OsKeyMode): Promise<JobState>;
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
 */
export function createKit(port: DevicePort, clearance: Clearance = SHIPPED): Kit {
	/** Held only between jobs. A running job owns it and hands it back in its end. */
	let session: Session | null = null;
	let state: JobState = { kind: "idle", board: null };
	let controller: AbortController | null = null;
	const listeners = new Set<(state: JobState) => void>();
	const set = (next: JobState) => {
		state = next;
		for (const listener of listeners) listener(next);
	};

	async function run(kind: JobKind, job: Job): Promise<JobState> {
		// The UI disables job buttons while a job runs; this is the backstop.
		if (controller !== null) throw new Error(`a job is running; ${kind} must wait`);
		const running = new AbortController();
		controller = running;
		try {
			return await port.exclusive(async () => {
				const start = session;
				session = null;
				let activity: Activity = { kind: "reading" };
				const watched: DevicePort = {
					exclusive: (inner) => port.exclusive(inner),
					clock: port.clock,
					open: async (want, signal) => {
						// Called first, so a WebHID port has already parked or opened its chooser before the prompt shows.
						const opening = port.open(want, signal);
						set({ kind: "awaiting-device", job: kind, want, board: state.board });
						try {
							return await opening;
						} finally {
							set({ kind: "working", job: kind, activity, board: state.board });
						}
					},
				};
				const ctx: JobContext = {
					port: watched,
					clearance,
					signal: running.signal,
					progress: (next, board) => {
						activity = next;
						set({ kind: "working", job: kind, activity, board: board ?? state.board });
					},
				};
				const end = await job(start, ctx);
				session = end.session;
				const board = end.board ?? state.board;
				set(end.kind === "finished" ? { kind: "finished", job: kind, result: end.result, board } : { kind: "stopped", job: kind, reason: end.reason, board });
				return state;
			});
		} catch (error) {
			if (!(error instanceof Busy)) {
				set({ kind: "stopped", job: kind, reason: { kind: "error", message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, board: state.board });
				throw error;
			}
			set({ kind: "stopped", job: kind, reason: { kind: "busy" }, board: state.board });
			return state;
		} finally {
			controller = null;
		}
	}

	return {
		get state() {
			return state;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		check: (depth) => run(depth === "quick" ? "quick-check" : "deep-check", depth === "quick" ? quickCheck : deepCheck),
		makeOfficial: (image, options) => run("make-official", makeOfficial(image, options)),
		applyKeymap: (doc, mode) => run("apply-keymap", applyKeymap(doc, mode)),
		capabilities: () => capabilities(clearance),
		cancel: () => controller?.abort(),
	};
}

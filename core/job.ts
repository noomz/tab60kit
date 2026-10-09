/**
 * The contract between the kit and its jobs, and the state every screen renders.
 *
 * Ownership: the kit holds the open session between jobs. A job receives it, owns it while it runs, and hands
 * a session (or null) back in its end. No session is ever shared by two holders, so no lock guards it.
 */
import type { ChipState } from "./chip";
import type { CatalogEntry } from "./firmware";
import type { AppStep, IapStep } from "./flash";
import type { LayoutRefusal } from "./flashmap";
import type { DeviceWant } from "./port";
import type { LinkContext, Session } from "./protocol";
import type { Mode } from "./units";

export type JobKind = "quick-check" | "deep-check" | "make-official" | "apply-keymap";

export type Activity =
	| { readonly kind: "reading" }
	| { readonly kind: "restarting"; readonly into: Mode }
	/** The link gate before the first flash write on a link: `quietMs` of the `needMs` it requires (flash.ts judgeLink). */
	| { readonly kind: "holding-link"; readonly quietMs: number; readonly needMs: number }
	| { readonly kind: "erasing" }
	| { readonly kind: "writing-image"; readonly chunk: number; readonly chunks: number }
	| { readonly kind: "writing-version-block" }
	| { readonly kind: "applying-keymap"; readonly done: number; readonly total: number }
	| { readonly kind: "link-lost"; readonly losses: number };

export type StopReason =
	/** `during` tells the UI what may have happened, e.g. a cancel while restarting may leave the board in update mode. */
	| { readonly kind: "cancelled"; readonly during: Activity | null }
	| { readonly kind: "board-refused"; readonly refusal: LayoutRefusal }
	/** G1: why the first command the job needed is not cleared for this kit (protocol.ts gateMessage). Nothing was sent. */
	| { readonly kind: "gate"; readonly blocked: string }
	| { readonly kind: "os-permission"; readonly os: "linux" | "other" }
	| { readonly kind: "busy" }
	| { readonly kind: "attempts-exhausted"; readonly step: AppStep | IapStep; readonly attempts: number }
	| { readonly kind: "too-many-link-losses"; readonly losses: number };

export type JobResult =
	| { readonly kind: "checked"; readonly depth: "quick" | "deep" }
	| { readonly kind: "official"; readonly entry: CatalogEntry; readonly confirmedInNormalMode: boolean }
	| { readonly kind: "keymap-applied"; readonly writes: number };

/**
 * The one state the UI renders. `board` is the latest observation of the chip, or null before the first one.
 * Derived facts (the flash map, whether the board still boots) come from `report(board)` and `bootTarget(board)`
 * in chip.ts, never from a second stored copy.
 */
export type JobState =
	| { readonly kind: "idle"; readonly board: ChipState | null }
	| {
			readonly kind: "awaiting-device";
			readonly job: JobKind;
			readonly want: DeviceWant;
			readonly board: ChipState | null;
	  }
	| { readonly kind: "working"; readonly job: JobKind; readonly activity: Activity; readonly board: ChipState | null }
	| { readonly kind: "finished"; readonly job: JobKind; readonly result: JobResult; readonly board: ChipState | null }
	| { readonly kind: "stopped"; readonly job: JobKind; readonly reason: StopReason; readonly board: ChipState | null };

/**
 * What a running job may use besides its session: the kit's port (wrapped so that a pending `open` shows as
 * "awaiting-device"), the kit's clearance, the cancel signal, and progress for the UI.
 */
export interface JobContext extends LinkContext {
	/** Pass `board` when a fresh observation exists. */
	progress(activity: Activity, board?: ChipState): void;
}

/** How a job ends. The session goes back to the kit so the next job can reuse an open link. */
export type JobEnd =
	| {
			readonly kind: "finished";
			readonly result: JobResult;
			readonly session: Session | null;
			readonly board: ChipState | null;
	  }
	| {
			readonly kind: "stopped";
			readonly reason: StopReason;
			readonly session: Session | null;
			readonly board: ChipState | null;
	  };

export type Job = (start: Session | null, ctx: JobContext) => Promise<JobEnd>;

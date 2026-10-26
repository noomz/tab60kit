/**
 * Plan U7's hardware run, DOM-free so testing/u7.test.ts runs it against the fake board. It flashes the admitted image
 * over itself with the shipped flash job (`makeOfficial(image, { rewrite: true })`), runs a deep check, has the user
 * unplug USB and switch to Bluetooth on batteries, then records three keylog trials of the harness's phrase.
 * Each wire step is one job on a fresh JobContext; the run never shares a session between steps.
 */
import { type ChipState, deepCheck } from "../core/chip";
import type { CatalogEntry, FlashableImage } from "../core/firmware";
import { makeOfficial } from "../core/flash";
import type { Activity, JobContext, JobEnd } from "../core/job";
import type { DevicePort } from "../core/port";
import { type Clearance, type CommandName, labClearance } from "../core/protocol";
import type { TranscriptEntry } from "../testing/transcript";
import { type KeylogTrial, TRIALS, summarizeTrial } from "./keylog-trial";
import { preconditionsFor } from "./u1-state";
import { type Attestation, type StepOutcome, type UserStep, attestationMet } from "./u11-run";

export { type Attestation, type StepOutcome, type UserStep, attestEntry } from "./u11-run";

export const U7_PURPOSE = "U7: first write, V1.01.13 over itself, then a deep check and the keylog bar";
/** The seven U1 rows, the three reviewed flash-write rows, and get write address, which the user's D4 ruling added. */
export const U7_ROWS = [
	"readMode",
	"readBlInfo",
	"readFwInfo",
	"readVersionPage",
	"sum",
	"resetToIap",
	"resetToApp",
	"erase",
	"setWriteAddress",
	"getWriteAddress",
	"write",
] as const satisfies readonly CommandName[];

export const u7Clearance = (): Clearance => labClearance(U7_ROWS, U7_PURPOSE);

/**
 * Bytes 0..1 of each frame a step may send, written out so the frame check owes nothing to the registry. WRITE is
 * cmd 0x1F with its length in byte 1, so its pairs are listed apart.
 */
const READ_PAIRS = ["1202", "1200", "1201", "1220", "1221", "1222", "1d01", "1100", "1101"] as const;
const FLASH_ONLY_PAIRS = ["1d00", "1e01", "1e00"] as const;
export const WRITE_PAIRS: readonly string[] = Array.from({ length: 52 }, (_, i) => `1f${(i + 1).toString(16).padStart(2, "0")}`);
export const U7_PAIRS: readonly string[] = [...READ_PAIRS, ...FLASH_ONLY_PAIRS, ...WRITE_PAIRS];

/** Copied from lab/u12-run.ts: each of these saves the profile to flash, which this run must not do. */
export const DONT_PRESS: readonly string[] = [
	"Pn+R (resets the whole current profile, all three layers)",
	"Both Alt keys together (reset all layers; in Mac mode Alt and GUI swap, so both GUI keys too)",
	"Left GUI+Right Alt+Space",
	"Fn+Right Alt held while the board powers on",
	"Fn+Left Shift or Pn+Left Shift held 3 s (move Fn or Pn)",
	"Fn+Q, Fn+W, or Fn+E (OS key mode)",
	"Win lock",
	"The LED and layer function keys",
];

export const U7_PRECONDITIONS = [
	{ key: "stabilityTestPassed", label: "The wired stability test passed, with Karabiner's Caps Lock LED loop off" },
	{ key: "karabinerLedOff", label: "Karabiner's Caps Lock LED manipulation is off now" },
	{ key: "cableIn", label: "The USB cable is in, and I will not touch it until the page says the flash is done" },
	{ key: "tabInFront", label: "This tab stays in front and visible for the whole flash (a hidden tab slows the link check's probes)" },
	{ key: "recoveryReady", label: "MaruStation is ready with the vendor updater (Tab60firmwareV1.01.13.exe, run with -force) as recovery" },
	{ key: "secondKeyboardAtHand", label: "A second keyboard is at hand" },
	{ key: "bluetoothReady", label: "The batteries are in and the board is paired with this computer over Bluetooth" },
	{ key: "noSavingKeys", label: "During the run I will press only the keys the page names, and none on the do-not-press list" },
] as const;

export const u7Preconditions = preconditionsFor(U7_PRECONDITIONS);

/** A keylog trial: the user types the phrase into the page's box and presses Enter; the page stores the events as a mark. */
export interface TrialStep {
	readonly kind: "trial";
	readonly id: string;
	readonly label: string;
}

export type U7Step = { readonly kind: "flash" | "deep-check"; readonly id: string; readonly label: string; readonly pairs: readonly string[] } | UserStep | TrialStep;

const trials = Array.from(
	{ length: TRIALS },
	(_, i): TrialStep => ({ kind: "trial", id: `keylog-${i + 1}`, label: `Trial ${i + 1} of ${TRIALS}: type the phrase in the box on the TAB 60, then press Enter. Do not fix mistakes.` }),
);

/** The run, in order. The verdict holds the transcript's marks, attestations, and frames to this list. */
export const U7_STEPS: readonly U7Step[] = [
	{
		kind: "flash",
		id: "flash",
		label: "Make official, rewriting V1.01.13 over itself: the 15 s link check, two erases, 663 writes, the version block, and back to normal mode",
		pairs: U7_PAIRS,
	},
	{ kind: "deep-check", id: "deep-check", label: "Deep check: the board's sum and version page", pairs: READ_PAIRS },
	{
		kind: "user",
		id: "bluetooth",
		label: "Unplug USB. Switch the board to Bluetooth; the batteries keep it running. Click in the box below before you type.",
		question: "Is USB unplugged, and does the board type over Bluetooth on its batteries?",
		keylog: null,
	},
	...trials,
];

export interface U7Context {
	readonly port: DevicePort;
	readonly clearance: Clearance;
	readonly image: FlashableImage;
	readonly signal: AbortSignal;
	/** Shows a user step and resolves with the user's answer, which the caller records. */
	attend(step: UserStep): Promise<Attestation>;
	/** Shows a trial step and resolves with what was typed; the run records it as the step's mark. */
	type(step: TrialStep): Promise<KeylogTrial>;
	mark(step: string, text: string): void;
	progress(activity: Activity): void;
	onStep(outcome: StepOutcome): void;
}

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
const hex32 = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, "0")}`;

/** Whether an update-mode observation holds `entry`: its image by the sum, and its page by the catalog or the block's hash. */
export function holdsEntry(chip: ChipState | null, entry: CatalogEntry): boolean {
	if (chip?.mode !== "iap") return false;
	const image = chip.image.kind === "official" ? chip.image.entry.id === entry.id : chip.image.sum === entry.image.wireSum32;
	const page = chip.page.kind === "official" ? chip.page.entry.id === entry.id : chip.page.kind === "unknown" && chip.page.sha256 === entry.versionBlock.sha256;
	return image && page;
}

function chipText(chip: ChipState | null): string {
	if (chip?.mode !== "iap") return "no update-mode observation";
	const image = chip.image.kind === "official" ? `image official ${chip.image.entry.version}` : `image sum ${hex32(chip.image.sum)}`;
	const page = chip.page.kind === "official" ? `page official ${chip.page.entry.version}` : chip.page.kind === "unknown" ? `page ${chip.page.sha256.slice(0, 16)}` : "page erased";
	return `${image}, ${page}`;
}

const endText = (end: JobEnd) => (end.kind === "finished" ? end.result.kind : `stopped: ${JSON.stringify(end.reason)}`);

/** Runs one job and returns its end and the last update-mode observation it reported. */
async function runJob(ctx: U7Context, job: (start: null, jobCtx: JobContext) => Promise<JobEnd>): Promise<{ readonly end: JobEnd; readonly iap: ChipState | null }> {
	let iap: ChipState | null = null;
	const jobCtx: JobContext = {
		port: ctx.port,
		clearance: ctx.clearance,
		signal: ctx.signal,
		progress: (activity, board) => {
			if (board?.mode === "iap") iap = board;
			ctx.progress(activity);
		},
	};
	const end = await job(null, jobCtx);
	await end.session?.close();
	return { end, iap };
}

async function runWire(ctx: U7Context, kind: "flash" | "deep-check"): Promise<{ readonly pass: boolean; readonly detail: string }> {
	const { entry } = ctx.image;
	if (kind === "flash") {
		const { end, iap } = await runJob(ctx, makeOfficial(ctx.image, { rewrite: true }));
		const pass = end.kind === "finished" && end.result.kind === "official" && end.result.entry.id === entry.id && holdsEntry(iap, entry);
		return { pass, detail: `${endText(end)}; last in update mode: ${chipText(iap)}` };
	}
	const { end, iap } = await runJob(ctx, deepCheck);
	return { pass: end.kind === "finished" && holdsEntry(iap, entry), detail: `${endText(end)}; ${chipText(iap)}` };
}

/**
 * Runs U7_STEPS in order. A failed wire step stops the run, because the steps after it would test a board in an
 * unknown state; a failed user or trial step does not, so the verdict sees all three trials.
 */
export async function runU7(ctx: U7Context): Promise<readonly StepOutcome[]> {
	const outcomes: StepOutcome[] = [];
	const report = (outcome: StepOutcome) => {
		outcomes.push(outcome);
		ctx.onStep(outcome);
	};
	for (const step of U7_STEPS) {
		switch (step.kind) {
			case "flash":
			case "deep-check": {
				ctx.mark(step.id, "begin");
				const result = await runWire(ctx, step.kind).catch((error: unknown) => ({ pass: false, detail: describe(error) }));
				report({ id: step.id, label: step.label, ...result });
				if (!result.pass) return outcomes;
				break;
			}
			case "user": {
				const attestation = await ctx.attend(step);
				report({ id: step.id, label: step.label, pass: attestationMet(step, attestation), detail: attestation.answer ? "yes" : "no" });
				break;
			}
			case "trial": {
				const trial = await ctx.type(step);
				ctx.mark(step.id, JSON.stringify(trial));
				const s = summarizeTrial(trial);
				report({
					id: step.id,
					label: step.label,
					pass: s.repeats === 0 && s.lostUps === 0 && s.firstKeyDelivered,
					detail: `${s.missing} missing, ${s.extra} extra, ${s.repeats} autorepeats, ${s.lostUps} lost key-ups, first key ${s.firstKeyDelivered ? "delivered" : "lost"}`,
				});
				break;
			}
			default: {
				const exhaustive: never = step;
				return exhaustive;
			}
		}
	}
	return outcomes;
}

/** Bytes 0..3 of each sent frame (the header of a WRITE) whose bytes 0..1 are not a U7 row. Evidence only when empty. */
export function framesOutsideU7(entries: readonly TranscriptEntry[]): readonly string[] {
	return entries.flatMap((entry) => {
		const head = entry.kind === "out" ? entry.hex : entry.kind === "out-write" ? entry.header : null;
		return head !== null && !U7_PAIRS.includes(head.slice(0, 4)) ? [head.slice(0, 8)] : [];
	});
}

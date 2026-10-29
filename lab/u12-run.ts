/**
 * Unit U12's hardware run, DOM-free so testing/u12.test.ts runs it against the fake board. It applies a five-key
 * document with the shipped apply job, has the user type each key, reloads the page and reads the document back from
 * the editor's storage, has the user pull the batteries, reads the five keys back at 0x00FF, applies the stored
 * document once, has the user type each key again, then applies the empty document, which restores all five.
 *
 * The run pauses at the reload step: the page saves its progress and reloads, and a click on Continue resumes it
 * from that step, which records what storage held as a "mark" entry. Each wire step opens and closes its own session.
 */
import type { JobContext, JobEnd } from "../core/job";
import { type KeymapDoc, type OsKeyMode, applyKeymap, keyId, serializeKeymapDoc, usage } from "../core/keymap";
import type { DevicePort } from "../core/port";
import { type Clearance, type CommandName, connect, labClearance } from "../core/protocol";
import type { TranscriptEntry } from "../testing/transcript";
import { withOverride } from "../web/editor";
import { EMPTY_KEYMAP, type KeyValueStore, loadKeymap, saveKeymap } from "../web/keymap-store";
import { targetOf } from "../web/usages";
import { preconditionsFor } from "./u1-state";
import { type Attestation, type StepOutcome, type UserStep, attestationMet } from "./u11-run";

export { type Attestation, type StepOutcome, type UserStep, attestEntry } from "./u11-run";

export const U12_PURPOSE = "U12: apply a five-key keymap, keep it across a reload, and restore it after a battery pull";
/** The rows the apply job and the read step send: the attach reads, the override reads, the gate, and the key write. */
export const U12_ROWS = ["readMode", "readBlInfo", "cfgReadKeys", "cfgReadKey", "gateQuery", "gateOpen", "gateClose", "cfgWriteKey"] as const satisfies readonly CommandName[];
/** Bytes 0..1 of each frame the run may send, written out so the frame check owes nothing to the registry. */
export const U12_PAIRS: readonly string[] = ["1202", "1200", "5221", "5220", "41ff", "4180", "4100", "5120"];

export const u12Clearance = (): Clearance => labClearance(U12_ROWS, U12_PURPOSE);

export const U12_PRECONDITIONS = [
	{ key: "keyboardFree", label: "No other app holds the keyboard" },
	{ key: "powerCycled", label: "Since the last lab run I unplugged USB with the batteries out for 10 seconds, so no earlier RAM write remains" },
	{ key: "noHostRemap", label: "Neither macOS Modifier Keys nor Karabiner remaps Esc, Z, /, \\, or Right Ctrl" },
	{
		key: "noSavingKeys",
		label:
			"During the run I will press only the keys the page names, each on its own. Each of these saves the profile to flash and spoils the battery-pull phase: Pn+R (resets the whole current profile, all three layers), both Alt keys together (reset all layers; in Mac mode Alt and GUI swap, so both GUI keys too), Left GUI+Right Alt+Space, Fn+Right Alt held while the board powers on, Fn+Left Shift or Pn+Left Shift held 3 s (move Fn or Pn), Pn+Q, Pn+W, or Pn+E (OS key mode), Win lock, and the LED and layer function keys",
	},
] as const;

export const u12Preconditions = preconditionsFor(U12_PRECONDITIONS);

/**
 * Five layer 0 keys that are safe to press and whose usage is the same in every OS key mode (no Caps, Ctrl on the
 * left, Alt, or GUI), so the frames below hold for any mode. `cell` is the KeyId.
 */
export const U12_KEYS = [
	{ cell: 0, legend: "Esc", from: 0x29, to: 0x35 },
	{ cell: 7, legend: "Z", from: 0x1d, to: 0x1c },
	{ cell: 46, legend: "/", from: 0x38, to: 0x52 },
	{ cell: 51, legend: "\\", from: 0x31, to: 0x2a },
	{ cell: 63, legend: "Right Ctrl", from: 0xe4, to: 0x4f },
] as const;

export const U12_DOC: KeymapDoc = U12_KEYS.reduce((doc, { cell, to }) => withOverride(doc, 0, keyId(cell), usage(to)), EMPTY_KEYMAP);

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const codeOf = (u: number) => targetOf(usage(u))?.code ?? `usage-0x${hex2(u)}`;

/** The cfgWriteKey request for each key, in the job's layer-then-key order: its target, or 0x00FF for the restore. */
export const writeFrames = (restore: boolean): readonly string[] => U12_KEYS.map(({ from, to }) => `5120${hex2(from)}00${restore ? "ff" : hex2(to)}00`);
/** The cfgReadKey request and its reply for each key, holding its target or 0x00FF. */
export const readFrames = (restored: boolean): readonly { readonly request: string; readonly reply: string }[] =>
	U12_KEYS.map(({ from, to }) => ({ request: `5220${hex2(from)}00`, reply: `5220${hex2(from)}00${restored ? "ff" : hex2(to)}00` }));

export type U12Step =
	| { readonly kind: "apply"; readonly id: string; readonly label: string; readonly doc: "five" | "stored" | "empty"; readonly writes: number }
	| { readonly kind: "read"; readonly id: string; readonly label: string; readonly restored: boolean }
	| { readonly kind: "reload"; readonly id: "reload"; readonly label: string }
	| UserStep;

const keylogs = (round: string, what: string): readonly UserStep[] =>
	U12_KEYS.map(({ legend, from, to }) => ({
		kind: "user",
		id: `keylog-${round}-${hex2(from)}`,
		label: `Press ${legend} on the TAB 60 two or three times, and no other key.`,
		question: `Did ${legend} ${what} ${targetOf(usage(to))?.name}, with the keylog showing ${codeOf(to)} and no ${codeOf(from)}?`,
		keylog: { want: codeOf(to), not: codeOf(from) },
	}));

/** The run, in order. The verdict holds the transcript's marks, frames, and attestations to this list. */
export const U12_STEPS: readonly U12Step[] = [
	{ kind: "apply", id: "apply-five", label: "Apply the five-key keymap and keep it in the editor's storage", doc: "five", writes: 5 },
	...keylogs("applied", "type"),
	{ kind: "reload", id: "reload", label: "Reload this page. After it loads, click Continue: the page reads the keymap back from storage." },
	{
		kind: "user",
		id: "battery-pull",
		label: "Unplug USB and take the batteries out. Wait 10 seconds. Plug USB back in with no batteries, and press no key while the board starts (Fn+Right Alt held at power-on saves to flash).",
		question: "Did you unplug USB with the batteries out for 10 seconds, and press no key since the Apply?",
		keylog: null,
	},
	{ kind: "read", id: "read-after-pull", label: "Read the five keys: the battery pull left each at 0x00FF", restored: true },
	{ kind: "apply", id: "apply-stored", label: "Apply the keymap the page read from storage, once", doc: "stored", writes: 5 },
	...keylogs("again", "type"),
	{ kind: "apply", id: "restore", label: "Apply the empty keymap: the five keys go back to 0x00FF, and the gate closes", doc: "empty", writes: 5 },
	{ kind: "read", id: "read-restored", label: "Read the five keys: each holds 0x00FF", restored: true },
];

export const RELOAD_INDEX = U12_STEPS.findIndex((step) => step.kind === "reload");

export interface U12Context {
	readonly port: DevicePort;
	readonly clearance: Clearance;
	readonly mode: OsKeyMode;
	readonly storage: () => KeyValueStore;
	readonly signal: AbortSignal;
	/** Shows a user step and resolves with the user's answer, which the caller records. */
	attend(step: UserStep): Promise<Attestation>;
	mark(step: string, text: string): void;
	onStep(outcome: StepOutcome): void;
}

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

function endText(end: JobEnd): string {
	return end.kind === "finished" ? (end.result.kind === "keymap-applied" ? `${end.result.writes} writes` : end.result.kind) : `stopped: ${JSON.stringify(end.reason)}`;
}

async function runApply(ctx: U12Context, step: Extract<U12Step, { kind: "apply" }>): Promise<{ readonly pass: boolean; readonly detail: string }> {
	let doc: KeymapDoc;
	if (step.doc === "stored") doc = loadKeymap(ctx.storage).doc;
	else {
		doc = step.doc === "five" ? U12_DOC : EMPTY_KEYMAP;
		const problem = saveKeymap(ctx.storage, doc, ctx.mode);
		if (problem !== null) return { pass: false, detail: problem };
	}
	const job: JobContext = { port: ctx.port, clearance: ctx.clearance, signal: ctx.signal, progress: () => undefined };
	const end = await applyKeymap(doc, ctx.mode)(null, job);
	await end.session?.close();
	const pass = end.kind === "finished" && end.result.kind === "keymap-applied" && end.result.writes === step.writes;
	return { pass, detail: endText(end) };
}

async function runRead(ctx: U12Context, restored: boolean): Promise<{ readonly pass: boolean; readonly detail: string }> {
	const session = await connect(ctx, { modes: ["app"], reason: "connect" });
	if ("refusal" in session) {
		await session.close();
		return { pass: false, detail: `attach refused: ${session.refusal.code}` };
	}
	try {
		const read = [];
		for (const { from, to } of U12_KEYS) {
			const entry = await session.config.readKey(0, usage(from), ctx.signal);
			const want = restored ? entry.kind === "default" : entry.kind === "override" && entry.flags === 0 && entry.code === to;
			read.push({ want, text: entry.kind === "override" ? `0x${hex2(entry.code)}` : entry.kind });
		}
		return { pass: read.every(({ want }) => want), detail: read.map(({ text }) => text).join(" ") };
	} finally {
		await session.close();
	}
}

/**
 * Runs U12_STEPS from `from`. Arriving at the reload step stops the run with `paused`; starting at it records what
 * storage holds and goes on. A failed apply or read step stops the run, because the steps after it would test a board
 * in an unknown state; a failed user or reload step does not, so the verdict sees the rest.
 */
export async function runU12(ctx: U12Context, from: number): Promise<{ readonly outcomes: readonly StepOutcome[]; readonly paused: boolean }> {
	const outcomes: StepOutcome[] = [];
	const report = (outcome: StepOutcome) => {
		outcomes.push(outcome);
		ctx.onStep(outcome);
	};
	for (let i = from; i < U12_STEPS.length; i++) {
		const step = U12_STEPS[i]!;
		switch (step.kind) {
			case "reload": {
				if (i !== from) return { outcomes, paused: true };
				const stored = loadKeymap(ctx.storage);
				const text = serializeKeymapDoc(stored.doc);
				ctx.mark(step.id, text);
				const pass = text === serializeKeymapDoc(U12_DOC) && stored.mode === ctx.mode;
				report({ id: step.id, label: step.label, pass, detail: stored.problem ?? `${stored.doc.overrides.get(0)?.size ?? 0} overrides on layer 0, mode ${stored.mode ?? "none"}` });
				break;
			}
			case "user": {
				const attestation = await ctx.attend(step);
				report({ id: step.id, label: step.label, pass: attestationMet(step, attestation), detail: `${attestation.answer ? "yes" : "no"}, keys ${attestation.keys.join(" ") || "none"}` });
				break;
			}
			case "apply":
			case "read": {
				ctx.mark(step.id, "begin");
				const result = await (step.kind === "apply" ? runApply(ctx, step) : runRead(ctx, step.restored)).catch((error: unknown) => ({ pass: false, detail: describe(error) }));
				report({ id: step.id, label: step.label, ...result });
				if (!result.pass) return { outcomes, paused: false };
				break;
			}
			default: {
				const exhaustive: never = step;
				return exhaustive;
			}
		}
	}
	return { outcomes, paused: false };
}

/** Each sent frame whose bytes 0..1 are not one of the U12 rows. The transcript is evidence only when this is empty. */
export function framesOutsideU12(entries: readonly TranscriptEntry[]): readonly string[] {
	return entries.flatMap((entry) => (entry.kind === "out" && !U12_PAIRS.includes(entry.hex.slice(0, 4)) ? [entry.hex] : []));
}

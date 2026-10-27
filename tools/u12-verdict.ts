/**
 * Plan U12's verdict on a saved lab/u12 transcript. It walks the transcript's own marks, attestations, and frames
 * against U12_STEPS: each wire step's frames are the ones between its "begin" mark and the next mark or attestation.
 * Frames before the first mark, after an attestation or the reload mark, and anything but cfgReadKey and the attach in a
 * read step fail the frame check. Each step is checked where it stands, so a run that stopped early still shows which
 * steps passed. It holds the five writes, their replies, the five reads, the gate at the end of each Apply, the keymap the page read
 * back after the reload, and each keylog to the plan. The page's results are never read. Only a full PASS writes the
 * capture.
 *
 * Run: bun tools/u12-verdict.ts <transcript.json> [--out fixtures/u12-macos.json]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { serializeKeymapDoc } from "../core/keymap";
import { OS_KEY_MODE_NAME } from "../web/view";
import { U12_DOC, U12_STEPS, type U12Step, type UserStep, framesOutsideU12, readFrames, u12Preconditions, writeFrames } from "../lab/u12-run";
import { type Environment, type Transcript, type TranscriptEntry, parseTranscript } from "../testing/transcript";
import { notRealBoardCleanBuild } from "./u1-verdict";

export interface U12Check {
	readonly title: string;
	readonly pass: boolean;
	readonly detail: string;
}

export interface U12Fixture {
	readonly format: "tab60kit-u12-verdict/1";
	readonly evaluatedAt: string;
	readonly transcriptFile: string;
	readonly environment: Environment;
	readonly checks: readonly U12Check[];
	readonly transcript: Transcript;
}

const REPORT_HEX_CHARS = 128;
const ERROR_MARKER = "ffaa";
const report = (head: string) => head.padEnd(REPORT_HEX_CHARS, "0");

interface Frame {
	readonly out: string;
	reply: string | null;
}

/** A mark or an attestation, with the frames sent after it up to the next one. */
interface Marker {
	readonly kind: "mark" | "attest";
	readonly step: string;
	readonly text: string;
	readonly answer: boolean;
	readonly keys: readonly string[];
	readonly frames: Frame[];
}

/**
 * A frame's reply is the first report after it whose byte 0 repeats the frame's, or the error marker. Frames before
 * the first marker go to `early`.
 */
function markers(entries: readonly TranscriptEntry[]): { readonly found: readonly Marker[]; readonly early: readonly Frame[] } {
	const found: Marker[] = [];
	const early: Frame[] = [];
	let last: Frame | null = null;
	for (const entry of entries) {
		if (entry.kind === "out") {
			last = { out: entry.hex, reply: null };
			(found.at(-1)?.frames ?? early).push(last);
		} else if (entry.kind === "in" && last !== null && last.reply === null && (entry.hex.slice(0, 2) === last.out.slice(0, 2) || entry.hex.startsWith(ERROR_MARKER))) {
			last.reply = entry.hex;
		} else if (entry.kind === "mark") {
			found.push({ kind: "mark", step: entry.step, text: entry.text, answer: true, keys: [], frames: [] });
		} else if (entry.kind === "attest") {
			found.push({ kind: "attest", step: entry.step, text: "", answer: entry.answer, keys: entry.keys, frames: [] });
		}
	}
	return { found, early };
}

/** The attach reads every session opens, the only frames a read step sends besides cfgReadKey. */
const READ_STEP_PAIRS: readonly string[] = ["1202", "1200", "5220"];

const plannedKind = (step: U12Step) => (step.kind === "user" ? "attest" : "mark");
const shownAs = (marker: Marker | undefined) => (marker === undefined ? "nothing" : `${marker.kind} ${marker.step}`);
const check = (title: string, problems: readonly string[], ok: string): U12Check => ({ title, pass: problems.length === 0, detail: problems.length === 0 ? ok : problems.join("; ") });

export const TITLES = {
	frames: "Every frame sent is one of the eight U12 rows, inside a wire step that may send it",
	order: "The marks and attestations follow the plan, step by step",
	applied: "Both Applies of the keymap write the five keys as planned, each reply holds its value, and each ends with the gate closed",
	keylog: "After each Apply the keylog shows every key's new code and not its old one, and the user said yes",
	reload: "After the reload the page read the five-key keymap back from storage",
	pull: "After the battery pull the five keys read 0x00FF",
	restore: "The empty keymap restores the five keys to 0x00FF, the gate closes, and the five keys read 0x00FF",
	preconditions: "The OS key mode was chosen and the preconditions were ticked before the first frame and held for the run",
} as const;

export function evaluateU12(transcript: Transcript): readonly U12Check[] {
	const { entries, environment } = transcript;
	const { found, early } = markers(entries);
	const placed = U12_STEPS.map((step, i) => {
		const got = found[i];
		return got !== undefined && got.kind === plannedKind(step) && got.step === step.id && (step.kind === "reload" || step.kind === "user" || got.text === "begin");
	});
	const order = U12_STEPS.flatMap((step, i) => (placed[i] ? [] : [`step ${i + 1} (${step.id}): planned ${plannedKind(step)} ${step.id}, got ${shownAs(found[i])}`]));
	if (found.length > U12_STEPS.length) order.push(`${found.length - U12_STEPS.length} more after the plan, the first ${shownAs(found[U12_STEPS.length])}`);
	/** The step's marker when it stands where the plan puts it, else the problem that says it does not. */
	const at = (id: string): Marker | string => {
		const i = U12_STEPS.findIndex((step) => step.id === id);
		return placed[i] ? found[i]! : `${id}: not where the plan puts it`;
	};
	const misplaced = [
		...early.map((frame) => `frame ${frame.out.slice(0, 12)} before the first step`),
		...U12_STEPS.flatMap((step, i) => {
			const marker = placed[i] ? found[i]! : null;
			if (marker === null || step.kind === "apply") return [];
			const allowed = step.kind === "read" ? READ_STEP_PAIRS : [];
			return marker.frames.flatMap((frame) => (allowed.includes(frame.out.slice(0, 4)) ? [] : [`frame ${frame.out.slice(0, 12)} in ${step.kind} step ${step.id}`]));
		}),
	];

	const writes = (id: string, restore: boolean) => {
		const marker = at(id);
		if (typeof marker === "string") return [marker];
		const { frames } = marker;
		const sent = frames.filter((frame) => frame.out.startsWith("5120"));
		const want = writeFrames(restore);
		const problems = sent.length === want.length && sent.every((frame, i) => frame.out === report(want[i]!)) ? [] : [`${id}: wrote ${sent.map((frame) => frame.out.slice(0, 12)).join(" ") || "nothing"}, planned ${want.join(" ")}`];
		for (const frame of sent) if (frame.reply?.slice(0, 12) !== frame.out.slice(0, 12)) problems.push(`${id}: ${frame.out.slice(0, 12)} got ${frame.reply === null ? "no reply" : frame.reply.slice(0, 16)}`);
		const gate = frames.filter((frame) => frame.out.startsWith("41")).at(-1);
		if (gate?.out !== report("41ff0000") || gate.reply !== report("41000000")) problems.push(`${id}: the last gate frame is ${gate === undefined ? "missing" : `${gate.out.slice(0, 8)} reading ${gate.reply?.slice(0, 8) ?? "no reply"}`}, not a query reading 41000000`);
		return problems;
	};
	const reads = (id: string) => {
		const marker = at(id);
		if (typeof marker === "string") return [marker];
		const { frames } = marker;
		const sent = frames.filter((frame) => frame.out.startsWith("5220"));
		const want = readFrames(true);
		if (sent.length !== want.length) return [`${id}: ${sent.length} reads, planned ${want.length}`];
		return want.flatMap(({ request, reply }, i) =>
			sent[i]!.out === report(request) && sent[i]!.reply === report(reply) ? [] : [`${id}: wanted ${reply}, got ${sent[i]!.out.slice(0, 8)} reading ${sent[i]!.reply?.slice(0, 12) ?? "no reply"}`],
		);
	};
	const attested = (ids: readonly string[]) =>
		ids.flatMap((id) => {
			const marker = at(id);
			if (typeof marker === "string") return [marker];
			const { answer, keys } = marker;
			const { keylog } = U12_STEPS.find((step): step is UserStep => step.kind === "user" && step.id === id)!;
			return [
				...(answer ? [] : [`${id}: the user answered no`]),
				...(keylog !== null && !keys.includes(keylog.want) ? [`${id}: the keylog shows no ${keylog.want} (${keys.join(" ") || "nothing"})`] : []),
				...(keylog !== null && keys.includes(keylog.not) ? [`${id}: the keylog shows ${keylog.not}`] : []),
			];
		});
	const keylogIds = U12_STEPS.flatMap((step) => (step.kind === "user" && step.keylog !== null ? [step.id] : []));
	const reloaded = at("reload");
	const stored = typeof reloaded === "string" ? [reloaded] : reloaded.text === serializeKeymapDoc(U12_DOC) ? [] : [`storage held ${JSON.stringify(reloaded.text)}`];
	const mode = environment.osKeyMode;
	const unmet = [
		...(mode !== undefined && Object.hasOwn(OS_KEY_MODE_NAME, mode) ? [] : [`environment.osKeyMode is ${JSON.stringify(mode)}, not a mode`]),
		...u12Preconditions.unmetPreconditions(transcript).map((label) => `not met: ${label}`),
	];
	const frames = entries.filter((entry) => entry.kind === "out").length;
	return [
		check(TITLES.frames, [...framesOutsideU12(entries).map((hex) => `frame outside the U12 rows: ${hex}`), ...misplaced], `${frames} frames, all U12 rows, each in a step that sends it`),
		check(TITLES.order, order, `${U12_STEPS.length} steps in plan order`),
		check(TITLES.applied, [...writes("apply-five", false), ...writes("apply-stored", false)], "five writes echoed in each Apply, gate closed after each"),
		check(TITLES.keylog, attested(keylogIds), `${keylogIds.length} keylogs`),
		check(TITLES.reload, stored, "the stored keymap is the five-key document"),
		check(TITLES.pull, [...attested(["battery-pull"]), ...reads("read-after-pull")], "the battery pull dropped the five writes"),
		check(TITLES.restore, [...writes("restore", true), ...reads("read-restored")], "the five keys are back to 0x00FF and the gate is closed"),
		check(TITLES.preconditions, unmet, `mode ${mode}, all ticked before the first frame, none changed`),
	];
}

const USAGE = "usage: bun tools/u12-verdict.ts <transcript.json> [--out fixtures/u12-macos.json]";

function parseArgs(argv: readonly string[]): { readonly transcriptFile: string; readonly out: string | null } | string {
	let transcriptFile: string | null = null;
	let out: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--out") out = argv[++i] ?? "";
		else if (arg.startsWith("-")) return `unknown option ${arg}`;
		else if (transcriptFile === null) transcriptFile = arg;
		else return `unexpected argument ${arg}`;
	}
	if (transcriptFile === null) return "no transcript file";
	if (out === "") return "--out needs a path";
	return { transcriptFile, out };
}

export function verdictMain(argv: readonly string[]): number {
	const args = parseArgs(argv);
	if (typeof args === "string") {
		console.error(`${args}\n${USAGE}`);
		return 2;
	}
	let transcript: Transcript;
	try {
		transcript = parseTranscript(JSON.parse(readFileSync(args.transcriptFile, "utf8")));
	} catch (error) {
		console.error(`${args.transcriptFile}: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
	const refusal = notRealBoardCleanBuild(transcript.environment);
	if (refusal !== null) {
		console.error(`${refusal}. Wrote nothing.`);
		return 2;
	}
	const checks = evaluateU12(transcript);
	for (const [key, value] of Object.entries(transcript.environment)) console.log(`environment ${key}: ${value}`);
	for (const { title, pass, detail } of checks) console.log(`${pass ? "PASS" : "FAIL"} ${title}\n     ${detail}`);
	if (!checks.every(({ pass }) => pass)) {
		console.log(args.out === null ? "FAIL" : `FAIL, so wrote nothing to ${args.out}`);
		return 1;
	}
	if (args.out !== null) {
		const fixture: U12Fixture = { format: "tab60kit-u12-verdict/1", evaluatedAt: new Date().toISOString(), transcriptFile: args.transcriptFile, environment: transcript.environment, checks, transcript };
		mkdirSync(dirname(args.out), { recursive: true });
		writeFileSync(args.out, `${JSON.stringify(fixture, null, "\t")}\n`);
		console.log(`wrote ${args.out}`);
	}
	return 0;
}

if (import.meta.main) process.exit(verdictMain(process.argv.slice(2)));

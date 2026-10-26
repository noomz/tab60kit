/**
 * Plan U7's verdict on a saved lab/u7 transcript. It walks the transcript's own marks, attestations, frames, and
 * replies against U7_STEPS, as tools/u12-verdict.ts does, and holds the flash to the plan: the link gate before the
 * first ERASE, the two ERASEs, a read-back after every set write address, every write payload against the image's
 * chunks, the deep check's sum and version page, and the keylog bar. The page's own results are never read. The
 * expected chunk hashes come from the user's exe, which is never committed. Only a full PASS writes the capture.
 *
 * Run: bun tools/u7-verdict.ts <transcript.json> --exe <Tab60firmwareV1.01.13.exe> [--out fixtures/u7-macos.json]
 * (or set TAB60_EXE in place of --exe)
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CATALOG, type CatalogEntry, type FlashableImage, imageBytes, readUpdater } from "../core/firmware";
import { MAX_MISSING, PHRASE, TRIALS, parseKeylogTrial, summarizeTrial } from "../lab/keylog-trial";
import { U7_STEPS, type U7Step, framesOutsideU7, u7Preconditions } from "../lab/u7-run";
import { type Environment, type Transcript, type TranscriptEntry, parseTranscript } from "../testing/transcript";
import { notRealBoardCleanBuild } from "./u1-verdict";

export interface U7Check {
	readonly title: string;
	readonly pass: boolean;
	readonly detail: string;
}

export interface U7Fixture {
	readonly format: "tab60kit-u7-verdict/1";
	readonly evaluatedAt: string;
	readonly transcriptFile: string;
	readonly environment: Environment;
	readonly checks: readonly U7Check[];
	readonly transcript: Transcript;
}

/** What the flash must have written and what the deep check must read: the catalog entry and each chunk's SHA-256 by window offset. */
export interface U7Expected {
	readonly entry: CatalogEntry;
	readonly chunks: ReadonlyMap<number, { readonly bytes: number; readonly sha256: string }>;
}

const CHUNK = 52;
const IMAGE_OFFSET = 0x200;
const VERSION_PAGE: readonly [number, number] = [0, 0x200];
const APP_REGION: readonly [number, number] = [0x200, 0x1ce00 - 0x200];
const WHOLE_WINDOW: readonly [number, number] = [0, 0x1ce00];
const GATE_QUIET_MS = 15_000;
const GATE_MAX_GAP_MS = 1_000;
const CURSOR_QUERY = 0xffff_ffff;

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The chunks a correct flash writes: the wire image's at 0x200 + 52i, then the version block's at 52j. */
export function expectedFor(image: FlashableImage): U7Expected {
	const { wire, versionBlock } = imageBytes(image);
	const chunks = new Map<number, { bytes: number; sha256: string }>();
	for (const [base, bytes] of [
		[IMAGE_OFFSET, wire.bytes],
		[0, versionBlock.bytes],
	] as const) {
		for (let at = 0; at < bytes.length; at += CHUNK) {
			const chunk = bytes.subarray(at, at + CHUNK);
			chunks.set(base + at, { bytes: chunk.length, sha256: sha256Hex(chunk) });
		}
	}
	return { entry: image.entry, chunks };
}

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const u32At = (hex: string, byte: number) => new DataView(fromHex(hex.slice(2 * byte, 2 * byte + 8)).buffer).getUint32(0, true);
const hex32 = (n: number) => `0x${(n >>> 0).toString(16)}`;
const range = ([offset, length]: readonly [number, number]) => `[${hex32(offset)}, ${hex32(offset + length)})`;

/** One frame the page sent: its bytes 0..3 as hex, the full hex when not a WRITE, and the reply that answered it. */
interface Frame {
	readonly t: number;
	readonly head: string;
	readonly hex: string | null;
	readonly write: { readonly bytes: number; readonly sha256: string } | null;
	reply: { readonly t: number; readonly hex: string } | null;
	/** True once any other frame went out after this one. */
	followed: boolean;
	/** An open, close, or loss came between this frame and the previous one. */
	readonly newLink: boolean;
}

interface Marker {
	readonly kind: "mark" | "attest";
	readonly step: string;
	readonly text: string;
	readonly answer: boolean;
	readonly frames: Frame[];
}

/** A reply answers a frame when it repeats byte 0 or carries the error marker; a WRITE's answer is 1E 02. */
function answers(frame: Frame, hex: string): boolean {
	if (hex.startsWith("ffaa")) return true;
	return frame.write !== null ? hex.startsWith("1e02") : hex.slice(0, 2) === frame.head.slice(0, 2);
}

function walk(entries: readonly TranscriptEntry[]): { readonly found: readonly Marker[]; readonly early: readonly Frame[]; readonly frames: readonly Frame[] } {
	const found: Marker[] = [];
	const early: Frame[] = [];
	const frames: Frame[] = [];
	let last: Frame | null = null;
	let linkChanged = false;
	for (const entry of entries) {
		if (entry.kind === "out" || entry.kind === "out-write") {
			if (last !== null) last.followed = true;
			last =
				entry.kind === "out"
					? { t: entry.t, head: entry.hex.slice(0, 8), hex: entry.hex, write: null, reply: null, followed: false, newLink: linkChanged }
					: { t: entry.t, head: entry.header, hex: null, write: { bytes: entry.payloadBytes, sha256: entry.payloadSha256 }, reply: null, followed: false, newLink: linkChanged };
			linkChanged = false;
			frames.push(last);
			(found.at(-1)?.frames ?? early).push(last);
		} else if (entry.kind === "in" && last !== null && last.reply === null && !last.followed && answers(last, entry.hex)) {
			last.reply = { t: entry.t, hex: entry.hex };
		} else if (entry.kind === "opened" || entry.kind === "closed" || entry.kind === "lost") {
			linkChanged = true;
		} else if (entry.kind === "mark") {
			found.push({ kind: "mark", step: entry.step, text: entry.text, answer: true, frames: [] });
		} else if (entry.kind === "attest") {
			found.push({ kind: "attest", step: entry.step, text: "", answer: entry.answer, frames: [] });
		}
	}
	return { found, early, frames };
}

export const TITLES = {
	frames: "Every frame sent is one of the eleven U7 rows, inside a step that may send it",
	order: "The marks and attestations follow the plan, step by step",
	gate: "The link gate held at least 15 s, with answered probes no more than 1 s apart, before the first ERASE",
	erase: "Exactly two ERASEs, [0, 0x200) then [0x200, 0x1CE00), each answered before the next frame",
	cursor: "Every set write address is followed by a get write address that reads it back",
	writes: "All 663 write payloads (659 image chunks and 4 version-block chunks) match the image and the version block",
	deep: "The deep check after the flash reads the image's sum and a version page with the block's hash",
	keylog: "Battery and Bluetooth, 3 trials: at most 1 of 162 characters missing, no autorepeat, no lost key-up, the first key every trial",
	preconditions: "The preconditions were ticked before the first frame and held for the run",
} as const;

const plannedKind = (step: U7Step) => (step.kind === "user" ? "attest" : "mark");
const shownAs = (marker: Marker | undefined) => (marker === undefined ? "nothing" : `${marker.kind} ${marker.step}`);
const check = (title: string, problems: readonly string[], ok: string): U7Check => ({ title, pass: problems.length === 0, detail: problems.length === 0 ? ok : problems.join("; ") });

/** The link gate, from the probes the flash step sent on the erase's own link before the first ERASE. */
function gateProblems(frames: readonly Frame[]): { readonly problems: readonly string[]; readonly ok: string } {
	const first = frames.findIndex((frame) => frame.head.startsWith("1d00"));
	if (first === -1) return { problems: ["no ERASE was sent"], ok: "" };
	const erase = frames[first]!;
	let from = first;
	while (from > 0 && !frames[from]!.newLink) from--;
	const probes = frames.slice(from, first).filter((frame) => frame.head.startsWith("1202"));
	const answered = probes.flatMap((frame) => (frame.reply !== null && frame.reply.hex.startsWith("12020000") && frame.reply.hex.slice(8, 10) === "00" ? [frame.reply.t] : []));
	const silent = probes.length - answered.length;
	const newest = answered.at(-1);
	if (newest === undefined) return { problems: ["no answered probe on the erase's link"], ok: "" };
	let start = answered.length - 1;
	let widest = 0;
	while (start > 0 && answered[start]! - answered[start - 1]! <= GATE_MAX_GAP_MS) {
		widest = Math.max(widest, answered[start]! - answered[start - 1]!);
		start--;
	}
	const quiet = erase.t - answered[start]!;
	const problems = [
		...(silent > 0 ? [`${silent} probes went unanswered on the erase's link`] : []),
		...(erase.t - newest > GATE_MAX_GAP_MS ? [`the last probe answered ${((erase.t - newest) / 1000).toFixed(2)} s before the erase`] : []),
		...(quiet < GATE_QUIET_MS ? [`the probes answered for ${(quiet / 1000).toFixed(2)} s without a gap over 1 s, not 15 s`] : []),
	];
	return { problems, ok: `${answered.length - start} probes answered over ${(quiet / 1000).toFixed(2)} s, widest gap ${(widest / 1000).toFixed(2)} s, last ${((erase.t - newest) / 1000).toFixed(2)} s before the erase` };
}

function eraseProblems(frames: readonly Frame[]): readonly string[] {
	const erases = frames.filter((frame) => frame.head.startsWith("1d00"));
	const ranges = erases.map((frame): readonly [number, number] => [u32At(frame.hex!, 4), u32At(frame.hex!, 8)]);
	const problems: string[] = [];
	if (ranges.some(([offset, length]) => offset === WHOLE_WINDOW[0] && length === WHOLE_WINDOW[1])) {
		problems.push(`the fallback ran: the IAP did not take the app-region erase, so the vendor's window erase ${range(WHOLE_WINDOW)} went out`);
	}
	const planned = [VERSION_PAGE, APP_REGION];
	const asPlanned = ranges.length === planned.length && ranges.every(([offset, length], i) => offset === planned[i]![0] && length === planned[i]![1]);
	if (!asPlanned) problems.push(`the ERASEs were ${ranges.map(range).join(", ") || "none"}, planned ${planned.map(range).join(", ")}`);
	erases.forEach((frame, i) => {
		if (frame.reply === null) problems.push(`ERASE ${range(ranges[i]!)} got no answer before the next frame`);
		else if (frame.reply.hex.slice(0, 4) !== "1d00") problems.push(`ERASE ${range(ranges[i]!)} was answered ${frame.reply.hex.slice(0, 16)}`);
	});
	return problems;
}

function cursorProblems(frames: readonly Frame[]): { readonly problems: readonly string[]; readonly sets: number } {
	const problems: string[] = [];
	let sets = 0;
	frames.forEach((frame, i) => {
		if (!frame.head.startsWith("1e01")) return;
		sets++;
		const set = u32At(frame.hex!, 4);
		const next = frames[i + 1];
		if (next?.hex == null || !next.head.startsWith("1e00") || u32At(next.hex, 4) !== CURSOR_QUERY) {
			problems.push(`set ${hex32(set)} was followed by ${next === undefined ? "nothing" : next.head}, not a get write address`);
		} else if (next.reply === null || !next.reply.hex.startsWith("1e00") || u32At(next.reply.hex, 4) !== set) {
			problems.push(`set ${hex32(set)} read back ${next.reply === null ? "no answer" : next.reply.hex.slice(0, 16)}`);
		}
	});
	return { problems, sets };
}

/**
 * Follows the board's cursor through the frames: a set the board echoed moves it, an acked WRITE advances it, and
 * anything else forgets it. Each WRITE's payload hash must be the expected chunk's at the cursor it went to.
 */
function writeProblems(frames: readonly Frame[], expected: U7Expected): { readonly problems: readonly string[]; readonly ok: string } {
	const problems: string[] = [];
	const written = new Set<number>();
	let cursor: number | null = null;
	let sent = 0;
	for (const frame of frames) {
		if (frame.newLink) cursor = null;
		if (frame.head.startsWith("1e01")) {
			cursor = frame.reply?.hex.startsWith("1e01") ? u32At(frame.hex!, 4) : null;
			continue;
		}
		if (frame.write === null) continue;
		sent++;
		const at = cursor;
		const want = at === null ? undefined : expected.chunks.get(at);
		if (at === null) problems.push(`a WRITE ${frame.head} went out with no known cursor`);
		else if (want === undefined || want.bytes !== frame.write.bytes || want.sha256 !== frame.write.sha256) problems.push(`the WRITE at ${hex32(at)} does not match the chunk planned there`);
		const acked = at !== null && frame.reply?.hex.startsWith("1e02") === true && u32At(frame.reply.hex, 4) === at + frame.write.bytes;
		if (acked && want !== undefined && want.sha256 === frame.write.sha256) written.add(at);
		cursor = acked ? at + frame.write.bytes : null;
	}
	const missing = [...expected.chunks.keys()].filter((at) => !written.has(at));
	if (missing.length > 0) problems.push(`${missing.length} of ${expected.chunks.size} chunks never acked, the first at ${hex32(missing[0]!)}`);
	return { problems: problems.slice(0, 5).concat(problems.length > 5 ? [`and ${problems.length - 5} more`] : []), ok: `${written.size} of ${expected.chunks.size} chunks match and were acked, ${sent - written.size} resent` };
}

function deepProblems(marker: Marker, entry: CatalogEntry): readonly string[] {
	const problems: string[] = [];
	const sums = marker.frames.filter((frame) => frame.head.startsWith("1d01"));
	if (sums.length === 0) problems.push("no SUM was read");
	for (const frame of sums) {
		const asked: [number, number] = [u32At(frame.hex!, 4), u32At(frame.hex!, 8)];
		const got = frame.reply?.hex.startsWith("1d01") ? u32At(frame.reply.hex, 4) : null;
		if (asked[0] !== IMAGE_OFFSET || asked[1] !== entry.image.bytes) problems.push(`SUM over ${range(asked)}, not the image`);
		if (got !== entry.image.wireSum32 >>> 0) problems.push(`SUM read ${got === null ? "no answer" : hex32(got)}, wanted ${hex32(entry.image.wireSum32)}`);
	}
	const parts = marker.frames.filter((frame) => /^122[0-2]/.test(frame.head));
	const pages: string[] = [];
	for (let i = 0; i + 3 <= parts.length; i += 3) {
		const triple = parts.slice(i, i + 3);
		if (triple.some((frame, part) => !frame.head.startsWith(`122${part}`) || frame.reply?.hex.slice(0, 4) !== `122${part}`)) {
			problems.push(`a version page read out of order or unanswered: ${triple.map((frame) => frame.head.slice(0, 4)).join(" ")}`);
			continue;
		}
		pages.push(sha256Hex(fromHex(triple.map((frame) => frame.reply!.hex.slice(8)).join(""))));
	}
	if (pages.length === 0 || parts.length % 3 !== 0) problems.push(`${parts.length} version page reads, not whole pages`);
	for (const page of pages) if (page !== entry.versionBlock.sha256) problems.push(`a version page hashes to ${page.slice(0, 16)}…, wanted ${entry.versionBlock.sha256.slice(0, 16)}…`);
	return problems;
}

function keylogProblems(at: (id: string) => Marker | string): { readonly problems: readonly string[]; readonly ok: string } {
	const problems: string[] = [];
	const bluetooth = at("bluetooth");
	if (typeof bluetooth === "string") problems.push(bluetooth);
	else if (!bluetooth.answer) problems.push("the user did not confirm battery and Bluetooth");
	let missing = 0;
	let chars = 0;
	for (const step of U7_STEPS.filter((s) => s.kind === "trial")) {
		const marker = at(step.id);
		if (typeof marker === "string") {
			problems.push(marker);
			continue;
		}
		let summary: ReturnType<typeof summarizeTrial>;
		try {
			summary = summarizeTrial(parseKeylogTrial(marker.text));
		} catch (error) {
			problems.push(`${step.id}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		missing += summary.missing;
		chars += PHRASE.length;
		if (summary.repeats > 0) problems.push(`${step.id}: ${summary.repeats} autorepeats`);
		if (summary.lostUps > 0) problems.push(`${step.id}: ${summary.lostUps} lost key-ups`);
		if (!summary.firstKeyDelivered) problems.push(`${step.id}: the first key did not arrive first`);
	}
	if (chars !== TRIALS * PHRASE.length) problems.push(`${chars / PHRASE.length} trials, planned ${TRIALS}`);
	if (missing > MAX_MISSING) problems.push(`${missing} of ${chars} characters missing, at most ${MAX_MISSING}`);
	return { problems, ok: `${TRIALS} trials, ${missing} of ${chars} characters missing` };
}

export function evaluateU7(transcript: Transcript, expected: U7Expected): readonly U7Check[] {
	const { entries } = transcript;
	const { found, early, frames } = walk(entries);
	const placed = U7_STEPS.map((step, i) => {
		const got = found[i];
		return got !== undefined && got.kind === plannedKind(step) && got.step === step.id && (step.kind === "user" || step.kind === "trial" || got.text === "begin");
	});
	const order = U7_STEPS.flatMap((step, i) => (placed[i] ? [] : [`step ${i + 1} (${step.id}): planned ${plannedKind(step)} ${step.id}, got ${shownAs(found[i])}`]));
	if (found.length > U7_STEPS.length) order.push(`${found.length - U7_STEPS.length} more after the plan, the first ${shownAs(found[U7_STEPS.length])}`);
	const at = (id: string): Marker | string => {
		const i = U7_STEPS.findIndex((step) => step.id === id);
		return placed[i] ? found[i]! : `${id}: not where the plan puts it`;
	};
	const misplaced = [
		...early.map((frame) => `frame ${frame.head} before the first step`),
		...U7_STEPS.flatMap((step, i) => {
			const marker = placed[i] ? found[i]! : null;
			if (marker === null) return [];
			const allowed = step.kind === "flash" || step.kind === "deep-check" ? step.pairs : [];
			return marker.frames.flatMap((frame) => (allowed.includes(frame.head.slice(0, 4)) ? [] : [`frame ${frame.head} in ${step.kind} step ${step.id}`]));
		}),
	];
	const flash = at("flash");
	const flashFrames = typeof flash === "string" ? [] : flash.frames;
	const gate = typeof flash === "string" ? { problems: [flash], ok: "" } : gateProblems(flashFrames);
	const cursor = cursorProblems(flashFrames);
	const writes = typeof flash === "string" ? { problems: [flash], ok: "" } : writeProblems(flashFrames, expected);
	const deep = at("deep-check");
	const keylog = keylogProblems(at);
	const sent = frames.length;
	return [
		check(TITLES.frames, [...framesOutsideU7(entries).map((head) => `frame outside the U7 rows: ${head}`), ...misplaced], `${sent} frames, all U7 rows, each in a step that sends it`),
		check(TITLES.order, order, `${U7_STEPS.length} steps in plan order`),
		check(TITLES.gate, gate.problems, gate.ok),
		check(TITLES.erase, typeof flash === "string" ? [flash] : eraseProblems(flashFrames), `${range(VERSION_PAGE)} then ${range(APP_REGION)}, each answered`),
		check(TITLES.cursor, typeof flash === "string" ? [flash] : cursor.problems, `${cursor.sets} sets, each read back`),
		check(TITLES.writes, writes.problems, writes.ok),
		check(TITLES.deep, typeof deep === "string" ? [deep] : deepProblems(deep, expected.entry), `SUM ${hex32(expected.entry.image.wireSum32)} and version page ${expected.entry.versionBlock.sha256.slice(0, 8)}…${expected.entry.versionBlock.sha256.slice(-4)}`),
		check(TITLES.keylog, keylog.problems, keylog.ok),
		check(TITLES.preconditions, u7Preconditions.unmetPreconditions(transcript).map((label) => `not met: ${label}`), "all ticked before the first frame, none changed"),
	];
}

const USAGE = "usage: bun tools/u7-verdict.ts <transcript.json> --exe <Tab60firmwareV1.01.13.exe> [--out fixtures/u7-macos.json]";
/** The image U7 flashes over itself: V1.01.13, US layout, the one CATALOG entry. */
const V1_01_13 = "tab60-v1.01.13-us";

function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): { readonly transcriptFile: string; readonly exe: string; readonly out: string | null } | string {
	let transcriptFile: string | null = null;
	let exe: string | null = env.TAB60_EXE ?? null;
	let out: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--out") out = argv[++i] ?? "";
		else if (arg === "--exe") exe = argv[++i] ?? "";
		else if (arg.startsWith("-")) return `unknown option ${arg}`;
		else if (transcriptFile === null) transcriptFile = arg;
		else return `unexpected argument ${arg}`;
	}
	if (transcriptFile === null) return "no transcript file";
	if (exe === null || exe === "") return "no exe: pass --exe or set TAB60_EXE";
	if (out === "") return "--out needs a path";
	return { transcriptFile, exe, out };
}

/** The V1.01.13 image the user's exe holds, admitted against CATALOG, or why not. */
export async function catalogImage(exe: Uint8Array): Promise<FlashableImage | string> {
	const reading = await readUpdater(exe);
	if (reading.kind === "refused") return `the exe was refused: ${reading.refusal.code}`;
	for (const candidate of reading.images) {
		if (candidate.admission.kind === "admitted" && candidate.admission.image.entry.id === V1_01_13 && CATALOG.includes(candidate.admission.image.entry)) return candidate.admission.image;
	}
	return `the exe holds no admitted ${V1_01_13} image`;
}

export async function verdictMain(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
	const args = parseArgs(argv, env);
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
	let image: FlashableImage | string;
	try {
		image = await catalogImage(new Uint8Array(readFileSync(args.exe)));
	} catch (error) {
		image = error instanceof Error ? error.message : String(error);
	}
	if (typeof image === "string") {
		console.error(`${args.exe}: ${image}. Wrote nothing.`);
		return 2;
	}
	const checks = evaluateU7(transcript, expectedFor(image));
	for (const [key, value] of Object.entries(transcript.environment)) console.log(`environment ${key}: ${value}`);
	for (const { title, pass, detail } of checks) console.log(`${pass ? "PASS" : "FAIL"} ${title}\n     ${detail}`);
	if (!checks.every(({ pass }) => pass)) {
		console.log(args.out === null ? "FAIL" : `FAIL, so wrote nothing to ${args.out}`);
		return 1;
	}
	if (args.out !== null) {
		const fixture: U7Fixture = { format: "tab60kit-u7-verdict/1", evaluatedAt: new Date().toISOString(), transcriptFile: args.transcriptFile, environment: transcript.environment, checks, transcript };
		mkdirSync(dirname(args.out), { recursive: true });
		writeFileSync(args.out, `${JSON.stringify(fixture, null, "\t")}\n`);
		console.log(`wrote ${args.out}`);
	}
	return 0;
}

if (import.meta.main) process.exit(await verdictMain(process.argv.slice(2)));

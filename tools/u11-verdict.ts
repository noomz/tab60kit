/**
 * Unit U11's verdict on a saved lab/u11 transcript. It walks the transcript's own frames and attestations against
 * U11_STEPS, byte for byte: every request, the reply each one got, and each keylog the user attested. The page's
 * results are never read. Only a full PASS writes the capture that moves the four U11 rows to "confirmed".
 *
 * Run: bun tools/u11-verdict.ts <transcript.json> [--out fixtures/u11-macos.json]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ATTACH_PAIRS, U11_STEPS, type U11Step, type UserStep, type WireStep, framesOutsideU11, u11Preconditions } from "../lab/u11-run";
import { type Environment, type Transcript, type TranscriptEntry, parseTranscript } from "../testing/transcript";
import { notRealBoardCleanBuild } from "./u1-verdict";

export interface U11Check {
	readonly title: string;
	readonly pass: boolean;
	readonly detail: string;
}

export interface U11Fixture {
	readonly format: "tab60kit-u11-verdict/1";
	readonly evaluatedAt: string;
	readonly transcriptFile: string;
	readonly environment: Environment;
	readonly checks: readonly U11Check[];
	readonly transcript: Transcript;
}

const REPORT_HEX_CHARS = 128;
const ERROR_MARKER = "ffaa";
const report = (head: string) => head.padEnd(REPORT_HEX_CHARS, "0");

interface Frame {
	readonly kind: "frame";
	readonly out: string;
	reply: string | null;
}

interface Attest {
	readonly kind: "attest";
	readonly step: string;
	readonly answer: boolean;
	readonly keys: readonly string[];
}

/** A frame with the first reply after it, or an attestation. */
type Event = Frame | Attest;

/**
 * Every frame and attestation, in transcript order. A frame's reply is the first report before the next frame whose
 * byte 0 repeats the frame's, or the error marker.
 */
function events(entries: readonly TranscriptEntry[]): readonly Event[] {
	const found: Event[] = [];
	let last: Frame | null = null;
	for (const entry of entries) {
		if (entry.kind === "out") {
			last = { kind: "frame", out: entry.hex, reply: null };
			found.push(last);
		} else if (entry.kind === "in" && last !== null && last.reply === null && (entry.hex.slice(0, 2) === last.out.slice(0, 2) || entry.hex.startsWith(ERROR_MARKER))) {
			last.reply = entry.hex;
		} else if (entry.kind === "attest") {
			found.push({ kind: "attest", step: entry.step, answer: entry.answer, keys: entry.keys });
		}
	}
	return found;
}

const isAttach = (event: Event) => event.kind === "frame" && ATTACH_PAIRS.includes(event.out.slice(0, 4));
const shownAs = (event: Event | undefined) => (event === undefined ? "nothing" : event.kind === "frame" ? `frame ${event.out.slice(0, 12)}` : `attest ${event.step}`);
const plannedAs = (step: U11Step) => (step.kind === "wire" ? `frame ${report(step.request).slice(0, 12)}` : `attest ${step.id}`);
const matches = (step: U11Step, event: Event | undefined) =>
	event !== undefined && (step.kind === "wire" ? event.kind === "frame" && event.out === report(step.request) : event.kind === "attest" && event.step === step.id);

const check = (title: string, problems: readonly string[], ok: string): U11Check => ({ title, pass: problems.length === 0, detail: problems.length === 0 ? ok : problems.join("; ") });

export function evaluateU11(transcript: Transcript): readonly U11Check[] {
	const { entries } = transcript;
	const all = events(entries);
	const planned = all.filter((event) => !isAttach(event));

	const order = U11_STEPS.flatMap((step, i) => (matches(step, planned[i]) ? [] : [`step ${i + 1} (${step.id}): planned ${plannedAs(step)}, got ${shownAs(planned[i])}`]));
	if (planned.length > U11_STEPS.length) order.push(`${planned.length - U11_STEPS.length} more after the plan, the first ${shownAs(planned[U11_STEPS.length])}`);
	const inOrder = order.length === 0;
	const outOfOrder = ["the transcript does not follow the plan"];

	const at = (id: string) => planned[U11_STEPS.findIndex((step) => step.id === id)]!;
	const wire = (id: string) => U11_STEPS.find((step): step is WireStep => step.kind === "wire" && step.id === id)!;
	const user = (id: string) => U11_STEPS.find((step): step is UserStep => step.kind === "user" && step.id === id)!;
	const replies = (ids: readonly string[]) => {
		if (!inOrder) return outOfOrder;
		return ids.flatMap((id) => {
			const { reply } = at(id) as Frame;
			const want = report(wire(id).reply);
			return reply === want ? [] : [`${id}: wanted ${want.slice(0, 12)}, got ${reply === null ? "no reply" : reply.slice(0, 16)}`];
		});
	};
	const attested = (ids: readonly string[]) => {
		if (!inOrder) return outOfOrder;
		return ids.flatMap((id) => {
			const { answer, keys } = at(id) as Attest;
			const { keylog } = user(id);
			return [
				...(answer ? [] : [`${id}: the user answered no`]),
				...(keylog !== null && !keys.includes(keylog.want) ? [`${id}: the keylog shows no ${keylog.want} (${keys.join(" ") || "nothing"})`] : []),
				...(keylog !== null && keys.includes(keylog.not) ? [`${id}: the keylog shows ${keylog.not}`] : []),
			];
		});
	};

	const gateFrames = all.filter((event): event is Frame => event.kind === "frame" && event.out.startsWith("41"));
	const lastGate = gateFrames.at(-1);
	const endsClosed =
		lastGate === undefined
			? ["no gate frame was sent"]
			: lastGate.out !== report("41ff0000")
				? [`the last gate frame is ${lastGate.out.slice(0, 8)}, not a query`]
				: lastGate.reply !== report("41000000")
					? [`the last gate query read ${lastGate.reply === null ? "no reply" : lastGate.reply.slice(0, 8)}`]
					: [];

	const unmet = u11Preconditions.unmetPreconditions(transcript);
	const frames = all.filter((event) => event.kind === "frame").length;
	return [
		check("Every frame sent is one of the seven U11 rows", framesOutsideU11(entries).map((hex) => `frame outside the U11 rows: ${hex}`), `${frames} frames, all U11 rows`),
		check("The frames past each attach and the attestations follow the plan, step by step", order, `${U11_STEPS.length} steps in plan order`),
		check("The gate reads closed at the start, and each open and close is echoed", replies(["query-start", "open", "close", "query-closed", "open-again"]), "closed at the start, 2 opens and 1 close echoed, closed after the close"),
		check("Caps Lock reads back 0x00E0 after each write and 0x00FF after the restore", replies(["write-control", "read-control", "restore", "read-default", "write-again", "read-again"]), "0x00E0, 0x00FF, 0x00E0, each in the write's reply and in the read"),
		check("Over USB and over Bluetooth the keylog shows ControlLeft and no CapsLock, and the user said yes", attested(["keylog-usb", "keylog-bluetooth"]), "ControlLeft over both links"),
		check(
			"After a power cycle with no save the gate reads 0, Caps Lock reads 0x00FF, and the keylog shows CapsLock",
			[...attested(["power-cycle"]), ...replies(["query-after-power", "read-after-power"]), ...attested(["keylog-after-power"])].filter((line, i, list) => list.indexOf(line) === i),
			"the saved store came back",
		),
		check("The run ends with the gate closed: the last gate frame is a query that reads 0", endsClosed, "the last gate query reads 41 00 00 00"),
		check("The preconditions were ticked before the first frame and held for the run", unmet.map((label) => `not met: ${label}`), "all ticked before the first frame, none changed"),
	];
}

interface Args {
	readonly transcriptFile: string;
	readonly out: string | null;
}

const USAGE = "usage: bun tools/u11-verdict.ts <transcript.json> [--out fixtures/u11-macos.json]";

function parseArgs(argv: readonly string[]): Args | string {
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
	const checks = evaluateU11(transcript);
	for (const [key, value] of Object.entries(transcript.environment)) console.log(`environment ${key}: ${value}`);
	for (const { title, pass, detail } of checks) console.log(`${pass ? "PASS" : "FAIL"} ${title}\n     ${detail}`);
	if (!checks.every(({ pass }) => pass)) {
		console.log(args.out === null ? "FAIL" : `FAIL, so wrote nothing to ${args.out}`);
		return 1;
	}
	if (args.out !== null) {
		const fixture: U11Fixture = {
			format: "tab60kit-u11-verdict/1",
			evaluatedAt: new Date().toISOString(),
			transcriptFile: args.transcriptFile,
			environment: transcript.environment,
			checks,
			transcript,
		};
		mkdirSync(dirname(args.out), { recursive: true });
		writeFileSync(args.out, `${JSON.stringify(fixture, null, "\t")}\n`);
		console.log(`wrote ${args.out}`);
	}
	return 0;
}

if (import.meta.main) process.exit(verdictMain(process.argv.slice(2)));

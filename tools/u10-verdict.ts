/**
 * Plan U10's verdict on a saved lab/u10 transcript. It decodes every cfgReadKeys and cfgReadKey reply from the
 * transcript's own frames, with its own byte rules, and compares each entry with `predictLayers` for the board's OS key
 * mode; the page's results are never read. A difference passes only when the approved list names it (layer, usage,
 * and the entry read), and an approval that matches nothing fails, so the list cannot go stale. Only a full PASS
 * writes the capture that moves both reads to "confirmed".
 *
 * Run: bun tools/u10-verdict.ts <transcript.json> --os-mode mac --expect fixtures/u10-expected-diffs.json [--out fixtures/u10-macos.json]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Layer, OS_KEY_MODES, type OsKeyMode, predictLayers, presentUsages } from "../core/keymap";
import type { OverrideEntry } from "../core/protocol";
import { describeEntry, framesOutsideU10, u10Preconditions } from "../lab/u10-run";
import { type Environment, type Transcript, type TranscriptEntry, parseTranscript } from "../testing/transcript";
import { notRealBoardCleanBuild } from "./u1-verdict";

export interface U10Check {
	readonly title: string;
	readonly pass: boolean;
	readonly detail: string;
}

export interface U10Fixture {
	readonly format: "tab60kit-u10-verdict/1";
	readonly evaluatedAt: string;
	readonly transcriptFile: string;
	readonly environment: Environment;
	readonly osKeyMode: OsKeyMode;
	readonly approvedDifferences: readonly ApprovedDifference[];
	readonly checks: readonly U10Check[];
	readonly transcript: Transcript;
}

/** A difference from the prediction the user accepted, with why. `read` is the entry as the verdict prints it. */
export interface ApprovedDifference {
	readonly layer: Layer;
	readonly usage: number;
	readonly read: string;
	readonly reason: string;
}

const APPROVAL_FIELDS = ["layer", "usage", "read", "reason"];
const ENTRY_TEXT = /^(absent|default|override 0x[0-9a-f]{2} flags [0-3])$/;
const USAGE_TEXT = /^0x[0-9a-f]{2}$/;

/** Boundary parse of the --expect file: an array of approvals, every field required, no extras, no repeated (layer, usage). */
export function parseApprovedDifferences(json: unknown): readonly ApprovedDifference[] | { readonly error: string } {
	if (!Array.isArray(json)) return { error: "$ is not an array" };
	const approved: ApprovedDifference[] = [];
	for (const [i, item] of json.entries()) {
		const at = `$[${i}]`;
		if (typeof item !== "object" || item === null || Array.isArray(item)) return { error: `${at} is not an object` };
		const fields = item as Record<string, unknown>;
		const extra = Object.keys(fields).find((key) => !APPROVAL_FIELDS.includes(key));
		if (extra !== undefined) return { error: `${at}.${extra} is not an approval field` };
		const { layer, usage, read, reason } = fields;
		if (layer !== 0 && layer !== 1 && layer !== 2) return { error: `${at}.layer is ${JSON.stringify(layer)}, not 0, 1, or 2` };
		if (typeof usage !== "string" || !USAGE_TEXT.test(usage)) return { error: `${at}.usage is ${JSON.stringify(usage)}, not a string like "0x29"` };
		if (typeof read !== "string" || !ENTRY_TEXT.test(read)) return { error: `${at}.read is ${JSON.stringify(read)}, not "absent", "default", or "override 0xNN flags F"` };
		if (typeof reason !== "string" || reason.trim() === "") return { error: `${at}.reason is missing or empty` };
		const k = Number.parseInt(usage, 16);
		if (approved.some((other) => other.layer === layer && other.usage === k)) return { error: `${at} repeats layer ${layer} usage ${usage}` };
		approved.push({ layer, usage: k, read, reason });
	}
	return approved;
}

/** --os-mode: a mode name, or the byte 0x2000102B holds (16, 32, 64, or 0x10, 0x20, 0x40). */
export function parseOsKeyMode(text: string): OsKeyMode | null {
	const modes = Object.keys(OS_KEY_MODES) as OsKeyMode[];
	const named = modes.find((mode) => mode === text);
	if (named !== undefined) return named;
	const byte = /^(0x[0-9a-f]+|[0-9]+)$/i.test(text) ? Number(text) : Number.NaN;
	return modes.find((mode) => OS_KEY_MODES[mode].byte === byte) ?? null;
}

const READ_KEYS = "5221";
const READ_KEY = "5220";
const ENTRIES_PER_FRAME = 16;

const byteAt = (hex: string, at: number) => Number.parseInt(hex.slice(2 * at, 2 * at + 2), 16);
/** Bytes 2..3 of a request, little-endian: frame index for cfgReadKeys, layer << 8 | usage for cfgReadKey. */
const argOf = (out: string) => byteAt(out, 2) | (byteAt(out, 3) << 8);
const wordAt = (reply: string, i: number) => byteAt(reply, 4 + 2 * i) | (byteAt(reply, 5 + 2 * i) << 8);
const hex2 = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;

/** The rules of docs/app-firmware.md: 0x0003 absent, 0x00FF default, else flags << 8 | code. */
function decode(word: number): OverrideEntry | string {
	if (word === 0x0003) return { kind: "absent" };
	if (word === 0x00ff) return { kind: "default" };
	const flags = word >> 8;
	const code = word & 0xff;
	if (flags > 3 || code === 0xff) return `word 0x${word.toString(16).padStart(4, "0")}`;
	return { kind: "override", code, flags: flags as 0 | 1 | 2 | 3 };
}

interface Exchange {
	readonly out: string;
	/** The first report after `out`, before the next frame, that repeats its bytes 0..3. */
	readonly reply: string | null;
}

function exchanges(entries: readonly TranscriptEntry[], cmdSub: string): readonly Exchange[] {
	const found: { out: string; reply: string | null }[] = [];
	let last: { out: string; reply: string | null } | null = null;
	for (const entry of entries) {
		if (entry.kind === "out") {
			last = { out: entry.hex, reply: null };
			if (entry.hex.startsWith(cmdSub)) found.push(last);
		} else if (entry.kind === "in" && last !== null && last.reply === null && entry.hex.slice(0, 8) === last.out.slice(0, 8)) {
			last.reply = entry.hex;
		}
	}
	return found;
}

interface Difference {
	readonly layer: number;
	readonly usage: number;
	readonly read: string;
	readonly line: string;
}

function compare(predictions: ReturnType<typeof predictLayers>, layer: number, usage: number, read: OverrideEntry | string): Difference | null {
	const predicted = predictions.get(layer as Layer)?.get(usage);
	const got = typeof read === "string" ? read : describeEntry(read);
	return got === describeEntry(predicted) ? null : { layer, usage, read: got, line: `layer ${layer} usage ${hex2(usage)}: predicted ${describeEntry(predicted)}, read ${got}` };
}

const approves = (approval: ApprovedDifference, diff: Difference) => approval.layer === diff.layer && approval.usage === diff.usage && approval.read === diff.read;
const describeApproval = ({ layer, usage, read }: ApprovedDifference) => `layer ${layer} usage ${hex2(usage)} read ${read}`;

const check = (title: string, problems: readonly string[], ok: string): U10Check => ({ title, pass: problems.length === 0, detail: problems.length === 0 ? ok : problems.join("; ") });

export function evaluateU10(transcript: Transcript, mode: OsKeyMode, approved: readonly ApprovedDifference[]): readonly U10Check[] {
	const { entries } = transcript;
	const predictions = predictLayers(mode);
	const layer0 = exchanges(entries, READ_KEYS);
	const single = exchanges(entries, READ_KEY);

	const args = layer0.map(({ out }) => argOf(out));
	const layer0Shape = [
		...(args.join() === Array.from({ length: 16 }, (_, a) => a).join() ? [] : [`arguments ${args.join(", ") || "none"}, not 0 to 15 once each in order`]),
		...layer0.filter(({ reply }) => reply === null).map(({ out }) => `no reply echoes ${out.slice(0, 8)}`),
	];

	const layer0Diffs: Difference[] = [];
	let decoded = 0;
	for (const { out, reply } of layer0) {
		if (reply === null) continue;
		for (let i = 0; i < ENTRIES_PER_FRAME; i++) {
			decoded++;
			const diff = compare(predictions, 0, argOf(out) * ENTRIES_PER_FRAME + i, decode(wordAt(reply, i)));
			if (diff !== null) layer0Diffs.push(diff);
		}
	}

	const coverage: string[] = [];
	for (const layer of [1, 2]) {
		const read = new Set(single.filter(({ out, reply }) => reply !== null && argOf(out) >> 8 === layer).map(({ out }) => argOf(out) & 0xff));
		const missing = presentUsages(mode).filter((k) => !read.has(k));
		if (missing.length > 0) coverage.push(`layer ${layer} has no answered read of ${missing.map(hex2).join(", ")}`);
	}
	const singleShape = [...coverage, ...single.filter(({ reply }) => reply === null).map(({ out }) => `no reply echoes ${out.slice(0, 8)}`)];
	const singleDiffs = single.flatMap(({ out, reply }) => {
		if (reply === null) return [];
		const diff = compare(predictions, argOf(out) >> 8, argOf(out) & 0xff, decode(wordAt(reply, 0)));
		return diff === null ? [] : [diff];
	});
	const unapproved = (diffs: readonly Difference[]) => diffs.filter((diff) => !approved.some((approval) => approves(approval, diff))).map(({ line }) => line);
	const asPredicted = (count: string, diffs: readonly Difference[]) => {
		const accepted = approved.filter((approval) => diffs.some((diff) => approves(approval, diff)));
		return `${count} as predicted${accepted.length === 0 ? "" : `, except the approved ${accepted.map(describeApproval).join("; ")}`}`;
	};
	const stale = approved.filter((approval) => ![...layer0Diffs, ...singleDiffs].some((diff) => approves(approval, diff)));

	const unmet = u10Preconditions.unmetPreconditions(transcript);
	return [
		check("Every frame sent is one of the four U10 rows", framesOutsideU10(entries).map((hex) => `frame outside the U10 rows: ${hex}`), `${entries.filter((entry) => entry.kind === "out").length} frames, all U10 rows`),
		check("Layer 0 is 16 cfgReadKeys frames with arguments 0 to 15, each answered with bytes 0..3 echoed", layer0Shape, "16 frames, arguments 0 to 15, all echoed"),
		check(`Every layer 0 entry equals the prediction for OS key mode ${mode}, or an approved difference`, [...unapproved(layer0Diffs), ...(decoded === 256 ? [] : [`decoded ${decoded} entries, not 256`])], asPredicted("256 entries", layer0Diffs)),
		check("cfgReadKey reads every present usage on layers 1 and 2, each answered with bytes 0..3 echoed", singleShape, `${single.length} frames cover ${presentUsages(mode).length} usages on both layers, all echoed`),
		check(`Every layer 1 and 2 entry equals the prediction for OS key mode ${mode}, or an approved difference`, unapproved(singleDiffs), asPredicted(`${single.length} entries`, singleDiffs)),
		check("Every approved difference occurs in the read", stale.map((approval) => `approved but not read: ${describeApproval(approval)}`), `${approved.length} approved, all read`),
		check("The preconditions were ticked before the first frame and held for the run", unmet.map((label) => `not met: ${label}`), "all ticked before the first frame, none changed"),
	];
}

interface Args {
	readonly transcriptFile: string;
	readonly mode: OsKeyMode;
	readonly expectFile: string;
	readonly out: string | null;
}

const USAGE = "usage: bun tools/u10-verdict.ts <transcript.json> --os-mode windows|mac|caps-ctrl|0x10|0x20|0x40 --expect <approved.json> [--out fixtures/u10-macos.json]";

function parseArgs(argv: readonly string[]): Args | string {
	let transcriptFile: string | null = null;
	let out: string | null = null;
	let modeText: string | null = null;
	let expectFile: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--out") out = argv[++i] ?? "";
		else if (arg === "--os-mode") modeText = argv[++i] ?? "";
		else if (arg === "--expect") expectFile = argv[++i] ?? "";
		else if (arg.startsWith("-")) return `unknown option ${arg}`;
		else if (transcriptFile === null) transcriptFile = arg;
		else return `unexpected argument ${arg}`;
	}
	if (transcriptFile === null) return "no transcript file";
	if (out === "") return "--out needs a path";
	if (modeText === null) return "--os-mode is required: the board's OS key mode decides the prediction";
	const mode = parseOsKeyMode(modeText);
	if (mode === null) return `--os-mode ${modeText || '""'} is not windows, mac, caps-ctrl, 0x10, 0x20, or 0x40`;
	if (expectFile === null || expectFile === "") return "--expect is required: a JSON list of approved differences, [] for none";
	return { transcriptFile, mode, expectFile, out };
}

export function verdictMain(argv: readonly string[]): number {
	const args = parseArgs(argv);
	if (typeof args === "string") {
		console.error(`${args}\n${USAGE}`);
		return 2;
	}
	let transcript: Transcript;
	let approved: readonly ApprovedDifference[] | { readonly error: string };
	try {
		transcript = parseTranscript(JSON.parse(readFileSync(args.transcriptFile, "utf8")));
	} catch (error) {
		console.error(`${args.transcriptFile}: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
	try {
		approved = parseApprovedDifferences(JSON.parse(readFileSync(args.expectFile, "utf8")));
	} catch (error) {
		approved = { error: error instanceof Error ? error.message : String(error) };
	}
	if ("error" in approved) {
		console.error(`${args.expectFile}: ${approved.error}. Wrote nothing.`);
		return 2;
	}
	const refusal = notRealBoardCleanBuild(transcript.environment);
	if (refusal !== null) {
		console.error(`${refusal}. Wrote nothing.`);
		return 2;
	}
	const recorded = transcript.environment.osKeyMode;
	if (recorded !== undefined && recorded !== args.mode) {
		console.error(`environment.osKeyMode is "${recorded}", but --os-mode says ${args.mode}. Wrote nothing.`);
		return 2;
	}
	const checks = evaluateU10(transcript, args.mode, approved);
	for (const [key, value] of Object.entries(transcript.environment)) console.log(`environment ${key}: ${value}`);
	console.log(`os key mode: ${args.mode} (0x${OS_KEY_MODES[args.mode].byte.toString(16)})${recorded === undefined ? ", from --os-mode; the transcript records none" : ""}`);
	for (const approval of approved) console.log(`approved: ${describeApproval(approval)}, because ${approval.reason}`);
	for (const { title, pass, detail } of checks) console.log(`${pass ? "PASS" : "FAIL"} ${title}\n     ${detail}`);
	const passed = checks.every(({ pass }) => pass);
	if (!passed) {
		console.log(args.out === null ? "FAIL" : `FAIL, so wrote nothing to ${args.out}`);
		return 1;
	}
	if (args.out !== null) {
		const fixture: U10Fixture = {
			format: "tab60kit-u10-verdict/1",
			evaluatedAt: new Date().toISOString(),
			transcriptFile: args.transcriptFile,
			environment: transcript.environment,
			osKeyMode: args.mode,
			approvedDifferences: approved,
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

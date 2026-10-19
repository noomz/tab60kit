/**
 * Plan U10's verdict on a saved lab/u10 transcript. It decodes every cfgReadKeys and cfgReadKey reply from the
 * transcript's own frames, with its own byte rules, and compares each entry with the clean-store prediction; the
 * page's results are never read. Only a full PASS writes the capture that moves both reads to "confirmed".
 *
 * Run: bun tools/u10-verdict.ts <transcript.json> [--out fixtures/u10-macos.json]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { activeKeymap, predictCleanLayer } from "../core/keymap";
import type { OverrideEntry } from "../core/protocol";
import { describeEntry, framesOutsideU10, presentUsages, u10Preconditions } from "../lab/u10-run";
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
	readonly checks: readonly U10Check[];
	readonly transcript: Transcript;
}

const READ_KEYS = "5221";
const READ_KEY = "5220";
const ENTRIES_PER_FRAME = 16;
const PREDICTED = predictCleanLayer(activeKeymap());

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

function compare(layer: number, usage: number, read: OverrideEntry | string): string | null {
	const predicted = PREDICTED.get(usage);
	const got = typeof read === "string" ? read : describeEntry(read);
	return got === describeEntry(predicted) ? null : `layer ${layer} usage ${hex2(usage)}: predicted ${describeEntry(predicted)}, read ${got}`;
}

const check = (title: string, problems: readonly string[], ok: string): U10Check => ({ title, pass: problems.length === 0, detail: problems.length === 0 ? ok : problems.join("; ") });

export function evaluateU10(transcript: Transcript): readonly U10Check[] {
	const { entries } = transcript;
	const layer0 = exchanges(entries, READ_KEYS);
	const single = exchanges(entries, READ_KEY);

	const args = layer0.map(({ out }) => argOf(out));
	const layer0Shape = [
		...(args.join() === Array.from({ length: 16 }, (_, a) => a).join() ? [] : [`arguments ${args.join(", ") || "none"}, not 0 to 15 once each in order`]),
		...layer0.filter(({ reply }) => reply === null).map(({ out }) => `no reply echoes ${out.slice(0, 8)}`),
	];

	const layer0Diffs: string[] = [];
	let decoded = 0;
	for (const { out, reply } of layer0) {
		if (reply === null) continue;
		for (let i = 0; i < ENTRIES_PER_FRAME; i++) {
			decoded++;
			const diff = compare(0, argOf(out) * ENTRIES_PER_FRAME + i, decode(wordAt(reply, i)));
			if (diff !== null) layer0Diffs.push(diff);
		}
	}
	if (decoded !== 256) layer0Diffs.push(`decoded ${decoded} entries, not 256`);

	const coverage: string[] = [];
	for (const layer of [1, 2]) {
		const read = new Set(single.filter(({ out, reply }) => reply !== null && argOf(out) >> 8 === layer).map(({ out }) => argOf(out) & 0xff));
		const missing = presentUsages().filter((k) => !read.has(k));
		if (missing.length > 0) coverage.push(`layer ${layer} has no answered read of ${missing.map(hex2).join(", ")}`);
	}
	const singleShape = [...coverage, ...single.filter(({ reply }) => reply === null).map(({ out }) => `no reply echoes ${out.slice(0, 8)}`)];
	const singleDiffs = single.flatMap(({ out, reply }) => {
		if (reply === null) return [];
		const diff = compare(argOf(out) >> 8, argOf(out) & 0xff, decode(wordAt(reply, 0)));
		return diff === null ? [] : [diff];
	});

	const unmet = u10Preconditions.unmetPreconditions(transcript);
	return [
		check("Every frame sent is one of the four U10 rows", framesOutsideU10(entries).map((hex) => `frame outside the U10 rows: ${hex}`), `${entries.filter((entry) => entry.kind === "out").length} frames, all U10 rows`),
		check("Layer 0 is 16 cfgReadKeys frames with arguments 0 to 15, each answered with bytes 0..3 echoed", layer0Shape, "16 frames, arguments 0 to 15, all echoed"),
		check("Every layer 0 entry equals the clean prediction", layer0Diffs, "256 entries as predicted"),
		check("cfgReadKey reads every present usage on layers 1 and 2, each answered with bytes 0..3 echoed", singleShape, `${single.length} frames cover ${presentUsages().length} usages on both layers, all echoed`),
		check("Every layer 1 and 2 entry equals the clean prediction", singleDiffs, `${single.length} entries as predicted`),
		check("The preconditions were ticked before the first frame and held for the run", unmet.map((label) => `not met: ${label}`), "all ticked before the first frame, none changed"),
	];
}

interface Args {
	readonly transcriptFile: string;
	readonly out: string | null;
}

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
		console.error(`${args}\nusage: bun tools/u10-verdict.ts <transcript.json> [--out fixtures/u10-macos.json]`);
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
	const checks = evaluateU10(transcript);
	for (const [key, value] of Object.entries(transcript.environment)) console.log(`environment ${key}: ${value}`);
	for (const { title, pass, detail } of checks) console.log(`${pass ? "PASS" : "FAIL"} ${title}\n     ${detail}`);
	const passed = checks.every(({ pass }) => pass);
	if (!passed) {
		console.log(args.out === null ? "FAIL" : `FAIL, so wrote nothing to ${args.out}`);
		return 1;
	}
	if (args.out !== null) {
		const fixture: U10Fixture = { format: "tab60kit-u10-verdict/1", evaluatedAt: new Date().toISOString(), transcriptFile: args.transcriptFile, environment: transcript.environment, checks, transcript };
		mkdirSync(dirname(args.out), { recursive: true });
		writeFileSync(args.out, `${JSON.stringify(fixture, null, "\t")}\n`);
		console.log(`wrote ${args.out}`);
	}
	return 0;
}

if (import.meta.main) process.exit(verdictMain(process.argv.slice(2)));

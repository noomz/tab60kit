/**
 * Plan unit U1's verdict: reads a transcript the lab page saved, evaluates checks 1 to 7 and 9 from it, takes
 * check 8's human half (the board types after the run) from the command line, and writes the fixture that records
 * each result with the transcript it came from. It lives in tools/ because tsconfig.browser.json typechecks lab/
 * with no Bun types; the evaluation itself is lab/u1-checks.ts.
 *
 * Run: bun tools/u1-verdict.ts <transcript.json> --types|--no-types [--out fixtures/u1-macos.json]
 * Exit 0 when every check passed, 1 otherwise, 2 for a usage error. The fixture is written either way.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type U1Verdict, evaluateU1 } from "../lab/u1-checks";
import { type Transcript, parseTranscript } from "../testing/transcript";

export interface U1Fixture extends U1Verdict {
	readonly format: "tab60kit-u1-verdict/1";
	readonly evaluatedAt: string;
	readonly transcriptFile: string;
	readonly boardTypes: boolean;
	readonly transcript: Transcript;
}

interface Args {
	readonly transcriptFile: string;
	readonly boardTypes: boolean;
	readonly out: string;
}

function parseArgs(argv: readonly string[]): Args | string {
	let transcriptFile: string | null = null;
	let boardTypes: boolean | null = null;
	let out = "fixtures/u1-macos.json";
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--types") boardTypes = true;
		else if (arg === "--no-types") boardTypes = false;
		else if (arg === "--out") out = argv[++i] ?? "";
		else if (arg.startsWith("-")) return `unknown option ${arg}`;
		else if (transcriptFile === null) transcriptFile = arg;
		else return `unexpected argument ${arg}`;
	}
	if (transcriptFile === null) return "no transcript file";
	if (boardTypes === null) return "say --types or --no-types: does the board type after the run?";
	if (out === "") return "--out needs a path";
	return { transcriptFile, boardTypes, out };
}

export async function verdictMain(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);
	if (typeof args === "string") {
		console.error(`${args}\nusage: bun tools/u1-verdict.ts <transcript.json> --types|--no-types [--out fixtures/u1-macos.json]`);
		return 2;
	}
	const transcript = parseTranscript(JSON.parse(readFileSync(args.transcriptFile, "utf8")));
	const verdict = await evaluateU1(transcript, { boardTypes: args.boardTypes });
	const fixture: U1Fixture = {
		format: "tab60kit-u1-verdict/1",
		evaluatedAt: new Date().toISOString(),
		transcriptFile: args.transcriptFile,
		boardTypes: args.boardTypes,
		...verdict,
		transcript,
	};
	mkdirSync(dirname(args.out), { recursive: true });
	writeFileSync(args.out, `${JSON.stringify(fixture, null, "\t")}\n`);
	for (const check of verdict.checks) console.log(`${check.pass ? "PASS" : "FAIL"} ${check.id}. ${check.title}\n     ${check.detail}`);
	for (const finding of verdict.findings) console.log(`FINDING ${finding}`);
	console.log(`commands sent: ${verdict.commands.join(" ")}`);
	console.log(`wrote ${args.out}`);
	return verdict.checks.every((check) => check.pass) ? 0 : 1;
}

if (import.meta.main) process.exit(await verdictMain(process.argv.slice(2)));

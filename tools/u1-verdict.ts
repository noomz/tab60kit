import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type TypingObservation, type U1Verdict, evaluateU1, passes } from "../lab/u1-checks";
import { U1_EXPECTED } from "../lab/u1-job";
import { type Environment, type Transcript, parseTranscript } from "../testing/transcript";

export interface U1Fixture extends U1Verdict {
	readonly format: "tab60kit-u1-verdict/1";
	readonly evaluatedAt: string;
	readonly transcriptFile: string;
	readonly typing: TypingObservation;
	readonly environment: Environment;
	readonly transcript: Transcript;
}

const CLEAN_COMMIT = /^[0-9a-f]{7,40}$/;

function notEvidence(environment: Environment): string | null {
	if (environment.fake !== "no") return `environment.fake is "${environment.fake}", and a fake board is not evidence`;
	const { tool } = environment;
	if (tool === undefined) return "environment.tool is missing, so nothing names the build that recorded it";
	if (!CLEAN_COMMIT.test(tool)) return `environment.tool is "${tool}", and only a build from a clean commit is evidence`;
	return null;
}

interface Args {
	readonly transcriptFile: string;
	readonly typing: TypingObservation;
	readonly out: string;
}

function parseArgs(argv: readonly string[]): Args | string {
	let transcriptFile: string | null = null;
	let typing: TypingObservation | null = null;
	let out = "fixtures/u1-macos.json";
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--types") typing = "types";
		else if (arg === "--no-types") typing = "does-not-type";
		else if (arg === "--out") out = argv[++i] ?? "";
		else if (arg.startsWith("-")) return `unknown option ${arg}`;
		else if (transcriptFile === null) transcriptFile = arg;
		else return `unexpected argument ${arg}`;
	}
	if (transcriptFile === null) return "no transcript file";
	if (typing === null) return "say --types or --no-types: does the board type after the run?";
	if (out === "") return "--out needs a path";
	return { transcriptFile, typing, out };
}

export async function verdictMain(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);
	if (typeof args === "string") {
		console.error(`${args}\nusage: bun tools/u1-verdict.ts <transcript.json> --types|--no-types [--out fixtures/u1-macos.json]`);
		return 2;
	}
	let transcript: Transcript;
	try {
		transcript = parseTranscript(JSON.parse(readFileSync(args.transcriptFile, "utf8")));
	} catch (error) {
		console.error(`${args.transcriptFile}: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
	const refusal = notEvidence(transcript.environment);
	if (refusal !== null) {
		console.error(`${refusal}. Wrote nothing.`);
		return 2;
	}
	const verdict = await evaluateU1(transcript, { expected: U1_EXPECTED, typing: args.typing });
	const fixture: U1Fixture = {
		format: "tab60kit-u1-verdict/1",
		evaluatedAt: new Date().toISOString(),
		transcriptFile: args.transcriptFile,
		typing: args.typing,
		environment: transcript.environment,
		...verdict,
		transcript,
	};
	mkdirSync(dirname(args.out), { recursive: true });
	writeFileSync(args.out, `${JSON.stringify(fixture, null, "\t")}\n`);
	for (const [key, value] of Object.entries(transcript.environment)) console.log(`environment ${key}: ${value}`);
	const { frames } = verdict;
	console.log(`${frames.pass ? "PASS" : "FAIL"} ${frames.title}\n     ${frames.detail}`);
	for (const check of verdict.checks) console.log(`${check.pass ? "PASS" : "FAIL"} ${check.id}. ${check.title}\n     ${check.detail}`);
	for (const finding of verdict.findings) console.log(`FINDING ${finding}`);
	console.log(`commands sent: ${verdict.commands.join(" ")}`);
	console.log(`wrote ${args.out}`);
	return passes(verdict) ? 0 : 1;
}

if (import.meta.main) process.exit(await verdictMain(process.argv.slice(2)));

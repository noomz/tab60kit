/**
 * Usage: bun tools/u6-verdict.ts <first.json> <second.json>
 * Prints unit U6's checks on two lab/u6 transcripts and exits 1 unless every one passes.
 */
import { readFileSync } from "node:fs";
import { evaluateU6 } from "../lab/u6-checks";
import { parseTranscript } from "../testing/transcript";

const [first, second] = process.argv.slice(2);
if (first === undefined || second === undefined) {
	console.error("usage: bun tools/u6-verdict.ts <first.json> <second.json>");
	process.exit(2);
}
const load = (file: string) => parseTranscript(JSON.parse(readFileSync(file, "utf8")));
const checks = await evaluateU6(load(first), load(second));
for (const check of checks) console.log(`${check.pass ? "PASS" : "FAIL"} ${check.title}. ${check.detail}`);
process.exit(checks.every((check) => check.pass) ? 0 : 1);

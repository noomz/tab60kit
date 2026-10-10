/**
 * Plan unit U1's verdict from a transcript. Its import closure reaches core/ only through device.ts, firmware.ts,
 * port.ts, and units.ts, never protocol.ts, so a codec bug in the core cannot vouch for itself here
 * (probes/boundaries.ts rule u1-checks-independence).
 */
import { sha256 } from "../core/firmware";
import type { Mode } from "../core/units";
import type { Transcript, TranscriptEntry } from "../testing/transcript";

export interface U1Expected {
	readonly appProductId: number;
	readonly iapProductId: number;
	readonly usagePage: number;
	readonly usage: number;
	readonly reportBytes: number;
	readonly identityHex: string;
	readonly fwOffset: number;
	readonly pageSize: number;
	readonly fwPages: number;
	readonly versionPageSha256: string;
	readonly imageBytes: number;
	readonly imageSum32: number;
	readonly probes: number;
	readonly maxProbeGapMs: number;
}

/** Plan check 8's human half: whether the board types after the run. */
export type TypingObservation = "types" | "does-not-type" | "not-observed";

export interface CheckResult {
	readonly id: number;
	readonly title: string;
	readonly pass: boolean;
	readonly detail: string;
}

export interface U1Verdict {
	readonly checks: readonly CheckResult[];
	readonly findings: readonly string[];
	readonly commands: readonly string[];
}

interface Exchange {
	readonly mode: Mode | null;
	readonly t: number;
	readonly cmd: number;
	readonly sub: number;
	readonly request: Uint8Array;
	readonly reply: Uint8Array | null;
	readonly replyT: number | null;
}

type Answered = Exchange & { readonly reply: Uint8Array; readonly replyT: number };
const answered = (exchange: Exchange): exchange is Answered => exchange.reply !== null && exchange.replyT !== null;

const READ_BL_INFO = [0x12, 0x00] as const;
const READ_FW_INFO = [0x12, 0x01] as const;
const READ_MODE = [0x12, 0x02] as const;
const READ_VERSION_PAGE_FIRST = 0x20;
const SUM = [0x1d, 0x01] as const;
const RESET_TO_IAP = [0x11, 0x00] as const;
const RESET_TO_APP = [0x11, 0x01] as const;
const ERROR_MARKER = [0xff, 0xaa] as const;
const PAYLOAD = 4;

export const U1_COMMANDS: readonly string[] = ["12/02", "12/00", "12/01", "12/20", "12/21", "12/22", "1d/01", "11/00", "11/01"];

const pair = (cmd: number, sub: number) => `${cmd.toString(16).padStart(2, "0")}/${sub.toString(16).padStart(2, "0")}`;
const hex = (n: number, digits: number) => `0x${n.toString(16).padStart(digits, "0")}`;
const fromHex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const is = (exchange: Exchange, [cmd, sub]: readonly [number, number]) => exchange.cmd === cmd && exchange.sub === sub;
const modeOf = (productId: number, expected: U1Expected): Mode | null =>
	productId === expected.appProductId ? "app" : productId === expected.iapProductId ? "iap" : null;

function exchanges(entries: readonly TranscriptEntry[], expected: U1Expected, findings: string[]): Exchange[] {
	const out: Exchange[] = [];
	let mode: Mode | null = null;
	let open: Exchange | null = null;
	let stale = 0;
	let losses = 0;
	let afterReset = false;
	const nonzero23: string[] = [];
	for (const entry of entries) {
		if (entry.kind === "opened") {
			mode = modeOf(entry.productId, expected);
			afterReset = false;
		}
		if (entry.kind === "lost" && !afterReset) losses++;
		if (entry.kind === "out") {
			if (open !== null) out.push(open);
			const request = fromHex(entry.hex);
			open = { mode, t: entry.t, cmd: request[0] ?? 0, sub: request[1] ?? 0, request, reply: null, replyT: null };
			afterReset = is(open, RESET_TO_IAP) || is(open, RESET_TO_APP);
		}
		if (entry.kind === "in") {
			const reply = fromHex(entry.hex);
			const echo = open !== null && reply[0] === open.cmd && reply[1] === open.sub;
			const refused = reply[0] === ERROR_MARKER[0] && reply[1] === ERROR_MARKER[1];
			const field = view(reply).getUint16(2, true);
			if (field !== 0) nonzero23.push(hex(field, 4));
			if (open !== null && open.reply === null && (echo || refused)) {
				out.push({ ...open, reply, replyT: entry.t });
				open = null;
			} else stale++;
		}
	}
	if (open !== null) out.push(open);
	const unanswered = out.filter((exchange) => exchange.reply === null && !is(exchange, RESET_TO_IAP) && !is(exchange, RESET_TO_APP));
	const refusals = out.filter((exchange) => exchange.reply !== null && exchange.reply[0] === ERROR_MARKER[0]);
	if (nonzero23.length > 0) findings.push(`reply bytes 2..3 nonzero in ${nonzero23.length} replies: ${[...new Set(nonzero23)].join(", ")}`);
	if (stale > 0) findings.push(`${stale} input reports paired with no request`);
	if (unanswered.length > 0) findings.push(`${unanswered.length} requests unanswered: ${[...new Set(unanswered.map((e) => pair(e.cmd, e.sub)))].join(", ")}`);
	if (refusals.length > 0) findings.push(`${refusals.length} FF AA replies to: ${[...new Set(refusals.map((e) => pair(e.cmd, e.sub)))].join(", ")}`);
	if (losses > 0) findings.push(`link lost ${losses} times with no reset sent`);
	const outside = [...new Set(out.map((e) => pair(e.cmd, e.sub)))].filter((seen) => !U1_COMMANDS.includes(seen));
	if (outside.length > 0) findings.push(`frames outside the nine U1 commands: ${outside.join(", ")}`);
	return out;
}

function checkPick(entries: readonly TranscriptEntry[], expected: U1Expected): CheckResult {
	const title = "The Deep check click's chooser listed USB-HID IAP without a second click";
	const picks = entries.filter((entry) => entry.kind === "pick" && entry.reason === "enter-update-mode");
	const first = picks[0];
	if (first === undefined || first.kind !== "pick") return { id: 1, title, pass: false, detail: "no chooser opened for update mode" };
	if (first.path === "activation" && first.productId === expected.iapProductId) {
		return { id: 1, title, pass: true, detail: `picked ${hex(first.productId, 4)} inside the click's activation after ${Math.round(first.waitMs)} ms` };
	}
	const parked = picks.find((entry) => entry.kind === "pick" && entry.path === "parked");
	return {
		id: 1,
		title,
		pass: false,
		detail: parked === undefined || parked.kind !== "pick" ? `the activation chooser closed with ${first.productId === null ? "no device" : hex(first.productId, 4)}` : `needed a second click: the activation chooser closed with ${first.productId === null ? "no device" : hex(first.productId, 4)}, the parked pick chose ${parked.productId === null ? "nothing" : hex(parked.productId, 4)}`,
	};
}

function checkDevice(entries: readonly TranscriptEntry[], expected: U1Expected): CheckResult {
	const title = `The update-mode device is ${hex(expected.iapProductId, 4)} with one collection on usage page ${hex(expected.usagePage, 4)}, usage ${expected.usage}, ${expected.reportBytes}-byte reports`;
	const opened = entries.find((entry) => entry.kind === "opened" && entry.productId === expected.iapProductId);
	if (opened === undefined || opened.kind !== "opened") return { id: 2, title, pass: false, detail: "no update-mode device was opened" };
	const seen = opened.collections.map((c) => `${hex(c.usagePage, 4)}/${c.usage} in ${c.inputReportBytes} out ${c.outputReportBytes} feature ${c.featureReportBytes}`).join("; ");
	const [only] = opened.collections;
	const pass =
		opened.collections.length === 1 &&
		only !== undefined &&
		only.usagePage === expected.usagePage &&
		only.usage === expected.usage &&
		only.inputReportBytes === expected.reportBytes &&
		only.outputReportBytes === expected.reportBytes;
	return { id: 2, title, pass, detail: `${opened.productName}: ${seen}` };
}

function checkReadMode(all: readonly Exchange[]): CheckResult {
	const title = "READ MODE returns 0 in update mode and 1 in normal mode";
	const reads = all.filter(answered).filter((e) => is(e, READ_MODE));
	const byMode: Record<Mode, Set<number>> = { app: new Set(), iap: new Set() };
	for (const read of reads) if (read.mode !== null) byMode[read.mode].add(read.reply[PAYLOAD] ?? -1);
	const pass = reads.length > 0 && byMode.app.size === 1 && byMode.app.has(1) && byMode.iap.size === 1 && byMode.iap.has(0);
	return { id: 3, title, pass, detail: `normal mode answered {${[...byMode.app].join(",")}}, update mode answered {${[...byMode.iap].join(",")}} over ${reads.length} reads` };
}

function checkBlInfo(all: readonly Exchange[], expected: U1Expected): CheckResult {
	const title = `BL info reports fw_offset ${hex(expected.fwOffset, 3)}, page_size ${hex(expected.pageSize, 3)}, fw_pages ${hex(expected.fwPages, 2)}, and identity ${expected.identityHex}`;
	const reads = all.filter(answered).filter((e) => is(e, READ_BL_INFO));
	const seen = new Set(
		reads.map((e) => {
			const payload = e.reply.subarray(PAYLOAD);
			const v = view(payload);
			return `fw_offset ${hex(v.getUint16(0x20, true), 3)}, page_size ${hex(v.getUint16(0x24, true), 3)}, fw_pages ${hex(v.getUint16(0x22, true), 2)}, identity ${toHex(payload.subarray(4, 20))}`;
		}),
	);
	const want = `fw_offset ${hex(expected.fwOffset, 3)}, page_size ${hex(expected.pageSize, 3)}, fw_pages ${hex(expected.fwPages, 2)}, identity ${expected.identityHex}`;
	return { id: 4, title, pass: reads.length > 0 && seen.size === 1 && seen.has(want), detail: reads.length === 0 ? "no BL info reply" : [...seen].join(" | ") };
}

function checkFwInfo(all: readonly Exchange[], expected: U1Expected): CheckResult {
	const title = `FW INFO in update mode returns ${hex(expected.fwOffset, 3)}`;
	const reads = all.filter(answered).filter((e) => is(e, READ_FW_INFO));
	const seen = new Set(reads.map((e) => view(e.reply).getUint32(PAYLOAD, true)));
	return { id: 5, title, pass: reads.length > 0 && seen.size === 1 && seen.has(expected.fwOffset), detail: reads.length === 0 ? "no FW INFO reply" : [...seen].map((n) => hex(n, 8)).join(", ") };
}

async function checkVersionPage(all: readonly Exchange[], expected: U1Expected): Promise<CheckResult> {
	const title = "READ VERSION PAGE parts 0, 1, and 2 return 180 bytes that hash to the catalog's version block";
	const hashes: string[] = [];
	for (let i = 0; i + 3 <= all.length; i++) {
		const parts = all.slice(i, i + 3).filter(answered);
		if (parts.length !== 3 || !parts.every((e, part) => e.cmd === 0x12 && e.sub === READ_VERSION_PAGE_FIRST + part)) continue;
		const page = new Uint8Array(180);
		parts.forEach((e, part) => page.set(e.reply.subarray(PAYLOAD, PAYLOAD + 60), part * 60));
		hashes.push(await sha256(page));
	}
	const seen = [...new Set(hashes)];
	return { id: 6, title, pass: hashes.length > 0 && seen.length === 1 && seen[0] === expected.versionPageSha256, detail: hashes.length === 0 ? "no complete three-part read" : `${hashes.length} reads hashed to ${seen.join(", ")}` };
}

function checkSum(all: readonly Exchange[], expected: U1Expected): CheckResult {
	const title = `SUM over [${hex(expected.fwOffset, 3)}, ${hex(expected.fwOffset, 3)} + ${expected.imageBytes}) returns ${hex(expected.imageSum32, 8)}`;
	const sums = all
		.filter(answered)
		.filter((e) => is(e, SUM) && view(e.request).getUint32(PAYLOAD, true) === expected.fwOffset && view(e.request).getUint32(PAYLOAD + 4, true) === expected.imageBytes);
	const seen = [...new Set(sums.map((e) => view(e.reply).getUint32(PAYLOAD, true)))];
	return { id: 7, title, pass: sums.length > 0 && seen.length === 1 && seen[0] === expected.imageSum32, detail: sums.length === 0 ? "no SUM over the image range answered" : seen.map((n) => hex(n, 8)).join(", ") };
}

function checkBack(entries: readonly TranscriptEntry[], expected: U1Expected, typing: TypingObservation): CheckResult {
	const title = `After RESET to app the board enumerates as ${hex(expected.appProductId, 4)} and types`;
	const opened = entries.filter((entry) => entry.kind === "opened");
	const last = opened.at(-1);
	const reset = entries.some((entry) => entry.kind === "out" && entry.hex.startsWith("1101"));
	const enumerated = reset && last !== undefined && last.kind === "opened" && last.productId === expected.appProductId;
	const typed = typing === "types";
	const detail = `${reset ? "RESET to app sent" : "no RESET to app sent"}; last opened ${last === undefined || last.kind !== "opened" ? "nothing" : hex(last.productId, 4)}; typing ${typing === "not-observed" ? "not observed yet" : typed ? "confirmed" : "failed"}`;
	return { id: 8, title, pass: enumerated && typed, detail };
}

function checkProbes(all: readonly Exchange[], expected: U1Expected): CheckResult {
	const title = `${expected.probes} READ MODE probes in a row in each mode, every answer within ${expected.maxProbeGapMs} ms of the last`;
	interface Run {
		readonly length: number;
		readonly maxGap: number;
		readonly slowest: number;
		readonly answered: boolean;
	}
	const best: Record<Mode, Run> = {
		app: { length: 0, maxGap: 0, slowest: 0, answered: true },
		iap: { length: 0, maxGap: 0, slowest: 0, answered: true },
	};
	const consider = (run: readonly Exchange[]) => {
		const first = run[0];
		if (first === undefined || first.mode === null || run.length <= best[first.mode].length) return;
		let maxGap = 0;
		let slowest = 0;
		let previous: number | null = null;
		for (const e of run) {
			if (e.replyT === null) {
				previous = null;
				continue;
			}
			slowest = Math.max(slowest, e.replyT - e.t);
			if (previous !== null) maxGap = Math.max(maxGap, e.replyT - previous);
			previous = e.replyT;
		}
		best[first.mode] = { length: run.length, maxGap, slowest, answered: run.every(answered) };
	};
	let run: Exchange[] = [];
	for (const e of all) {
		const probe = is(e, READ_MODE) && e.mode !== null;
		if (!probe || (run.length > 0 && run[0]?.mode !== e.mode)) {
			consider(run);
			run = [];
		}
		if (probe) run.push(e);
	}
	consider(run);
	const ok = (mode: Mode) => best[mode].length >= expected.probes && best[mode].answered && best[mode].maxGap <= expected.maxProbeGapMs;
	const describe = (mode: Mode) =>
		`${mode === "app" ? "normal" : "update"} mode: ${best[mode].length} in a row, ${best[mode].answered ? "all answered" : "some unanswered"}, longest gap ${Math.round(best[mode].maxGap)} ms, slowest answer ${Math.round(best[mode].slowest)} ms`;
	return { id: 9, title, pass: ok("app") && ok("iap"), detail: `${describe("app")}; ${describe("iap")}` };
}

export interface EvaluateOptions {
	readonly expected: U1Expected;
	readonly typing: TypingObservation;
}

export async function evaluateU1(transcript: Transcript, options: EvaluateOptions): Promise<U1Verdict> {
	const { expected } = options;
	const findings: string[] = [];
	const all = exchanges(transcript.entries, expected, findings);
	const checks: CheckResult[] = [
		checkPick(transcript.entries, expected),
		checkDevice(transcript.entries, expected),
		checkReadMode(all),
		checkBlInfo(all, expected),
		checkFwInfo(all, expected),
		await checkVersionPage(all, expected),
		checkSum(all, expected),
		checkBack(transcript.entries, expected, options.typing),
		checkProbes(all, expected),
	];
	return { checks, findings, commands: [...new Set(all.map((e) => pair(e.cmd, e.sub)))] };
}

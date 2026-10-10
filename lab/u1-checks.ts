/**
 * Plan unit U1's verdict from a transcript. Its import closure reaches core/ only through device.ts, firmware.ts,
 * port.ts, and units.ts, never protocol.ts, so a codec bug in the core cannot vouch for itself here
 * (probes/boundaries.ts rule u1-checks-independence).
 */
import { sha256 } from "../core/firmware";
import type { Mode } from "../core/units";
import type { Transcript, TranscriptEntry } from "../testing/transcript";
import { U1_FRAMES } from "./u1-frames";

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
	/** How far apart the page sends its probes. Check 9 requires each gap to be at least 90% of it. Fake runs pass 0. */
	readonly probeSpacingMs: number;
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
	/** A gate beside the nine checks: any frame off the golden list fails the run, whatever the checks say. */
	readonly frames: { readonly title: string; readonly pass: boolean; readonly detail: string };
	readonly checks: readonly CheckResult[];
	readonly findings: readonly string[];
	readonly commands: readonly string[];
}

/** The run passes only when every frame was golden and all nine checks passed. */
export function passes(verdict: U1Verdict): boolean {
	return verdict.frames.pass && verdict.checks.every((check) => check.pass);
}

interface Exchange {
	readonly mode: Mode | null;
	/** How many links had opened before this exchange, so exchanges on one link share a number. */
	readonly link: number;
	readonly t: number;
	readonly cmd: number;
	readonly sub: number;
	readonly request: Uint8Array;
	readonly reply: Uint8Array | null;
	readonly replyT: number | null;
}

type Answered = Exchange & { readonly reply: Uint8Array; readonly replyT: number };
const echoed = (exchange: Exchange): exchange is Answered =>
	exchange.reply !== null && exchange.replyT !== null && exchange.reply[0] === exchange.cmd && exchange.reply[1] === exchange.sub;

const READ_BL_INFO = [0x12, 0x00] as const;
const READ_FW_INFO = [0x12, 0x01] as const;
const READ_MODE = [0x12, 0x02] as const;
const READ_VERSION_PAGE_FIRST = 0x20;
const SUM = [0x1d, 0x01] as const;
const RESET_TO_IAP = [0x11, 0x00] as const;
const RESET_TO_APP = [0x11, 0x01] as const;
const ERROR_MARKER = [0xff, 0xaa] as const;
const PAYLOAD = 4;

const SPACING_TOLERANCE = 0.9;

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
	let link = 0;
	let open: Exchange | null = null;
	let stale = 0;
	let losses = 0;
	let afterReset = false;
	const nonzero23: string[] = [];
	for (const entry of entries) {
		if (entry.kind === "opened") {
			mode = modeOf(entry.productId, expected);
			link++;
			afterReset = false;
		}
		if (entry.kind === "lost" && !afterReset) losses++;
		if (entry.kind === "out") {
			if (open !== null) out.push(open);
			const request = fromHex(entry.hex);
			open = { mode, link, t: entry.t, cmd: request[0] ?? 0, sub: request[1] ?? 0, request, reply: null, replyT: null };
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
	return out;
}

function checkFrames(entries: readonly TranscriptEntry[]): U1Verdict["frames"] {
	const title = "Every frame sent is one of the nine golden frames";
	const sent = entries.flatMap((entry) => (entry.kind === "out" ? [entry.hex] : entry.kind === "out-write" ? [`WRITE ${entry.header}`] : []));
	const off = [...new Set(sent.filter((frame) => !U1_FRAMES.includes(frame)))];
	if (off.length > 0) return { title, pass: false, detail: `${off.length} sent frames are not golden: ${off.join(", ")}` };
	return { title, pass: true, detail: `all ${sent.length} out entries are golden` };
}

/** The `out` entry at `index` failed to send when its `send-failed` entry comes before the next `out` entry. */
function sendFailed(entries: readonly TranscriptEntry[], index: number): boolean {
	const sent = entries[index];
	for (let i = index + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry?.kind === "out") return false;
		if (entry?.kind === "send-failed" && sent?.kind === "out" && entry.hex === sent.hex) return true;
	}
	return false;
}

const isResetToApp = (entry: TranscriptEntry | undefined) => entry?.kind === "out" && entry.hex.startsWith("1101");

/** RESET to app sends that failed, after which the board still came back before the next RESET to app. */
function returnsAfterFailedResets(entries: readonly TranscriptEntry[], expected: U1Expected): number {
	let returns = 0;
	for (let i = 0; i < entries.length; i++) {
		if (!isResetToApp(entries[i]) || !sendFailed(entries, i)) continue;
		for (let j = i + 1; j < entries.length && !isResetToApp(entries[j]); j++) {
			const entry = entries[j];
			if (entry?.kind === "opened" && entry.productId === expected.appProductId) {
				returns++;
				break;
			}
		}
	}
	return returns;
}

function entryFindings(entries: readonly TranscriptEntry[], expected: U1Expected): string[] {
	const findings: string[] = [];
	const failed = entries.flatMap((entry) => (entry.kind === "send-failed" ? [entry.hex.slice(0, 4)] : []));
	if (failed.length > 0) findings.push(`${failed.length} sends rejected, so the board may or may not have taken them: ${[...new Set(failed)].join(", ")}`);
	const returns = returnsAfterFailedResets(entries, expected);
	if (returns > 0) findings.push(`${returns} times ${hex(expected.appProductId, 4)} opened after a RESET to app whose send failed, so that return does not show the reset worked`);
	const slowCloses = entries.flatMap((entry) => (entry.kind === "close-timeout" ? [hex(entry.productId, 4)] : []));
	if (slowCloses.length > 0) findings.push(`${slowCloses.length} closes did not settle in time and were counted as closed: ${slowCloses.join(", ")}`);
	const discarded = entries.filter((entry) => entry.kind === "discarded").length;
	if (discarded > 0) findings.push(`${discarded} input reports were dropped unread before a send`);
	const hidden = entries.filter((entry) => entry.kind === "visibility" && entry.state === "hidden").length;
	if (hidden > 0) findings.push(`the tab was hidden ${hidden} times, and a hidden tab slows timers, so check 9's timing may measure the tab`);
	return findings;
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
	const reads = all.filter(echoed).filter((e) => is(e, READ_MODE));
	const byMode: Record<Mode, Set<number>> = { app: new Set(), iap: new Set() };
	for (const read of reads) if (read.mode !== null) byMode[read.mode].add(read.reply[PAYLOAD] ?? -1);
	const pass = reads.length > 0 && byMode.app.size === 1 && byMode.app.has(1) && byMode.iap.size === 1 && byMode.iap.has(0);
	return { id: 3, title, pass, detail: `normal mode answered {${[...byMode.app].join(",")}}, update mode answered {${[...byMode.iap].join(",")}} over ${reads.length} reads` };
}

function checkBlInfo(all: readonly Exchange[], expected: U1Expected): CheckResult {
	const title = `BL info reports fw_offset ${hex(expected.fwOffset, 3)}, page_size ${hex(expected.pageSize, 3)}, fw_pages ${hex(expected.fwPages, 2)}, and identity ${expected.identityHex}`;
	const reads = all.filter(echoed).filter((e) => is(e, READ_BL_INFO));
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
	const reads = all.filter(echoed).filter((e) => is(e, READ_FW_INFO));
	const seen = new Set(reads.map((e) => view(e.reply).getUint32(PAYLOAD, true)));
	return { id: 5, title, pass: reads.length > 0 && seen.size === 1 && seen.has(expected.fwOffset), detail: reads.length === 0 ? "no FW INFO reply" : [...seen].map((n) => hex(n, 8)).join(", ") };
}

async function checkVersionPage(all: readonly Exchange[], expected: U1Expected): Promise<CheckResult> {
	const title = "READ VERSION PAGE parts 0, 1, and 2 return 180 bytes that hash to the catalog's version block";
	const hashes: string[] = [];
	for (let i = 0; i + 3 <= all.length; i++) {
		const parts = all.slice(i, i + 3).filter(echoed);
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
		.filter(echoed)
		.filter((e) => is(e, SUM) && view(e.request).getUint32(PAYLOAD, true) === expected.fwOffset && view(e.request).getUint32(PAYLOAD + 4, true) === expected.imageBytes);
	const seen = [...new Set(sums.map((e) => view(e.reply).getUint32(PAYLOAD, true)))];
	return { id: 7, title, pass: sums.length > 0 && seen.length === 1 && seen[0] === expected.imageSum32, detail: sums.length === 0 ? "no SUM over the image range answered" : seen.map((n) => hex(n, 8)).join(", ") };
}

/**
 * A board brought back by a cold boot and a Connect click must not pass as RESET to app working (F7), and neither
 * may a return after a RESET to app whose send failed.
 */
function checkBack(entries: readonly TranscriptEntry[], expected: U1Expected, typing: TypingObservation): CheckResult {
	const title = `After RESET to app the board enumerates as ${hex(expected.appProductId, 4)} for the confirm and types`;
	const result = (pass: boolean, detail: string): CheckResult => ({ id: 8, title, pass, detail });
	const resets = entries.flatMap((entry, index) => (isResetToApp(entry) ? [index] : []));
	if (resets.length === 0) return result(false, "no RESET to app sent");
	const reset = resets.filter((index) => !sendFailed(entries, index)).at(-1);
	if (reset === undefined) return result(false, `the only RESET to app sends (${resets.length}) failed, so nothing shows the board took one`);
	const after = entries.slice(reset + 1);
	const open = after.findIndex((entry) => entry.kind === "opened" && entry.productId === expected.appProductId && entry.reason === "confirm-normal-mode");
	if (open === -1) return result(false, `no ${hex(expected.appProductId, 4)} opened for the confirm after the last RESET to app that left`);
	const pick = after.slice(0, open).flatMap((entry) => (entry.kind === "pick" && entry.reason === "confirm-normal-mode" ? [entry] : [])).at(-1);
	const how = pick === undefined ? "the confirm, through a granted device and no chooser," : `the confirm pick (${pick.path})`;
	const typed = after.slice(open + 1).some((entry) => entry.kind === "typing" && entry.chars > 0);
	const back = `RESET to app sent; ${how} opened ${hex(expected.appProductId, 4)}`;
	if (!typed) return result(false, `${back}; no typing entry after that open`);
	if (typing !== "types") return result(false, `${back}; ${typing === "not-observed" ? "typing not observed yet" : "the human says the board does not type"}`);
	return result(true, `${back}; typing confirmed`);
}

function checkProbes(all: readonly Exchange[], expected: U1Expected): CheckResult {
	const title = `${expected.probes} READ MODE probes in a row in each mode, sent ${expected.probeSpacingMs} ms apart, every answer within ${expected.maxProbeGapMs} ms of the last`;
	interface Run {
		readonly length: number;
		readonly maxGap: number;
		readonly slowest: number;
		readonly minSendGap: number;
		readonly answered: boolean;
	}
	const none: Run = { length: 0, maxGap: 0, slowest: 0, minSendGap: Number.POSITIVE_INFINITY, answered: true };
	const best: Record<Mode, Run> = { app: none, iap: none };
	const consider = (run: readonly Exchange[]) => {
		const first = run[0];
		if (first === undefined || first.mode === null || run.length <= best[first.mode].length) return;
		let maxGap = 0;
		let slowest = 0;
		let minSendGap = Number.POSITIVE_INFINITY;
		let previousReply: number | null = null;
		let previousSend: number | null = null;
		for (const e of run) {
			if (previousSend !== null) minSendGap = Math.min(minSendGap, e.t - previousSend);
			previousSend = e.t;
			if (!echoed(e)) {
				previousReply = null;
				continue;
			}
			slowest = Math.max(slowest, e.replyT - e.t);
			if (previousReply !== null) maxGap = Math.max(maxGap, e.replyT - previousReply);
			previousReply = e.replyT;
		}
		best[first.mode] = { length: run.length, maxGap, slowest, minSendGap, answered: run.every(echoed) };
	};
	let run: Exchange[] = [];
	for (const e of all) {
		const probe = is(e, READ_MODE) && e.mode !== null;
		if (!probe || (run.length > 0 && run[0]?.link !== e.link)) {
			consider(run);
			run = [];
		}
		if (probe) run.push(e);
	}
	consider(run);
	const ok = (mode: Mode) =>
		best[mode].length >= expected.probes &&
		best[mode].answered &&
		best[mode].maxGap <= expected.maxProbeGapMs &&
		best[mode].minSendGap >= SPACING_TOLERANCE * expected.probeSpacingMs;
	const describe = (mode: Mode) =>
		`${mode === "app" ? "normal" : "update"} mode: ${best[mode].length} in a row, ${best[mode].answered ? "all answered" : "some unanswered"}, longest gap ${Math.round(best[mode].maxGap)} ms, slowest answer ${Math.round(best[mode].slowest)} ms, shortest send gap ${Math.round(best[mode].minSendGap)} ms`;
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
	findings.push(...entryFindings(transcript.entries, expected));
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
	return { frames: checkFrames(transcript.entries), checks, findings, commands: [...new Set(all.map((e) => pair(e.cmd, e.sub)))] };
}

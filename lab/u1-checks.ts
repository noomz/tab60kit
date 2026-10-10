/**
 * Plan unit U1's verdict from a transcript, pure and browser-safe: the page shows it live after a run, and
 * tools/u1-verdict.ts writes it to the fixture. Each check reads the frames or the shell's events the way a reviewer
 * would, with its own hex parsing and the (cmd, sub) pairs written out, so a codec bug in the core cannot vouch for
 * itself here. Check 8's typing half is a human observation handed in.
 */
import { EXPECTED_LAYOUT, TAB60 } from "../core/device";
import { CATALOG, sha256 } from "../core/firmware";
import { WRITE_LINK_RULE } from "../core/flash";
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

const V1_01_13 = CATALOG.find((entry) => entry.version === "V1.01.13");
if (V1_01_13 === undefined) throw new Error("the catalog lost V1.01.13");

/** What the user's board, flashed with V1.01.13 by the vendor updater, must answer (docs/units.md U1 checks 2 to 7 and 9). */
export const U1_EXPECTED: U1Expected = {
	appProductId: TAB60.productId.app,
	iapProductId: TAB60.productId.iap,
	usagePage: TAB60.usagePage,
	usage: TAB60.usage,
	reportBytes: TAB60.reportBytes,
	identityHex: EXPECTED_LAYOUT.identityHex,
	fwOffset: EXPECTED_LAYOUT.fwOffset,
	pageSize: EXPECTED_LAYOUT.pageSize,
	fwPages: EXPECTED_LAYOUT.fwPages,
	versionPageSha256: V1_01_13.versionBlock.sha256,
	imageBytes: V1_01_13.image.bytes,
	imageSum32: V1_01_13.image.wireSum32,
	probes: 30,
	maxProbeGapMs: WRITE_LINK_RULE.maxProbeGapMs,
};

export interface CheckResult {
	readonly id: number;
	readonly title: string;
	readonly pass: boolean;
	readonly detail: string;
}

export interface U1Verdict {
	readonly checks: readonly CheckResult[];
	/** Anything the board did that the model did not predict. Not failures by themselves. */
	readonly findings: readonly string[];
	/** Every (cmd, sub) pair sent, as "cmd/sub" hex, in first-seen order. */
	readonly commands: readonly string[];
}

/** One request and the reply paired with it, in the mode of the link that carried them. */
interface Exchange {
	readonly mode: Mode | null;
	readonly t: number;
	readonly cmd: number;
	readonly sub: number;
	readonly request: Uint8Array;
	readonly reply: Uint8Array | null;
	readonly replyT: number | null;
}

const READ_BL_INFO = [0x12, 0x00] as const;
const READ_FW_INFO = [0x12, 0x01] as const;
const READ_MODE = [0x12, 0x02] as const;
const READ_VERSION_PAGE_FIRST = 0x20;
const SUM = [0x1d, 0x01] as const;
const RESET_TO_IAP = [0x11, 0x00] as const;
const RESET_TO_APP = [0x11, 0x01] as const;
const ERROR_MARKER = [0xff, 0xaa] as const;
const PAYLOAD = 4;

/** The nine U1 frames by (cmd, sub). */
export const U1_COMMANDS: readonly string[] = ["12/02", "12/00", "12/01", "12/20", "12/21", "12/22", "1d/01", "11/00", "11/01"];

const pair = (cmd: number, sub: number) => `${cmd.toString(16).padStart(2, "0")}/${sub.toString(16).padStart(2, "0")}`;
const hex = (n: number, digits: number) => `0x${n.toString(16).padStart(digits, "0")}`;
const fromHex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const is = (exchange: Exchange, [cmd, sub]: readonly [number, number]) => exchange.cmd === cmd && exchange.sub === sub;
const modeOf = (productId: number, expected: U1Expected): Mode | null =>
	productId === expected.appProductId ? "app" : productId === expected.iapProductId ? "iap" : null;

/** Walks the entries once: the link's mode from each opened device, and every request paired with its reply. */
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
	const reads = all.filter((e) => is(e, READ_MODE) && e.reply !== null);
	const byMode: Record<Mode, Set<number>> = { app: new Set(), iap: new Set() };
	for (const read of reads) if (read.mode !== null && read.reply !== null) byMode[read.mode].add(read.reply[PAYLOAD] ?? -1);
	const pass = reads.length > 0 && byMode.app.size === 1 && byMode.app.has(1) && byMode.iap.size === 1 && byMode.iap.has(0);
	return { id: 3, title, pass, detail: `normal mode answered {${[...byMode.app].join(",")}}, update mode answered {${[...byMode.iap].join(",")}} over ${reads.length} reads` };
}

function checkBlInfo(all: readonly Exchange[], expected: U1Expected): CheckResult {
	const title = `BL info reports fw_offset ${hex(expected.fwOffset, 3)}, page_size ${hex(expected.pageSize, 3)}, fw_pages ${hex(expected.fwPages, 2)}, and identity ${expected.identityHex}`;
	const reads = all.filter((e) => is(e, READ_BL_INFO) && e.reply !== null);
	const seen = new Set(
		reads.map((e) => {
			const payload = e.reply!.subarray(PAYLOAD);
			const v = view(payload);
			return `fw_offset ${hex(v.getUint16(0x20, true), 3)}, page_size ${hex(v.getUint16(0x24, true), 3)}, fw_pages ${hex(v.getUint16(0x22, true), 2)}, identity ${toHex(payload.subarray(4, 20))}`;
		}),
	);
	const want = `fw_offset ${hex(expected.fwOffset, 3)}, page_size ${hex(expected.pageSize, 3)}, fw_pages ${hex(expected.fwPages, 2)}, identity ${expected.identityHex}`;
	return { id: 4, title, pass: reads.length > 0 && seen.size === 1 && seen.has(want), detail: reads.length === 0 ? "no BL info reply" : [...seen].join(" | ") };
}

function checkFwInfo(all: readonly Exchange[], expected: U1Expected): CheckResult {
	const title = `FW INFO in update mode returns ${hex(expected.fwOffset, 3)}`;
	const reads = all.filter((e) => is(e, READ_FW_INFO) && e.reply !== null);
	const seen = new Set(reads.map((e) => view(e.reply!).getUint32(PAYLOAD, true)));
	return { id: 5, title, pass: reads.length > 0 && seen.size === 1 && seen.has(expected.fwOffset), detail: reads.length === 0 ? "no FW INFO reply" : [...seen].map((n) => hex(n, 8)).join(", ") };
}

async function checkVersionPage(all: readonly Exchange[], expected: U1Expected): Promise<CheckResult> {
	const title = "READ VERSION PAGE parts 0, 1, and 2 return 180 bytes that hash to the catalog's version block";
	const hashes: string[] = [];
	for (let i = 0; i + 2 < all.length; i++) {
		const parts = [all[i]!, all[i + 1]!, all[i + 2]!];
		if (!parts.every((e, part) => e.cmd === 0x12 && e.sub === READ_VERSION_PAGE_FIRST + part && e.reply !== null)) continue;
		const page = new Uint8Array(180);
		parts.forEach((e, part) => page.set(e.reply!.subarray(PAYLOAD, PAYLOAD + 60), part * 60));
		hashes.push(await sha256(page));
	}
	const seen = [...new Set(hashes)];
	return { id: 6, title, pass: hashes.length > 0 && seen.length === 1 && seen[0] === expected.versionPageSha256, detail: hashes.length === 0 ? "no complete three-part read" : `${hashes.length} reads hashed to ${seen.join(", ")}` };
}

function checkSum(all: readonly Exchange[], expected: U1Expected): CheckResult {
	const title = `SUM over [${hex(expected.fwOffset, 3)}, ${hex(expected.fwOffset, 3)} + ${expected.imageBytes}) returns ${hex(expected.imageSum32, 8)}`;
	const sums = all.filter((e) => is(e, SUM) && e.reply !== null && view(e.request).getUint32(PAYLOAD, true) === expected.fwOffset && view(e.request).getUint32(PAYLOAD + 4, true) === expected.imageBytes);
	const seen = [...new Set(sums.map((e) => view(e.reply!).getUint32(PAYLOAD, true)))];
	return { id: 7, title, pass: sums.length > 0 && seen.length === 1 && seen[0] === expected.imageSum32, detail: sums.length === 0 ? "no SUM over the image range answered" : seen.map((n) => hex(n, 8)).join(", ") };
}

function checkBack(entries: readonly TranscriptEntry[], expected: U1Expected, boardTypes: boolean | null): CheckResult {
	const title = `After RESET to app the board enumerates as ${hex(expected.appProductId, 4)} and types`;
	const opened = entries.filter((entry) => entry.kind === "opened");
	const last = opened.at(-1);
	const reset = entries.some((entry) => entry.kind === "out" && entry.hex.startsWith("1101"));
	const enumerated = reset && last !== undefined && last.kind === "opened" && last.productId === expected.appProductId;
	const typed = boardTypes === true;
	const detail = `${reset ? "RESET to app sent" : "no RESET to app sent"}; last opened ${last === undefined || last.kind !== "opened" ? "nothing" : hex(last.productId, 4)}; typing ${boardTypes === null ? "not observed yet" : boardTypes ? "confirmed" : "failed"}`;
	return { id: 8, title, pass: enumerated && typed, detail };
}

function checkProbes(all: readonly Exchange[], expected: U1Expected): CheckResult {
	const title = `${expected.probes} READ MODE probes in a row in each mode, every answer within ${expected.maxProbeGapMs} ms of the last`;
	const runs: Record<Mode, { length: number; maxGap: number; slowest: number; answered: boolean }> = {
		app: { length: 0, maxGap: 0, slowest: 0, answered: true },
		iap: { length: 0, maxGap: 0, slowest: 0, answered: true },
	};
	let i = 0;
	while (i < all.length) {
		const start = all[i]!;
		if (!is(start, READ_MODE) || start.mode === null) {
			i++;
			continue;
		}
		let end = i;
		while (end < all.length && is(all[end]!, READ_MODE) && all[end]!.mode === start.mode) end++;
		const run = all.slice(i, end);
		const best = runs[start.mode];
		if (run.length > best.length) {
			let maxGap = 0;
			let slowest = 0;
			for (let k = 0; k < run.length; k++) {
				const e = run[k]!;
				if (e.replyT !== null) slowest = Math.max(slowest, e.replyT - e.t);
				const previous = run[k - 1];
				if (previous?.replyT != null && e.replyT !== null) maxGap = Math.max(maxGap, e.replyT - previous.replyT);
			}
			runs[start.mode] = { length: run.length, maxGap, slowest, answered: run.every((e) => e.reply !== null) };
		}
		i = end;
	}
	const ok = (mode: Mode) => runs[mode].length >= expected.probes && runs[mode].answered && runs[mode].maxGap <= expected.maxProbeGapMs;
	const describe = (mode: Mode) => `${mode === "app" ? "normal" : "update"} mode: ${runs[mode].length} in a row, ${runs[mode].answered ? "all answered" : "some unanswered"}, longest gap ${Math.round(runs[mode].maxGap)} ms, slowest answer ${Math.round(runs[mode].slowest)} ms`;
	return { id: 9, title, pass: ok("app") && ok("iap"), detail: `${describe("app")}; ${describe("iap")}` };
}

export interface EvaluateOptions {
	readonly expected?: U1Expected;
	/** Plan check 8's human half: the board types after the run. null when nobody has looked yet. */
	readonly boardTypes?: boolean | null;
}

export async function evaluateU1(transcript: Transcript, options: EvaluateOptions = {}): Promise<U1Verdict> {
	const expected = options.expected ?? U1_EXPECTED;
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
		checkBack(transcript.entries, expected, options.boardTypes ?? null),
		checkProbes(all, expected),
	];
	return { checks, findings, commands: [...new Set(all.map((e) => pair(e.cmd, e.sub)))] };
}

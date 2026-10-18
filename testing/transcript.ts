/**
 * Recorded sessions with a real board: the golden fixtures behind the fake board and the replay tests, and the
 * capture that moves a G1 row from "reviewed" to "confirmed" (protocol.ts Maturity).
 *
 * A transcript never carries firmware. `recording` refuses a WRITE frame until U7 stores write payloads as their
 * length and SHA-256; replay then compares the hash of what the core sends against the recorded hash, so golden
 * tests stay byte-exact without redistributing vendor bytes.
 */
import { type DevicePort, type DeviceWant, type InReport, type Link, LinkLost, LinkTimeout, type Mode, type OutReport, type WantReason, asInReport, modeOf } from "../core/port";
import { type Sha256, sha256Literal } from "../core/units";

/**
 * What the page records about the session: the tool commit, user agent, platform, page URL, the `?fake` mode, and the
 * three precondition keys (lab/u1-state.ts PRECONDITIONS).
 */
export interface Environment extends Readonly<Record<string, string>> {
	/** "no" for the real WebHID, otherwise the page's ?fake mode. tools/u1-verdict.ts accepts only "no". */
	readonly fake: string;
}

export interface Transcript {
	readonly format: "tab60kit-transcript/1";
	readonly recordedAt: string;
	readonly environment: Environment;
	readonly entries: readonly TranscriptEntry[];
}

export interface CollectionEntry {
	readonly usagePage: number;
	readonly usage: number;
	readonly inputReportBytes: number;
	readonly outputReportBytes: number;
	readonly featureReportBytes: number;
}

export type TranscriptEntry =
	| {
			readonly t: number;
			readonly kind: "pick";
			readonly reason: WantReason;
			readonly path: "activation" | "parked";
			readonly productId: number | null;
			readonly waitMs: number;
	  }
	| { readonly t: number; readonly kind: "open-attempt"; readonly productId: number; readonly attempt: number; readonly error: string | null }
	| {
			readonly t: number;
			readonly kind: "opened";
			readonly reason: WantReason;
			readonly productId: number;
			readonly productName: string;
			readonly collections: readonly CollectionEntry[];
	  }
	| { readonly t: number; readonly kind: "out"; readonly hex: string }
	| {
			readonly t: number;
			readonly kind: "out-write";
			/** Bytes 0..3 of the WRITE packet. */
			readonly header: string;
			readonly payloadBytes: number;
			readonly payloadSha256: Sha256;
	  }
	/** A `discarded` report is one that discardPending dropped before a send, so the core never read it. */
	| { readonly t: number; readonly kind: "in" | "discarded"; readonly hex: string }
	/** Follows the `out` entry of a frame whose send rejected. The board may still have received it. */
	| { readonly t: number; readonly kind: "send-failed"; readonly hex: string; readonly error: string }
	/** The shell counted a device.close() that did not settle in time as closed. */
	| { readonly t: number; readonly kind: "close-timeout"; readonly productId: number }
	/** A TAB 60 device the browser still granted when the page loaded, before any click. */
	| { readonly t: number; readonly kind: "granted"; readonly productId: number }
	/** The page's visibility, at its start and on each change. A hidden tab slows timers, which check 9 measures. */
	| { readonly t: number; readonly kind: "visibility"; readonly state: "visible" | "hidden" }
	/** The typing field changed while a normal-mode link was the last one opened. Plan check 8 reads it as the board typing. */
	| { readonly t: number; readonly kind: "typing"; readonly chars: number }
	| { readonly t: number; readonly kind: "precondition"; readonly key: string; readonly met: boolean }
	| { readonly t: number; readonly kind: "lost" | "closed"; readonly mode?: Mode };

const WRITE_CMD = 0x1f;

export const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export function recording(link: Link, sink: (entry: TranscriptEntry) => void, now: () => number = () => performance.now()): Link {
	void link.lost.then(() => sink({ t: now(), kind: "lost", mode: link.mode }));
	return {
		mode: link.mode,
		lost: link.lost,
		async send(report) {
			if (report[0] === WRITE_CMD) throw new Error("recording: WRITE frames are not recordable before U7 hashes their payloads");
			const hex = hexOf(report);
			sink({ t: now(), kind: "out", hex });
			try {
				await link.send(report);
			} catch (error) {
				sink({ t: now(), kind: "send-failed", hex, error: describe(error) });
				throw error;
			}
		},
		async next(timeoutMs) {
			const reply = await link.next(timeoutMs);
			sink({ t: now(), kind: "in", hex: hexOf(reply) });
			return reply;
		},
		discardPending() {
			const dropped = link.discardPending();
			for (const report of dropped) sink({ t: now(), kind: "discarded", hex: hexOf(report) });
			return dropped;
		},
		async close() {
			await link.close();
			sink({ t: now(), kind: "closed", mode: link.mode });
		},
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const REPORT_HEX = /^[0-9a-f]{128}$/;
const WANT_REASONS: readonly string[] = ["connect", "enter-update-mode", "after-link-loss", "confirm-normal-mode"] satisfies readonly WantReason[];
const isWantReason = (value: string): value is WantReason => WANT_REASONS.includes(value);

function fail(where: string, what: string): never {
	throw new TypeError(`transcript ${where}: ${what}`);
}

function number(entry: Record<string, unknown>, field: string, where: string): number {
	const value = entry[field];
	return typeof value === "number" && Number.isFinite(value) ? value : fail(where, `${field} is not a number`);
}

function string(entry: Record<string, unknown>, field: string, where: string): string {
	const value = entry[field];
	return typeof value === "string" ? value : fail(where, `${field} is not a string`);
}

function wantReason(entry: Record<string, unknown>, where: string): WantReason {
	const reason = string(entry, "reason", where);
	return isWantReason(reason) ? reason : fail(where, `unknown reason ${reason}`);
}

function reportHex(entry: Record<string, unknown>, where: string): string {
	const hex = string(entry, "hex", where);
	return REPORT_HEX.test(hex) ? hex : fail(where, "hex is not 64 bytes");
}

function parseCollection(value: unknown, where: string): CollectionEntry {
	if (!isRecord(value)) fail(where, "collection is not an object");
	return {
		usagePage: number(value, "usagePage", where),
		usage: number(value, "usage", where),
		inputReportBytes: number(value, "inputReportBytes", where),
		outputReportBytes: number(value, "outputReportBytes", where),
		featureReportBytes: number(value, "featureReportBytes", where),
	};
}

function parseEntry(value: unknown, index: number): TranscriptEntry {
	const where = `entry ${index}`;
	if (!isRecord(value)) fail(where, "not an object");
	const t = number(value, "t", where);
	const kind = string(value, "kind", where);
	switch (kind) {
		case "out":
		case "in":
		case "discarded":
			return { t, kind, hex: reportHex(value, where) };
		case "send-failed":
			return { t, kind, hex: reportHex(value, where), error: string(value, "error", where) };
		case "close-timeout":
		case "granted":
			return { t, kind, productId: number(value, "productId", where) };
		case "visibility": {
			const state = string(value, "state", where);
			if (state !== "visible" && state !== "hidden") fail(where, `unknown visibility ${state}`);
			return { t, kind, state };
		}
		case "typing":
			return { t, kind, chars: number(value, "chars", where) };
		case "precondition": {
			const { met } = value;
			if (typeof met !== "boolean") fail(where, "met is not a boolean");
			return { t, kind, key: string(value, "key", where), met };
		}
		case "lost":
		case "closed": {
			if (value.mode === undefined) return { t, kind };
			const mode = string(value, "mode", where);
			if (mode !== "app" && mode !== "iap") fail(where, `unknown mode ${mode}`);
			return { t, kind, mode };
		}
		case "opened": {
			const collections = value.collections;
			if (!Array.isArray(collections)) fail(where, "collections is not an array");
			return {
				t,
				kind,
				reason: wantReason(value, where),
				productId: number(value, "productId", where),
				productName: string(value, "productName", where),
				collections: collections.map((collection) => parseCollection(collection, where)),
			};
		}
		case "open-attempt": {
			const error = value.error;
			if (error !== null && typeof error !== "string") fail(where, "error is neither null nor a string");
			return { t, kind, productId: number(value, "productId", where), attempt: number(value, "attempt", where), error };
		}
		case "pick": {
			const path = string(value, "path", where);
			const productId = value.productId;
			if (path !== "activation" && path !== "parked") fail(where, `unknown path ${path}`);
			if (productId !== null && typeof productId !== "number") fail(where, "productId is neither null nor a number");
			return { t, kind, reason: wantReason(value, where), path, productId, waitMs: number(value, "waitMs", where) };
		}
		case "out-write":
			return {
				t,
				kind,
				header: string(value, "header", where),
				payloadBytes: number(value, "payloadBytes", where),
				payloadSha256: sha256Literal(string(value, "payloadSha256", where)),
			};
		default:
			return fail(where, `unknown kind ${kind}`);
	}
}

export function parseTranscript(json: unknown): Transcript {
	if (!isRecord(json)) fail("root", "not an object");
	if (json.format !== "tab60kit-transcript/1") fail("root", `format is ${String(json.format)}`);
	const recordedAt = string(json, "recordedAt", "root");
	if (!isRecord(json.environment)) fail("root", "environment is not an object");
	const strings: Record<string, string> = {};
	for (const [key, value] of Object.entries(json.environment)) strings[key] = typeof value === "string" ? value : fail("root", `environment.${key} is not a string`);
	const { fake } = strings;
	if (fake === undefined) fail("root", "environment.fake is missing, so nothing says whether the board was real");
	if (!Array.isArray(json.entries)) fail("root", "entries is not an array");
	return {
		format: "tab60kit-transcript/1",
		recordedAt,
		environment: { ...strings, fake },
		entries: json.entries.map(parseEntry),
	};
}

/** What the core did that the transcript did not record at that point. */
export class ReplayDiverged extends Error {
	override readonly name = "ReplayDiverged";
	constructor(
		readonly index: number,
		readonly expected: string,
		readonly got: string,
	) {
		super(`replay diverged at entry ${index}: the transcript has ${expected}, the core did ${got}`);
	}
}

export interface ReplayPort extends DevicePort {
	/** The first divergence, kept here because the job under test may catch the error it threw. */
	readonly divergence: ReplayDiverged | null;
	/** The wire entries the core has not reached yet. */
	remaining(): readonly { readonly index: number; readonly entry: TranscriptEntry }[];
}

/** "in" shares its union member with "discarded", so it is spelled out. */
type WireEntry = Extract<TranscriptEntry, { kind: "opened" | "out" | "out-write" | "send-failed" | "lost" | "closed" }> | { readonly t: number; readonly kind: "in"; readonly hex: string };

const WIRE_KINDS: readonly string[] = ["opened", "out", "out-write", "in", "send-failed", "lost", "closed"] satisfies readonly WireEntry["kind"][];
const isWire = (entry: TranscriptEntry): entry is WireEntry => WIRE_KINDS.includes(entry.kind);

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

async function sha256Hex(bytes: Uint8Array): Promise<Sha256> {
	return sha256Literal(hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)))));
}

function describeEntry(entry: WireEntry | undefined): string {
	if (entry === undefined) return "nothing left";
	switch (entry.kind) {
		case "opened":
			return `an open of 0x${entry.productId.toString(16)} for ${entry.reason}`;
		case "out":
		case "in":
		case "send-failed":
			return `${entry.kind} ${entry.hex.slice(0, 24)}`;
		case "out-write":
			return `a WRITE ${entry.header} of ${entry.payloadBytes} bytes`;
		case "lost":
		case "closed":
			return `${entry.kind}${entry.mode === undefined ? "" : ` (${entry.mode})`}`;
		default: {
			const exhaustive: never = entry;
			return exhaustive;
		}
	}
}

/**
 * A port that plays a transcript back, in the transcript's order. Each output report must equal the next recorded
 * "out" entry (or match an "out-write" by header and payload hash), and each read gets the next "in" entry. An open
 * waits until the transcript reaches its "opened" entry, because the core asks for the update-mode link before the
 * RESET that makes it appear. A read that finds no "in" next times out, as it did when recorded. The clock is the
 * transcript's: it reads the time of the last entry consumed, and a sleep returns at once.
 * Entries the core does not cause (picks, visibility, typing, preconditions, discarded reports) are skipped.
 */
export function replayPort(transcript: Transcript): ReplayPort {
	const wire = transcript.entries.flatMap((entry, index) => (isWire(entry) ? [{ index, entry }] : []));
	let cursor = 0;
	let now = 0;
	let divergence: ReplayDiverged | null = null;
	const opens: { readonly want: DeviceWant; readonly resolve: (link: Link) => void; readonly reject: (error: unknown) => void }[] = [];
	const peek = () => wire[cursor];
	const take = () => {
		const item = wire[cursor++];
		if (item !== undefined) now = item.entry.t;
		return item;
	};
	const diverge = (got: string): never => {
		const item = peek();
		divergence ??= new ReplayDiverged(item?.index ?? transcript.entries.length, describeEntry(item?.entry), got);
		throw divergence;
	};

	/** Resolves the waiting open, if any, once the transcript reaches an "opened" entry. */
	function settleOpens(): void {
		const item = peek();
		if (item?.entry.kind !== "opened") return;
		const { entry } = item;
		const at = opens.findIndex(({ want }) => want.reason === entry.reason);
		if (at === -1) return;
		const [open] = opens.splice(at, 1);
		if (open === undefined) return;
		const mode = modeOf(entry.productId);
		take();
		if (mode === null || !open.want.modes.includes(mode)) {
			divergence ??= new ReplayDiverged(item.index, describeEntry(entry), `an open for ${open.want.modes.join(" or ")}`);
			open.reject(divergence);
			return;
		}
		open.resolve(new ReplayLink(mode));
	}

	class ReplayLink implements Link {
		#lost = false;
		#settleLost = () => undefined as void;
		readonly lost = new Promise<void>((resolve) => {
			this.#settleLost = resolve;
		});

		constructor(readonly mode: Mode) {}

		/** Consumes a recorded loss of this link wherever it sits next. */
		#noteLoss(): boolean {
			const entry = peek()?.entry;
			if (entry?.kind === "lost" && (entry.mode === undefined || entry.mode === this.mode)) {
				take();
				this.#lost = true;
				this.#settleLost();
			}
			return this.#lost;
		}

		async send(report: OutReport): Promise<void> {
			settleOpens();
			if (this.#noteLoss()) throw new LinkLost("the recorded link was lost");
			const entry = peek()?.entry;
			const hex = hexOf(report);
			if (entry?.kind === "out") {
				if (entry.hex !== hex) diverge(`out ${hex.slice(0, 24)}`);
			} else if (entry?.kind === "out-write") {
				const payloadSha256 = await sha256Hex(report.subarray(4, 4 + report[1]!));
				if (entry.header !== hex.slice(0, 8) || entry.payloadBytes !== report[1] || entry.payloadSha256 !== payloadSha256) diverge(`a WRITE ${hex.slice(0, 8)}`);
			} else diverge(`out ${hex.slice(0, 24)}`);
			take();
			const failed = peek()?.entry;
			if (failed?.kind === "send-failed") {
				take();
				throw new LinkLost(failed.error);
			}
			settleOpens();
		}

		async next(timeoutMs: number): Promise<InReport> {
			if (this.#noteLoss()) throw new LinkLost("the recorded link was lost");
			const entry = peek()?.entry;
			if (entry?.kind !== "in") throw new LinkTimeout(`no recorded reply within ${timeoutMs} ms`);
			take();
			settleOpens();
			return asInReport(fromHex(entry.hex));
		}

		discardPending(): readonly InReport[] {
			return [];
		}

		async close(): Promise<void> {
			this.#noteLoss();
			const entry = peek()?.entry;
			if (entry?.kind !== "closed" || (entry.mode !== undefined && entry.mode !== this.mode)) diverge(`a close of the ${this.mode} link`);
			take();
			settleOpens();
		}
	}

	return {
		open: (want, signal) =>
			new Promise<Link>((resolve, reject) => {
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				opens.push({ want, resolve, reject });
				settleOpens();
			}),
		exclusive: (job) => job(),
		clock: {
			now: () => now,
			sleep: async (_ms, signal) => signal.throwIfAborted(),
		},
		get divergence() {
			return divergence;
		},
		remaining: () => wire.slice(cursor),
	};
}

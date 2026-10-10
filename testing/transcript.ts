/**
 * Recorded sessions with a real board: the golden fixtures behind the fake board and the replay tests, and the
 * capture that moves a G1 row from "reviewed" to "confirmed" (protocol.ts Maturity).
 *
 * A transcript never carries firmware. `recording` refuses a WRITE frame until U7 stores write payloads as their
 * length and SHA-256; replay then compares the hash of what the core sends against the recorded hash, so golden
 * tests stay byte-exact without redistributing vendor bytes.
 */
import type { DevicePort, Link, WantReason } from "../core/port";
import { type Sha256, notImplemented, sha256Literal } from "../core/units";

/** Tool version and commit, OS, browser, and whether Karabiner-Elements was running. */
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
	/** `discarded`: a report that discardPending dropped before a send, so the core never read it. */
	| { readonly t: number; readonly kind: "in" | "discarded"; readonly hex: string }
	/** Follows the `out` entry of a frame whose send rejected. The board may still have received it. */
	| { readonly t: number; readonly kind: "send-failed"; readonly hex: string; readonly error: string }
	/** The shell counted a device.close() that did not settle in time as closed. */
	| { readonly t: number; readonly kind: "close-timeout"; readonly productId: number }
	/** The page's visibility, at its start and on each change: a hidden tab slows timers, which check 9 measures. */
	| { readonly t: number; readonly kind: "visibility"; readonly state: "visible" | "hidden" }
	/** The typing field changed while a normal-mode link was the last one opened: plan check 8's evidence. */
	| { readonly t: number; readonly kind: "typing"; readonly chars: number }
	| { readonly t: number; readonly kind: "lost" | "closed" };

const WRITE_CMD = 0x1f;

export const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export function recording(link: Link, sink: (entry: TranscriptEntry) => void, now: () => number = () => performance.now()): Link {
	void link.lost.then(() => sink({ t: now(), kind: "lost" }));
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
			sink({ t: now(), kind: "closed" });
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
			return { t, kind, productId: number(value, "productId", where) };
		case "visibility": {
			const state = string(value, "state", where);
			if (state !== "visible" && state !== "hidden") fail(where, `unknown visibility ${state}`);
			return { t, kind, state };
		}
		case "typing":
			return { t, kind, chars: number(value, "chars", where) };
		case "lost":
		case "closed":
			return { t, kind };
		case "opened": {
			const collections = value.collections;
			if (!Array.isArray(collections)) fail(where, "collections is not an array");
			return {
				t,
				kind,
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
			const reason = string(value, "reason", where);
			const path = string(value, "path", where);
			const productId = value.productId;
			if (!isWantReason(reason)) fail(where, `unknown reason ${reason}`);
			if (path !== "activation" && path !== "parked") fail(where, `unknown path ${path}`);
			if (productId !== null && typeof productId !== "number") fail(where, "productId is neither null nor a number");
			return { t, kind, reason, path, productId, waitMs: number(value, "waitMs", where) };
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

/**
 * A port that plays a transcript back. TODO: each output report must equal the next recorded "out" entry (or match
 * an "out-write" by header and payload hash); the reply is the next "in" entry. Any divergence throws with the index.
 */
export function replayPort(transcript: Transcript): DevicePort {
	return notImplementedPort(`replayPort(${transcript.entries.length} entries)`);
}

export function notImplementedPort(what: string): DevicePort {
	return {
		open: async () => notImplemented(`${what}.open`),
		exclusive: async () => notImplemented(`${what}.exclusive`),
		clock: { now: () => notImplemented(`${what}.clock.now`), sleep: async () => notImplemented(`${what}.clock.sleep`) },
	};
}

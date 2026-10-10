/**
 * Recorded sessions with a real board: the golden fixtures behind the fake board and the replay tests, and the
 * capture that moves a G1 row from "reviewed" to "confirmed" (protocol.ts Maturity).
 *
 * A transcript never carries firmware. WRITE payloads are stored as their length and SHA-256, by construction in
 * `recording`. Replay compares the hash of what the core sends against the recorded hash, so golden tests stay
 * byte-exact without redistributing vendor bytes.
 */
import type { DevicePort, Link, WantReason } from "../core/port";
import type { Sha256 } from "../core/units";
import { notImplemented } from "../core/units";

export interface Transcript {
	readonly format: "tab60kit-transcript/1";
	readonly recordedAt: string;
	/** Tool version and commit, OS, browser, and whether Karabiner-Elements was running. */
	readonly environment: Readonly<Record<string, string>>;
	readonly entries: readonly TranscriptEntry[];
}

/** One HID collection of an opened device, as the shell saw it. */
export interface CollectionEntry {
	readonly usagePage: number;
	readonly usage: number;
	readonly inputReportBytes: number;
	readonly outputReportBytes: number;
	readonly featureReportBytes: number;
}

export type TranscriptEntry =
	/** One chooser: opened inside the click's activation, or from a parked pick's click. `productId` null means closed empty. */
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
	| { readonly t: number; readonly kind: "in"; readonly hex: string }
	| { readonly t: number; readonly kind: "lost" | "closed" };

const WRITE_CMD = 0x1f;

export const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Wraps a link so every report is appended to `sink`, stamped with `now`. A WRITE frame throws before it reaches
 * the link: U1 cannot send one, and U7 adds the payload hashing that keeps vendor bytes out of transcripts.
 */
export function recording(link: Link, sink: (entry: TranscriptEntry) => void, now: () => number = () => performance.now()): Link {
	void link.lost.then(() => sink({ t: now(), kind: "lost" }));
	return {
		mode: link.mode,
		lost: link.lost,
		async send(report) {
			if (report[0] === WRITE_CMD) throw new Error("recording: WRITE frames are not recordable before U7 hashes their payloads");
			sink({ t: now(), kind: "out", hex: hexOf(report) });
			await link.send(report);
		},
		async next(timeoutMs) {
			const reply = await link.next(timeoutMs);
			sink({ t: now(), kind: "in", hex: hexOf(reply) });
			return reply;
		},
		discardPending: () => link.discardPending(),
		async close() {
			await link.close();
			sink({ t: now(), kind: "closed" });
		},
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const REPORT_HEX = /^[0-9a-f]{128}$/;
const WANT_REASONS: readonly WantReason[] = ["connect", "enter-update-mode", "after-link-loss", "confirm-normal-mode"];

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
		case "in": {
			const hex = string(value, "hex", where);
			if (!REPORT_HEX.test(hex)) fail(where, "hex is not 64 bytes");
			return { t, kind, hex };
		}
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
			if (!WANT_REASONS.some((known) => known === reason)) fail(where, `unknown reason ${reason}`);
			if (path !== "activation" && path !== "parked") fail(where, `unknown path ${path}`);
			if (productId !== null && typeof productId !== "number") fail(where, "productId is neither null nor a number");
			return { t, kind, reason: reason as WantReason, path, productId, waitMs: number(value, "waitMs", where) };
		}
		case "out-write":
			return {
				t,
				kind,
				header: string(value, "header", where),
				payloadBytes: number(value, "payloadBytes", where),
				payloadSha256: string(value, "payloadSha256", where) as Sha256,
			};
		default:
			return fail(where, `unknown kind ${kind}`);
	}
}

/** The boundary for a transcript file: JSON in, a typed Transcript out, or a TypeError naming the first problem. */
export function parseTranscript(json: unknown): Transcript {
	if (!isRecord(json)) fail("root", "not an object");
	if (json.format !== "tab60kit-transcript/1") fail("root", `format is ${String(json.format)}`);
	const recordedAt = string(json, "recordedAt", "root");
	const environment = json.environment;
	if (!isRecord(environment) || !Object.values(environment).every((v) => typeof v === "string")) fail("root", "environment is not a string map");
	if (!Array.isArray(json.entries)) fail("root", "entries is not an array");
	return {
		format: "tab60kit-transcript/1",
		recordedAt,
		environment: environment as Record<string, string>,
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
